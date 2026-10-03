// export --to promptfoo：翻译层，不抢地盘。
// 原则：翻得过去的生成原生配置；翻不过去的逐条明说，绝不生成看起来对、实际不触发的配置。
//
// 翻译能力对照（以 promptfoo 当前的 trajectory 断言为准，使用前请对照官方文档核对类型名）：
//   forbid_tool     → not-trajectory:tool-used     ✅（含 when 条件时无法自动挂载，转人工说明）
//   require_tool    → trajectory:tool-used          ✅ 仅单工具（多工具是 any-of 语义，拆成多条会变成 all-of，语义反转 → 转人工）
//   max_tool_calls  → trajectory:max-tool-calls     ✅
//   allow_tool      → 无白名单原语                  ❌
//   idempotent      → 需业务事务键语义               ❌
//   when.intent_any → promptfoo 断言挂在 test 上，无法表达"用户意图命中才断言" → 该规则转人工

import { ruleToYaml } from './rule.js';
import { stringify } from 'yaml';

export function exportToPromptfoo(rules) {
  const exported = [];
  const unsupported = [];
  const manual = [];
  const defaultAssert = [];

  for (const rule of rules) {
    const t = rule.then;
    const conditional = rule.when.intent_any.length > 0;

    if (t.forbid_tool) {
      if (conditional) {
        manual.push({ rule: rule.rule, assertion: 'forbid_tool', reason: `when.intent_any 在 promptfoo 中无法表达（命中词：${rule.when.intent_any.join(', ')}），请把断言挂到对应意图的测试用例上` });
      } else {
        for (const tool of t.forbid_tool) {
          defaultAssert.push({ type: 'not-trajectory:tool-used', value: tool });
          exported.push({ rule: rule.rule, assertion: 'forbid_tool', target: `not-trajectory:tool-used → ${tool}` });
        }
      }
    }
    if (t.require_tool) {
      if (conditional) {
        manual.push({ rule: rule.rule, assertion: 'require_tool', reason: 'when.intent_any 条件断言，见上' });
      } else if (t.require_tool.length === 1) {
        defaultAssert.push({ type: 'trajectory:tool-used', value: t.require_tool[0] });
        exported.push({ rule: rule.rule, assertion: 'require_tool', target: `trajectory:tool-used → ${t.require_tool[0]}` });
      } else {
        manual.push({
          rule: rule.rule,
          assertion: 'require_tool',
          reason: `require_tool 是 any-of 语义（至少调过 ${t.require_tool.join(' / ')} 之一），拆成多条 trajectory:tool-used 断言会变成 all-of，语义反转 → 请用 promptfoo 的 javascript/python 断言自写，或保留在 agentguard check`,
        });
      }
    }
    if (t.max_tool_calls !== undefined) {
      if (conditional) {
        manual.push({ rule: rule.rule, assertion: 'max_tool_calls', reason: 'when.intent_any 条件断言，见上' });
      } else {
        defaultAssert.push({ type: 'trajectory:max-tool-calls', value: t.max_tool_calls });
        exported.push({ rule: rule.rule, assertion: 'max_tool_calls', target: `trajectory:max-tool-calls → ${t.max_tool_calls}` });
      }
    }
    if (t.allow_tool) {
      unsupported.push({ rule: rule.rule, assertion: 'allow_tool', reason: 'promptfoo 没有白名单原语（只能断言"用过某工具"，无法断言"只用这些工具"）→ 保留在 agentguard check，或用 guard 做运行时白名单' });
    }
    if (t.idempotent) {
      unsupported.push({ rule: rule.rule, assertion: 'idempotent', reason: '需要业务事务键语义（哪个参数标识一笔事务），通用 eval 框架够不着 → 用 agentguard check / guard' });
    }
  }

  const header = [
    '# 本文件由 agentguard export --to promptfoo 生成。',
    '# 无条件规则已翻译为 defaultTest.assert（作用于所有测试用例）。',
    '# 使用前请对照 promptfoo 官方文档核对 trajectory 断言类型名。',
  ].join('\n');

  let yamlText = header + '\n';
  if (defaultAssert.length) {
    yamlText += '\n' + stringify({ defaultTest: { assert: defaultAssert } });
  } else {
    yamlText += '\n# （没有可自动翻译的无条件规则）\n';
  }

  if (manual.length) {
    yamlText += '\n# ---- 有 when.intent_any 条件的规则，无法自动挂载，请人工处理 ----\n';
    for (const m of manual) {
      yamlText += `#   [${m.rule}] ${m.assertion}：${m.reason}\n`;
    }
    yamlText += '\n# ---- 对应规则原文（可改后手工挂载）----\n';
    for (const r of rules) {
      if (r.when.intent_any.length && (r.then.forbid_tool || r.then.require_tool || r.then.max_tool_calls !== undefined)) {
        yamlText += '#\n' + ruleToYaml(r).split('\n').map((l) => '# ' + l).join('\n') + '\n';
      }
    }
  }

  return { yamlText, exported, unsupported, manual };
}
