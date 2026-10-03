// 确定性断言引擎。刻意不用 LLM 当裁判 —— 会误报的门禁，一周内就会被团队关掉。
//
// CI 语义：规则 × session 逐条评估，产出 violations（findings）。
// runtime 语义（guard 用）：单次 tool_call 即时判定 + 会话级幂等/计数状态，见 guard.js。

import { normalizeArgs, resolveKeyTemplate } from './util.js';
import { userTexts } from './trace.js';

/** session 是否命中 when 条件（intent_any：任一子串出现在任一用户消息中） */
export function sessionMatchesWhen(session, when) {
  if (!when || !when.intent_any || when.intent_any.length === 0) return true;
  const texts = userTexts(session);
  return when.intent_any.some((kw) => texts.some((t) => t.includes(kw.toLowerCase())));
}

function finding(rule, session, assertion, extra = {}) {
  return {
    rule: rule.rule,
    ruleSource: rule.sourceFile,
    session: session.id,
    assertion,
    ...extra,
  };
}

/**
 * 在 CI 语义下评估一条规则对一个 session。
 * 返回 violations 数组（无违规则空）。
 * require_tool 只在 CI 评估（runtime 无"整个会话结束"时机，guard 会忽略并告警）。
 */
export function evaluateRuleOnSession(rule, session) {
  const out = [];
  const t = rule.then;

  if (!sessionMatchesWhen(session, rule.when)) return out;

  const toolCalls = session.events.filter((e) => e.type === 'tool_call');

  // forbid_tool：调了不该调的
  if (t.forbid_tool) {
    for (const call of toolCalls) {
      if (t.forbid_tool.includes(call.tool)) {
        out.push(
          finding(rule, session, 'forbid_tool', {
            turn: call.turn,
            tool: call.tool,
            message: `调用了被禁止的工具 ${call.tool}`,
            evidence: { args: normalizeArgs(call.args) },
          })
        );
      }
    }
  }

  // allow_tool：调了白名单之外的
  if (t.allow_tool) {
    for (const call of toolCalls) {
      if (!t.allow_tool.includes(call.tool)) {
        out.push(
          finding(rule, session, 'allow_tool', {
            turn: call.turn,
            tool: call.tool,
            message: `调用了白名单（${t.allow_tool.join(', ')}）之外的工具 ${call.tool}`,
            evidence: { args: normalizeArgs(call.args) },
          })
        );
      }
    }
  }

  // require_tool：该调的没调（session 结束时判定）
  if (t.require_tool) {
    const called = new Set(toolCalls.map((c) => c.tool));
    const missing = t.require_tool.filter((tool) => !called.has(tool));
    if (missing.length === t.require_tool.length) {
      // 全部缺失才违规（语义：至少调过其中之一）
      out.push(
        finding(rule, session, 'require_tool', {
          turn: Math.max(1, session.events.length),
          tool: missing.join(' / '),
          message: `要求的工具一个都没被调用：${missing.join(', ')}`,
        })
      );
    }
  }

  // max_tool_calls：疑似无限循环
  if (t.max_tool_calls !== undefined && toolCalls.length > t.max_tool_calls) {
    out.push(
      finding(rule, session, 'max_tool_calls', {
        turn: session.events.length,
        message: `工具调用了 ${toolCalls.length} 次，超过上限 ${t.max_tool_calls}（疑似循环）`,
      })
    );
  }

  // idempotent：同一事务键不许重复执行
  if (t.idempotent) {
    for (const entry of t.idempotent) {
      const seen = new Map(); // keyValue -> { turn, args }
      for (const call of toolCalls) {
        if (call.tool !== entry.tool) continue;
        const kv = entry.key === '${__args__}' ? JSON.stringify(normalizeArgs(call.args)) : resolveKeyTemplate(entry.key, call.args);
        if (seen.has(kv)) {
          const first = seen.get(kv);
          out.push(
            finding(rule, session, 'idempotent', {
              turn: call.turn,
              tool: call.tool,
              message: `${call.tool} 重复执行：${entry.key}=${kv} 已在 turn ${first.turn} 调用过`,
              evidence: { key: entry.key, keyValue: kv, firstTurn: first.turn },
            })
          );
        } else {
          seen.set(kv, { turn: call.turn, args: call.args });
        }
      }
    }
  }

  return out;
}

/**
 * 评估整个 trace（CI 出口）。
 * 返回 { violations, skippedRules }：
 *   violations  —— 所有违规
 *   skippedRules —— 因 where.ci=false 等原因未参与评估的规则及原因
 */
export function evaluateTraceForCi(rules, trace) {
  const violations = [];
  const skippedRules = [];
  for (const rule of rules) {
    if (!rule.where.ci) {
      skippedRules.push({ rule: rule.rule, reason: 'where.ci = false' });
      continue;
    }
    for (const session of trace.sessions) {
      violations.push(...evaluateRuleOnSession(rule, session));
    }
  }
  return { violations, skippedRules };
}

/**
 * runtime 单次调用判定（guard 用）。
 * state 是 guard 进程级会话状态：{ toolCallCounts: Map, idempotentSeen: Map<`${entryIndex}:${kv}`, turn> }
 * intentHint：调用方通过 params._meta.agentguard.intent 提供的意图提示（字符串或数组）。
 * 返回 null 表示放行；否则返回 { rule, assertion, message, evidence }。
 * 只报第一条命中的违规（先到先拦）。
 */
export function evaluateCallAtRuntime(rule, tool, args, state, intentHint) {
  if (!rule.where.runtime) return null;

  // when 条件：runtime 看不到用户消息，只能依赖调用方注入的 intent 提示
  if (rule.when.intent_any.length > 0) {
    if (intentHint === undefined) return null; // 由 guard 负责一次性告警
    const hints = (Array.isArray(intentHint) ? intentHint : [intentHint]).map((s) => String(s).toLowerCase());
    const hit = rule.when.intent_any.some((kw) => hints.some((h) => h.includes(kw)));
    if (!hit) return null;
  }

  const t = rule.then;

  if (t.forbid_tool && t.forbid_tool.includes(tool)) {
    return { rule: rule.rule, assertion: 'forbid_tool', message: `调用了被禁止的工具 ${tool}`, evidence: { args: normalizeArgs(args) } };
  }

  if (t.allow_tool && !t.allow_tool.includes(tool)) {
    return {
      rule: rule.rule,
      assertion: 'allow_tool',
      message: `调用了白名单（${t.allow_tool.join(', ')}）之外的工具 ${tool}`,
      evidence: { args: normalizeArgs(args) },
    };
  }

  if (t.max_tool_calls !== undefined) {
    const n = (state.toolCallCounts.get(tool) || 0) + 1;
    if (n > t.max_tool_calls) {
      return {
        rule: rule.rule,
        assertion: 'max_tool_calls',
        message: `${tool} 已被调用 ${n} 次，超过上限 ${t.max_tool_calls}（疑似循环）`,
        evidence: { count: n },
      };
    }
  }

  if (t.idempotent) {
    for (let i = 0; i < t.idempotent.length; i++) {
      const entry = t.idempotent[i];
      if (entry.tool !== tool) continue;
      const kv = entry.key === '${__args__}' ? JSON.stringify(normalizeArgs(args)) : resolveKeyTemplate(entry.key, args);
      const seenKey = `${i}:${kv}`;
      if (state.idempotentSeen.has(seenKey)) {
        return {
          rule: rule.rule,
          assertion: 'idempotent',
          message: `${tool} 重复执行：${entry.key}=${kv} 已在本会话调用过`,
          evidence: { key: entry.key, keyValue: kv, firstTurn: state.idempotentSeen.get(seenKey) },
        };
      }
    }
  }

  return null;
}
