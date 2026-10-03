// 规则（YAML）加载与校验
// 规则 schema：
//   rule: <name>                       必填，唯一
//   description: <str>                 可选
//   when:                              可选；CI 按 session 匹配，runtime 见 guard 说明
//     intent_any: ["物流", "订单"]      —— 任一子串出现在用户消息（大小写不敏感）
//   then:                              必填，至少一个断言
//     forbid_tool: <str | str[]>       禁止调用的工具
//     allow_tool: <str[]>              白名单之外一律违规
//     require_tool: <str | str[]>      必须调用过其中之一（仅 CI 有意义）
//     max_tool_calls: <int>            session 内工具调用总数上限
//     idempotent:                      同一事务键不许重复调用
//       - tool: refund_order
//         key: "${order_id}"
//         on_violation: block|log      默认 block（runtime 生效）
//   where:                             缺省两个出口都生效
//     ci: true
//     runtime: true

import fs from 'node:fs';
import path from 'node:path';
import { parseAllDocuments, stringify } from 'yaml';
import { toList } from './util.js';

export function normalizeWhere(where) {
  const w = where && typeof where === 'object' ? where : {};
  return { ci: w.ci !== false, runtime: w.runtime !== false };
}

/** 校验并归一化单条规则（对象形式）。有问题抛 Error。 */
export function normalizeRule(obj, sourceFile = '<memory>') {
  if (!obj || typeof obj !== 'object') throw new Error(`${sourceFile}: 规则必须是映射`);
  if (typeof obj.rule !== 'string' || !obj.rule.trim()) {
    throw new Error(`${sourceFile}: 缺少必填字段 rule（规则名）`);
  }
  const then = obj.then;
  if (!then || typeof then !== 'object') {
    throw new Error(`${sourceFile}: 缺少必填字段 then（至少要有一个断言）`);
  }

  const whenRaw = obj.when && typeof obj.when === 'object' ? obj.when : {};
  const thenOut = {};
  const warnings = [];

  if ('forbid_tool' in then) thenOut.forbid_tool = toList(then.forbid_tool);
  if ('allow_tool' in then) thenOut.allow_tool = toList(then.allow_tool);
  if ('require_tool' in then) thenOut.require_tool = toList(then.require_tool);
  if ('max_tool_calls' in then) {
    if (!Number.isInteger(then.max_tool_calls) || then.max_tool_calls < 1) {
      throw new Error(`${sourceFile}: max_tool_calls 必须是正整数`);
    }
    thenOut.max_tool_calls = then.max_tool_calls;
  }
  if ('idempotent' in then) {
    const list = Array.isArray(then.idempotent) ? then.idempotent : [then.idempotent];
    thenOut.idempotent = list.map((e, i) => {
      if (!e || typeof e !== 'object' || typeof e.tool !== 'string') {
        throw new Error(`${sourceFile}: idempotent[${i}] 缺少 tool 字段`);
      }
      return {
        tool: e.tool,
        key: typeof e.key === 'string' ? e.key : '${__args__}',
        on_violation: e.on_violation === 'log' ? 'log' : 'block',
      };
    });
  }

  if (Object.keys(thenOut).length === 0) {
    throw new Error(
      `${sourceFile}: then 里没有任何可识别的断言（支持 forbid_tool / allow_tool / require_tool / max_tool_calls / idempotent）`
    );
  }

  // allow 与 forbid 交集告警（语义矛盾：白名单内又禁止）
  if (thenOut.allow_tool && thenOut.forbid_tool) {
    const overlap = thenOut.allow_tool.filter((t) => thenOut.forbid_tool.includes(t));
    if (overlap.length) warnings.push(`${sourceFile}: 工具 ${overlap.join(', ')} 同时出现在 allow_tool 与 forbid_tool 中，forbid 优先`);
  }

  // 未知键提醒
  const knownThen = new Set(['forbid_tool', 'allow_tool', 'require_tool', 'max_tool_calls', 'idempotent']);
  for (const k of Object.keys(then)) {
    if (!knownThen.has(k)) warnings.push(`${sourceFile}: then.${k} 不是可识别的断言，已忽略`);
  }
  const knownWhen = new Set(['intent_any']);
  for (const k of Object.keys(whenRaw)) {
    if (!knownWhen.has(k)) warnings.push(`${sourceFile}: when.${k} 不是可识别的条件，已忽略`);
  }

  return {
    rule: obj.rule.trim(),
    description: typeof obj.description === 'string' ? obj.description : undefined,
    when: {
      intent_any: toList(whenRaw.intent_any).map((s) => s.toLowerCase()),
    },
    then: thenOut,
    where: normalizeWhere(obj.where),
    sourceFile,
  };
}

/** 加载规则 YAML 文本：支持单文档、多文档（--- 分隔）、YAML 序列（规则数组） */
export function parseRuleYaml(text, sourceFile = '<memory>') {
  const docs = parseAllDocuments(text)
    .map((d) => d.toJS())
    .filter((v) => v !== undefined && v !== null);
  if (docs.length === 0) throw new Error(`${sourceFile}: 空的规则文件`);
  if (docs.length === 1 && Array.isArray(docs[0])) {
    if (docs[0].length === 0) throw new Error(`${sourceFile}: 规则数组为空`);
    return { rules: docs[0].map((r) => normalizeRule(r, sourceFile)), warnings: [] };
  }
  const warnings = [];
  const rules = docs.map((r) => {
    const res = normalizeRule(r, sourceFile);
    return res;
  });
  return { rules, warnings };
}

/** 收集目录下全部 *.yaml/*.yml（手动递归：readdirSync 的 recursive 选项 Node 18.17 才有，18.16 会静默漏掉子目录） */
function collectYamlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectYamlFiles(full));
    else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/** 加载规则来源：目录（递归收集 *.yaml/*.yml）或单文件 */
export function loadRules(rulesPath) {
  const st = fs.statSync(rulesPath);
  const warnings = [];
  let files = [];
  if (st.isDirectory()) {
    files = collectYamlFiles(rulesPath);
  } else if (st.isFile()) {
    files = [rulesPath];
  } else {
    throw new Error(`规则路径不是文件或目录：${rulesPath}`);
  }
  if (files.length === 0) throw new Error(`规则目录里没有 .yaml/.yml 文件：${rulesPath}`);
  const rules = [];
  for (const f of files) {
    const { rules: rs, warnings: ws } = parseRuleYaml(fs.readFileSync(f, 'utf8'), f);
    rules.push(...rs);
    warnings.push(...ws);
  }
  // 规则名查重
  const seen = new Map();
  for (const r of rules) {
    if (seen.has(r.rule)) warnings.push(`规则名重复：「${r.rule}」（${seen.get(r.rule)} 与 ${r.sourceFile}），后加载的生效判定都会带上来源`);
    else seen.set(r.rule, r.sourceFile);
  }
  return { rules, warnings };
}

/** 把内存中的规则对象写成 YAML 文本（learn --apply / 导出用） */
export function ruleToYaml(rule) {
  const out = { rule: rule.rule };
  if (rule.description) out.description = rule.description;
  const whenAny = rule.when?.intent_any ?? [];
  if (whenAny.length) out.when = { intent_any: whenAny };
  out.then = {};
  const t = rule.then;
  if (t.forbid_tool) out.then.forbid_tool = t.forbid_tool.length === 1 ? t.forbid_tool[0] : t.forbid_tool;
  if (t.allow_tool) out.then.allow_tool = t.allow_tool;
  if (t.require_tool) out.then.require_tool = t.require_tool.length === 1 ? t.require_tool[0] : t.require_tool;
  if (t.max_tool_calls !== undefined) out.then.max_tool_calls = t.max_tool_calls;
  if (t.idempotent) {
    const list = t.idempotent.map((e) => ({ tool: e.tool, key: e.key, on_violation: e.on_violation }));
    out.then.idempotent = list.length === 1 ? list[0] : list;
  }
  out.where = { ci: rule.where.ci, runtime: rule.where.runtime };
  return stringify(out);
}
