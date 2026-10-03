// learn 启发式单元测试
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadTrace } from '../src/trace.js';
import { learnCandidates } from '../src/learn.js';
import { parseRuleYaml, ruleToYaml } from '../src/rule.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_TRACE = path.join(ROOT, 'examples', 'traces', 'refund_incident.json');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-test-'));
}

describe('learn：从事故 trace 长出候选规则', () => {
  const trace = loadTrace(EXAMPLE_TRACE);

  test('退款事故 → 幂等候选（90%）+ 禁用候选（82%），按置信度排序', () => {
    const cands = learnCandidates(trace, {});
    assert.equal(cands.length, 2);
    const [idem, forbid] = cands;
    assert.equal(idem.kind, 'idempotent');
    assert.equal(idem.confidence, 0.9);
    assert.match(idem.reason, /order_id/);
    assert.ok(idem.evidence.some((e) => /order_id='A1001'/.test(e)));
    assert.equal(forbid.kind, 'forbid_tool');
    assert.equal(forbid.confidence, 0.82);
    // trace 用户消息「…到货了吗？物流怎么还没更新」命中的全部关键词
    assert.deepEqual(forbid.rule.when.intent_any, ['到货', '物流', '订单', '怎么还没']);
    assert.deepEqual(forbid.rule.then.forbid_tool, ['refund_order']);
  });

  test('阈值过滤：threshold=0.95 时无候选', () => {
    assert.equal(learnCandidates(trace, { threshold: 0.95 }).length, 0);
  });

  test('用户明确要求退款 → 不生成 forbid 候选（避免误伤正常业务）', () => {
    const askedTrace = {
      trace_version: 1,
      name: 'asked-refund',
      sessions: [
        {
          id: 's1',
          events: [
            { type: 'user', text: '订单 A1001 太差了，给我退款' },
            { type: 'tool_call', id: 'c1', tool: 'refund_order', args: { order_id: 'A1001', amount: 199 } },
            { type: 'tool_call', id: 'c2', tool: 'refund_order', args: { order_id: 'A1001', amount: 199 } },
          ],
        },
      ],
    };
    const cands = learnCandidates(askedTrace, {});
    // 幂等候选仍应生成（退两次总是错的），但 forbid 不应有
    assert.ok(cands.every((c) => c.kind !== 'forbid_tool'), `不应有 forbid 候选，实际：${cands.map((c) => c.kind).join(',')}`);
    assert.ok(cands.some((c) => c.kind === 'idempotent'));
  });

  test('高频调用 → max_tool_calls 候选', () => {
    const events = [{ type: 'user', text: '帮我处理' }];
    for (let i = 0; i < 7; i++) events.push({ type: 'tool_call', id: `c${i}`, tool: 'search_web', args: { q: i } });
    const loopTrace = { trace_version: 1, name: 'loop-trace', sessions: [{ id: 's1', events }] };
    const cands = learnCandidates(loopTrace, { loopMinCalls: 5 });
    const loop = cands.find((c) => c.kind === 'max_tool_calls');
    assert.ok(loop, '应有 max_tool_calls 候选');
    assert.equal(loop.rule.then.max_tool_calls, 7);
    assert.equal(loop.confidence, 0.75);
  });
});

describe('learn --apply 产物可读回', () => {
  test('候选规则的 YAML 文本可被 parseRuleYaml 解析', () => {
    const trace = loadTrace(EXAMPLE_TRACE);
    const [cand] = learnCandidates(trace, {});
    const { rules } = parseRuleYaml(ruleToYaml({ ...cand.rule, where: { ci: true, runtime: true } }));
    assert.equal(rules.length, 1);
    assert.equal(rules[0].then.idempotent[0].tool, 'refund_order');
    assert.equal(rules[0].then.idempotent[0].key, '${order_id}');
    assert.equal(rules[0].where.runtime, true);
  });

  test('tmpdir 可用', () => {
    const d = tmpdir();
    assert.ok(fs.existsSync(d));
  });
});
