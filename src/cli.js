#!/usr/bin/env node
// agentguard —— Agent 行为的回归测试 + 上线卡点
// 一份 YAML 规则，同时管 CI 测试（check）和线上护栏（guard）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRules, ruleToYaml } from './rule.js';
import { loadTrace, parseTrace } from './trace.js';
import { evaluateTraceForCi } from './engine.js';
import { learnCandidates } from './learn.js';
import { exportToPromptfoo } from './exportPromptfoo.js';
import { runGuard } from './guard.js';

const PKG_VERSION = '0.1.0';

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (a === '-h') {
      flags.help = true; // 单横线 -h 也要认，否则子命令求助会变成位置参数
      continue;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let value;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[++i];
      } else {
        value = true;
      }
      // --flag=false 是用户明确的否定，不能当真值字符串处理
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      flags[key] = value;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const USAGE = `agentguard v${PKG_VERSION} —— 一份规则，同时管 CI 测试和线上护栏

用法:
  agentguard init
      一键脚手架：生成示例规则（agentguard-rules/）与示例事故 trace（traces/），已有文件不覆盖
  agentguard check   --trace <file|dir> [--rules <dir|file>] [--json] [--strict]
      CI 卡点：评估 trace 是否违反规则，有违规退出码 1（--trace 可给目录，递归检查全部 .json；
      --strict 下规则名冲突视为错误——多团队共治规则库时用）
  agentguard learn   --trace <file> [--rules-dir <dir>] [--threshold 0.7] [--apply] [--ci|--runtime] [--json]
      从事故 trace 生成候选规则（预览模式；--apply 才写入）
  agentguard export  --to promptfoo --rules <dir|file> [--out <file>]
      翻译成 promptfoo 原生断言；翻不过去的逐条明说
  agentguard guard   --rules <dir|file> --upstream "<启动上游 MCP server 的命令>" [--audit <file>]
      运行时护栏：MCP stdio 透明代理，逐调用拦截（审计日志默认 agentguard-audit.jsonl）

示例:
  agentguard init
  agentguard check --rules agentguard-rules --trace traces
  agentguard learn --trace examples/traces/refund_incident.json --apply
  agentguard guard --rules agentguard-rules --upstream "node my-mcp-server.js"

每个子命令都支持 --help 查看说明。
`;

function die(msg, code = 2) {
  console.error(`错误: ${msg}`);
  process.exit(code);
}

/** 拼错的参数名给警告而不是静默忽略（--rulez 之类的手误） */
const KNOWN_FLAGS = {
  init: new Set([]),
  check: new Set(['trace', 'rules', 'json', 'strict']),
  learn: new Set(['trace', 'rules-dir', 'threshold', 'apply', 'ci', 'runtime', 'json']),
  export: new Set(['to', 'rules', 'out']),
  guard: new Set(['rules', 'upstream', 'audit']),
};
// 每个子命令都认 --help/-h：用户求助时给帮助，而不是报错
function helpRequested(flags) {
  if (flags.help || flags.h) {
    console.log(USAGE);
    process.exit(0);
  }
}
function warnUnknownFlags(cmd, flags) {
  for (const k of Object.keys(flags)) {
    if (!KNOWN_FLAGS[cmd].has(k)) console.error(`警告: 未识别的参数 --${k}（已忽略）`);
  }
}

function safeLoadRules(rulesPath) {
  try {
    return loadRules(rulesPath);
  } catch (err) {
    die(`加载规则失败：${err.message}`);
  }
}

function safeLoadTrace(tracePath) {
  try {
    return loadTrace(tracePath);
  } catch (err) {
    die(`加载 trace 失败：${err.message}`);
  }
}

/** 递归收集目录下全部 .json（与规则目录同策略：真实归档按日期/服务分子目录） */
function collectJsonFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsonFiles(full));
    else if (entry.isFile() && /\.json$/i.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * 解析 --trace：<file> 或目录（目录时递归收集其中全部 .json，适配 CI 里检查整个 trace 归档）。
 */
function loadTraces(tracePath) {
  let files;
  try {
    const st = fs.statSync(tracePath);
    if (st.isDirectory()) {
      files = collectJsonFiles(tracePath).sort();
      if (files.length === 0) die(`trace 目录里没有 .json 文件：${tracePath}`);
    } else {
      files = [tracePath];
    }
  } catch (err) {
    die(`无法读取 trace 路径 ${tracePath}：${err.message}`);
  }
  return files.map((f) => safeLoadTrace(f));
}

function resolveRulesPath(flags) {
  const p = typeof flags.rules === 'string' ? flags.rules : null;
  if (p) return p;
  const def = path.resolve('agentguard-rules');
  if (fs.existsSync(def)) return def;
  die('未指定 --rules，且当前目录没有 ./agentguard-rules 目录（可先运行 learn --apply 生成）');
}

// ---------- init ----------
const INIT_RULE_YAML = `# 示例：用户只是问物流时，绝不能退款。
# 同一份文件同时是 CI 断言（agentguard check）和线上护栏（agentguard guard）—— where 是唯一开关。
rule: example-refund-safety
description: 只读意图（到货/物流/订单）会话中禁止退款，只允许查询类工具；同一订单不许重复退款
when:
  intent_any: ["到货", "物流", "订单", "status"]
then:
  forbid_tool: refund_order
  allow_tool: [query_order, get_logistics]
  idempotent:
    tool: refund_order
    key: "\${order_id}"
    on_violation: block
where:
  ci: true
  runtime: true
`;

const INIT_TRACE_JSON = `{
  "trace_version": 1,
  "name": "example-incident",
  "description": "示例事故：用户只问了物流，Agent 给人退了款，而且退了两次",
  "sessions": [
    {
      "id": "chat-001",
      "events": [
        { "type": "user", "text": "我的订单 A1001 到货了吗？物流怎么还没更新" },
        { "type": "assistant", "text": "正在为您查询订单 A1001 的物流信息。" },
        { "type": "tool_call", "id": "c1", "tool": "query_order", "args": { "order_id": "A1001" } },
        { "type": "tool_result", "call_id": "c1", "ok": true, "text": "已发货，运输中" },
        { "type": "tool_call", "id": "c2", "tool": "refund_order", "args": { "order_id": "A1001", "amount": 199.0 } },
        { "type": "tool_result", "call_id": "c2", "ok": true, "text": "退款成功" },
        { "type": "tool_call", "id": "c3", "tool": "refund_order", "args": { "order_id": "A1001", "amount": 199.0 } },
        { "type": "tool_result", "call_id": "c3", "ok": true, "text": "退款成功（重复执行）" },
        { "type": "assistant", "text": "已为您处理完毕。" }
      ]
    }
  ]
}
`;

function cmdInit() {
  const targets = [
    { file: path.resolve('agentguard-rules', 'example-refund-safety.yaml'), content: INIT_RULE_YAML },
    { file: path.resolve('traces', 'example-incident.json'), content: INIT_TRACE_JSON },
  ];
  console.log('agentguard init —— 生成示例规则与示例事故 trace');
  for (const t of targets) {
    if (fs.existsSync(t.file)) {
      console.log(`  - 跳过（已存在，不覆盖）：${path.relative('.', t.file)}`);
      continue;
    }
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, t.content, 'utf8');
    console.log(`  + 已生成：${path.relative('.', t.file)}`);
  }
  console.log(`
下一步:
  1. agentguard check --rules agentguard-rules --trace traces
     （应看到示例事故被抓，退出码 1 —— CI 卡点就长这样）
  2. node demo-guard.mjs
     （60 秒看同一份规则在线上拦住重复退款）
  3. 把你的真实事故 trace 放进 traces/，用 learn 长出你自己的规则：
     agentguard learn --trace traces/你的事故.json --apply
`);
  process.exit(0);
}

// ---------- check ----------
function cmdCheck({ flags }) {
  helpRequested(flags);
  warnUnknownFlags('check', flags);
  if (typeof flags.trace !== 'string') die('check 需要 --trace <file|dir>（没有 trace？先运行 agentguard init 生成示例）');
  const rulesPath = resolveRulesPath(flags);
  const { rules, warnings } = safeLoadRules(rulesPath);
  for (const w of warnings) console.error(`警告: ${w}`);

  // 多团队共治时规则名冲突是治理问题：--strict 下直接拒绝运行
  const nameCount = new Map();
  for (const r of rules) nameCount.set(r.rule, (nameCount.get(r.rule) || 0) + 1);
  const dupNames = [...nameCount.entries()].filter(([, c]) => c > 1).map(([n]) => n);
  if (flags.strict && dupNames.length) {
    die(`--strict：发现重复规则名：${dupNames.join('、')}（多团队共治时通常意味着规则冲突，先解决再进 CI）`);
  }

  if (rules.length > 0 && !rules.some((r) => r.where.ci)) {
    console.error('警告: 所有规则的 where.ci 都是 false —— 本次检查没有任何规则生效（护栏空转）');
  }
  const traces = loadTraces(flags.trace);

  const allViolations = [];
  const skippedRules = rules.filter((r) => !r.where.ci).map((r) => ({ rule: r.rule, reason: 'where.ci = false' }));
  const perTrace = [];
  for (const trace of traces) {
    const { violations } = evaluateTraceForCi(rules, trace);
    allViolations.push(...violations.map((v) => ({ file: trace.sourceFile, ...v })));
    perTrace.push({ name: trace.name, file: trace.sourceFile, sessions: trace.sessions.length, violations: violations.length });
  }

  // 拼写错误 lint：规则引用的工具从未在任何 trace 中出现 → 这条规则从未生效过
  if (rules.length > 0 && traces.length > 0) {
    const seen = new Set();
    for (const t of traces) {
      for (const s of t.sessions) {
        for (const e of s.events) {
          if (e.type === 'tool_call') seen.add(e.tool);
        }
      }
    }
    const referenced = new Set();
    for (const r of rules) {
      for (const k of ['forbid_tool', 'allow_tool', 'require_tool']) {
        if (r.then[k]) r.then[k].forEach((tool) => referenced.add(tool));
      }
      if (r.then.idempotent) r.then.idempotent.forEach((e) => referenced.add(e.tool));
    }
    const unseen = [...referenced].filter((tool) => !seen.has(tool));
    if (unseen.length) {
      console.error(`提示: 工具 [${unseen.join(', ')}] 出现在规则里但从未在任何 trace 中被调用过 —— 如果是拼写错误，这条规则从未生效过（假安全）`);
    }
  }

  if (flags.json) {
    const report = {
      traces: perTrace,
      rules: rules.length,
      violations: allViolations,
      skippedRules,
      summary: { violations: allViolations.length, passed: allViolations.length === 0 },
    };
    if (traces.length === 1) {
      report.trace = { name: traces[0].name, file: traces[0].sourceFile };
    }
    console.log(JSON.stringify(report, null, 2));
  } else {
    const shortArgs = (o) => {
      try {
        const s = JSON.stringify(o);
        return s.length > 80 ? s.slice(0, 77) + '…' : s;
      } catch {
        return '';
      }
    };
    for (const t of perTrace) {
      console.log(`agentguard check — trace「${t.name}」（${t.sessions} 个 session）× 规则 ${rules.length} 条`);
      const vs = allViolations.filter((v) => v.file === t.file);
      for (const v of vs) {
        const preview = v.evidence && v.evidence.args !== undefined ? ` ${shortArgs(v.evidence.args)}` : '';
        console.log(`  ✗ [${v.rule}] session ${v.session} turn ${v.turn} — ${v.assertion}: ${v.message}${preview}`);
      }
      if (traces.length === 1) {
        for (const s of skippedRules) console.log(`  - 跳过规则「${s.rule}」（${s.reason}）`);
      }
      console.log(
        vs.length === 0
          ? `  ✓ 全部通过：${rules.length} 条规则 × ${t.sessions} 个 session，无违规`
          : `  共 ${vs.length} 个违规`
      );
    }
    if (traces.length > 1) console.log(`  （共 ${traces.length} 份 trace）`);
    console.log(
      allViolations.length === 0
        ? `  ✓ 无违规 → 退出码 0`
        : `  有违规 → 退出码 1（合并前请修复或修订规则；加 --json 可拿到含完整参数证据的结构化报告）`
    );
  }
  process.exit(allViolations.length === 0 ? 0 : 1);
}

// ---------- learn ----------
function cmdLearn({ flags }) {
  helpRequested(flags);
  warnUnknownFlags('learn', flags);
  if (typeof flags.trace !== 'string') die('learn 需要 --trace <file>');
  const rulesDir = typeof flags['rules-dir'] === 'string' ? flags['rules-dir'] : path.resolve('agentguard-rules');
  const threshold = Number(flags.threshold ?? 0.7);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) die('--threshold 必须在 (0, 1] 之间');
  const trace = safeLoadTrace(flags.trace);

  const where = flags.runtime ? { ci: false, runtime: true } : flags.ci ? { ci: true, runtime: false } : { ci: true, runtime: true };
  const candidates = learnCandidates(trace, { threshold }).map((c) => ({ ...c, rule: { ...c.rule, where } }));

  // --json 模式下 stdout 保持机器可读，进度类输出一律走 stderr
  const out = flags.json ? (...a) => console.error(...a) : (...a) => console.log(...a);

  if (flags.json) {
    console.log(JSON.stringify({ trace: trace.name, threshold, applied: !!flags.apply, candidates }, null, 2));
    if (!flags.apply) process.exit(0);
  } else {
    for (const c of candidates) {
      console.log(`  [${Math.round(c.confidence * 100)}%] ${c.name} — ${c.reason}`);
      for (const e of c.evidence) console.log(`        · ${e}`);
    }
    if (candidates.length === 0) {
      console.log('  没有达到阈值的候选（这份 trace 里没发现典型事故模式）');
    }
    console.log(`  预览模式：${candidates.length} 条候选达到阈值（阈值 ${threshold}）。确认无误后加 --apply 写入 ${rulesDir}`);
  }

  if (!flags.apply) process.exit(0);

  try {
    fs.mkdirSync(rulesDir, { recursive: true });
  } catch (err) {
    die(`无法创建规则目录 ${rulesDir}：${err.message}`);
  }
  let written = 0;
  for (const c of candidates) {
    const file = path.join(rulesDir, `${c.name}.yaml`);
    if (fs.existsSync(file)) {
      out(`  - 跳过（已存在，不覆盖）：${file}`);
      continue;
    }
    fs.writeFileSync(file, ruleToYaml(c.rule), 'utf8');
    out(`  + 已写入：${file}`);
    written++;
  }
  out(`  完成：新增 ${written} 条规则。运行 agentguard check --rules "${rulesDir}" --trace "${flags.trace}" 验证。`);
  process.exit(0);
}

// ---------- export ----------
function cmdExport({ flags }) {
  helpRequested(flags);
  warnUnknownFlags('export', flags);
  if (flags.to !== 'promptfoo') die('export 目前只支持 --to promptfoo');
  const rulesPath = resolveRulesPath(flags);
  const { rules, warnings } = safeLoadRules(rulesPath);
  for (const w of warnings) console.error(`警告: ${w}`);
  const { yamlText, exported, unsupported, manual } = exportToPromptfoo(rules);

  console.log(`agentguard export → promptfoo`);
  if (exported.length) {
    console.log(`  已翻译 ${exported.length} 条断言 → defaultTest.assert：`);
    for (const e of exported) console.log(`    ✓ [${e.rule}] ${e.assertion} → ${e.target}`);
  } else {
    console.log('  没有可自动翻译的无条件规则');
  }
  if (unsupported.length) {
    console.log('  翻不过去的（逐条明说，不生成假配置）：');
    for (const u of unsupported) console.log(`    ✗ [${u.rule}] ${u.assertion} —— ${u.reason}`);
  }
  if (manual.length) {
    console.log('  需人工挂载（when.intent_any 条件断言）：');
    for (const m of manual) console.log(`    ? [${m.rule}] ${m.assertion} —— ${m.reason}`);
  }
  const outFile = typeof flags.out === 'string' ? flags.out : 'agentguard-promptfoo.yaml';
  try {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, yamlText, 'utf8');
  } catch (err) {
    die(`写入导出文件失败 ${outFile}：${err.message}`);
  }
  console.log(`  已写入 ${outFile}`);
  process.exit(0);
}

// ---------- guard ----------
function cmdGuard({ flags, positional }) {
  helpRequested(flags);
  warnUnknownFlags('guard', flags);
  const rulesPath = resolveRulesPath(flags);
  let upstream;
  if (typeof flags.upstream === 'string') upstream = flags.upstream;
  else if (positional.length) upstream = positional.join(' ');
  else die('guard 需要 --upstream "<启动上游 MCP server 的命令>"（没有现成 MCP server？在项目根目录运行 node demo-guard.mjs 看完整演示）');
  const auditFile = typeof flags.audit === 'string' ? flags.audit : 'agentguard-audit.jsonl';

  runGuard({
    rulesPath,
    upstream,
    auditFile,
    onWarn: (msg) => console.error(msg),
  });
  // guard 常驻，直到 stdin 结束或上游退出
}

// ---------- 入口 ----------
function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case 'init':
      return cmdInit();
    case 'check':
      return cmdCheck({ flags });
    case 'learn':
      return cmdLearn({ flags });
    case 'export':
      return cmdExport({ flags });
    case 'guard':
      return cmdGuard({ flags, positional });
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(USAGE);
      return process.exit(0);
    case 'version':
    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      return process.exit(0);
    default:
      console.error(USAGE);
      return die(`未知命令 "${cmd}"`);
  }
}

// 供测试导入的额外辅助（不触发 main）
export const __internals = { parseArgs, parseTrace };

main();
