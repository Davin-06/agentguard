// learn：从事故 trace 里长出候选规则。
//
// 为什么必须人工确认：判断「哪一步是错的」是语义问题，启发式会误判。
// 所以它只给候选 + 置信度 + 证据，加 --apply 才落盘。
// 任何声称「一键把 trace 变成测试」的方案，都在回避这个难点。

import { normalizeArgs, slugify } from './util.js';
import { userTexts } from './trace.js';

// ---- 启发式 1：幂等违规（同一事务键被调多次）----
// 全参数完全相同 → 0.85~0.9；仅某个标量参数相同（其余不同）→ 0.7（当前实现聚焦全参数相同）
const IDENT_NAME_RE = /(_id|_no|_key|_uuid|_sn|_code|Id|No|Key|Uuid|Sn|Code)$/;
export function detectIdempotency(trace, opts) {
  const candidates = [];
  for (const session of trace.sessions) {
    const calls = session.events.filter((e) => e.type === 'tool_call');
    const byTool = new Map();
    for (const c of calls) {
      if (!byTool.has(c.tool)) byTool.set(c.tool, []);
      byTool.get(c.tool).push(c);
    }
    for (const [tool, list] of byTool) {
      if (list.length < 2) continue;
      // 按归一化参数分组：O(n) 分组替代 O(n²) 两两比较——
      // 失控循环（上千次相同调用）是真实事故形态，两两比较会让 learn 挂死
      const groups = new Map();
      for (const c of list) {
        const k = JSON.stringify(normalizeArgs(c.args));
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(c);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        {
          const a = group[0];
          const b = group[1];
          // 全参数相同 → 选一个"像事务键"的标量参数：
          // 1) 名字像标识符（*_id / *_no / key / uuid…）→ 2) 在组外调用中有区分度 → 3) 兜底第一个标量
          const raw = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {};
          const scalarKeys = Object.keys(raw).filter((k) => ['string', 'number'].includes(typeof raw[k]));
          const val = (o, k) => {
            const n = normalizeArgs(o.args);
            return n[k] === undefined ? undefined : String(n[k]);
          };
          const outside = list.filter((c) => !group.includes(c));
          let keyName = scalarKeys.find((k) => IDENT_NAME_RE.test(k));
          let identified = !!keyName;
          if (!keyName) {
            keyName = scalarKeys.find((k) => outside.some((o) => val(o, k) !== undefined && val(o, k) !== String(raw[k])));
            identified = !!keyName;
          }
          if (!keyName && scalarKeys.length) keyName = scalarKeys[0];
          const confidence = identified ? 0.9 : 0.85;
          const kv = keyName ? `${keyName}='${raw[keyName]}'` : JSON.stringify(normalizeArgs(a.args));
          const evidence = [`turns ${a.turn} & ${b.turn} share ${kv}`];
          if (group.length > 2) evidence.push(`同一参数组合共重复 ${group.length} 次`);
          candidates.push({
            name: slugify(`${trace.name}-idempotent-${tool}`),
            confidence,
            kind: 'idempotent',
            reason: `${tool} 用同一 ${keyName || '参数'} 被调用了多次`,
            evidence,
            rule: {
              rule: slugify(`${trace.name}-idempotent-${tool}`),
              description: `learn：${tool} 同一事务键不允许重复执行（来自 trace「${trace.name}」的事故回放）`,
              then: { idempotent: [{ tool, key: keyName ? `\${${keyName}}` : '${__args__}', on_violation: 'block' }] },
            },
            session: session.id,
          });
        }
      }
    }
  }
  dedupeBest(candidates, opts);
  return candidates;
}

// ---- 启发式 2：只读意图 × 破坏性工具 ----
const DESTRUCTIVE_TOOL_RE = /^(refund|delete|del[_-]|remove|cancel|transfer|pay|charge|send|create|update|write|drop|shutdown|restart|reboot|approve|execute)/i;
const ACTION_STEMS = [
  [/^refund/i, ['退款', '退钱', '退货款', 'refund']],
  [/^(delete|del[_-]|remove|drop)/i, ['删除', '删掉', 'remove', 'delete']],
  [/^cancel/i, ['取消', 'cancel']],
  [/^transfer/i, ['转账', 'transfer']],
  [/^(pay|charge)/i, ['支付', '付款', '扣款', 'pay', 'charge']],
  [/^send/i, ['发送', 'send']],
  [/^(create|update|write)/i, ['创建', '新建', '修改', '更新', 'create', 'update']],
  [/^(shutdown|restart|reboot)/i, ['重启', '关机', 'shutdown', 'restart', 'reboot']],
  [/^(approve|execute)/i, ['审批', '批准', '执行', 'approve', 'execute']],
];
const READ_INTENT_KEYWORDS = [
  '到货', '物流', '订单', '进度', '查询', '查一下', '问一下', '什么时候', '怎么还没',
  '多久', '多少', '状态', 'status', 'track', 'where', 'when', 'how',
];

export function detectReadOnlyIntentDestructive(trace, opts) {
  const candidates = [];
  for (const session of trace.sessions) {
    const texts = userTexts(session);
    if (!texts.length) continue;
    const hitIntents = [];
    for (const kw of READ_INTENT_KEYWORDS) {
      if (texts.some((t) => t.includes(kw))) hitIntents.push(kw);
    }
    if (!hitIntents.length) continue;

    for (const call of session.events.filter((e) => e.type === 'tool_call')) {
      const m = call.tool.match(DESTRUCTIVE_TOOL_RE);
      if (!m) continue;
      const stems = (ACTION_STEMS.find(([re]) => re.test(call.tool)) || [null, []])[1];
      // 用户明确要求过这个动作 → 不是事故，跳过（这就是为什么必须人工确认的反面：我们能自动排除一部分）
      if (stems.length && texts.some((t) => stems.some((s) => t.includes(s)))) continue;
      candidates.push({
        name: slugify(`${trace.name}-forbid-${call.tool}`),
        confidence: 0.82,
        kind: 'forbid_tool',
        reason: `检测到只读意图的会话中调用了破坏性工具 ${call.tool}`,
        evidence: [
          `命中只读意图关键词：${hitIntents.slice(0, 3).join(' / ')}（intent_any 建议）`,
          `turn ${call.turn} 调用 ${call.tool}(${JSON.stringify(normalizeArgs(call.args)).slice(0, 80)})`,
        ],
        rule: {
          rule: slugify(`${trace.name}-forbid-${call.tool}`),
          description: `learn：只读意图会话中禁止 ${call.tool}（来自 trace「${trace.name}」的事故回放）`,
          when: { intent_any: hitIntents.slice(0, 5) },
          then: { forbid_tool: [call.tool] },
        },
        session: session.id,
      });
    }
  }
  dedupeBest(candidates, opts);
  return candidates;
}

// ---- 启发式 3：调用循环（同一工具高频调用）----
export function detectLoops(trace, opts) {
  const candidates = [];
  for (const session of trace.sessions) {
    const byTool = new Map();
    for (const c of session.events.filter((e) => e.type === 'tool_call')) {
      if (!byTool.has(c.tool)) byTool.set(c.tool, 0);
      byTool.set(c.tool, byTool.get(c.tool) + 1);
    }
    for (const [tool, count] of byTool) {
      if (count <= opts.loopMinCalls) continue;
      candidates.push({
        name: slugify(`${trace.name}-max-calls-${tool}`),
        confidence: 0.75,
        kind: 'max_tool_calls',
        reason: `${tool} 在单会话中被调用 ${count} 次，疑似无限循环`,
        evidence: [`session ${session.id} 共 ${count} 次调用，建议上限设为观测值或更低（请人工调整）`],
        rule: {
          rule: slugify(`${trace.name}-max-calls-${tool}`),
          description: `learn：限制 ${tool} 单会话调用次数（来自 trace「${trace.name}」）`,
          then: { max_tool_calls: count },
        },
        session: session.id,
      });
    }
  }
  dedupeBest(candidates, opts);
  return candidates;
}

/** 同名候选保留置信度最高的一个 */
function dedupeBest(candidates, opts) {
  candidates.sort((a, b) => b.confidence - a.confidence);
  const seen = new Set();
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (seen.has(candidates[i].name)) candidates.splice(i, 1);
    else seen.add(candidates[i].name);
  }
}

/**
 * 生成全部候选（已按置信度降序、去重、按阈值过滤）。
 * where 由 CLI 的 --ci/--runtime 决定。
 */
export function learnCandidates(trace, opts = {}) {
  const threshold = opts.threshold ?? 0.7;
  const loopMinCalls = opts.loopMinCalls ?? 5;
  const all = [
    ...detectIdempotency(trace, { loopMinCalls }),
    ...detectReadOnlyIntentDestructive(trace, { loopMinCalls }),
    ...detectLoops(trace, { loopMinCalls }),
  ];
  const seen = new Set();
  const out = [];
  for (const c of all.sort((a, b) => b.confidence - a.confidence)) {
    if (c.confidence < threshold) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}
