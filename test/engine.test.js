// 断言引擎单元测试
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRule } from '../src/rule.js';
import { parseTrace } from '../src/trace.js';
import { sessionMatchesWhen, evaluateRuleOnSession, evaluateTraceForCi, evaluateCallAtRuntime } from '../src/engine.js';
import { createGuardState } from '../src/guard.js';
import { resolveKeyTemplate } from '../src/util.js';

const R = (obj) => normalizeRule(obj);

const mkSession = (events, id = 's1') => ({ id, events });
const user = (text, turn) => ({ type: 'user', turn, text });
const call = (tool, args, turn) => ({ type: 'tool_call', turn, callId: `c${turn}`, tool, args });

describe('when.intent_any 匹配', () => {
  const when = { intent_any: ['物流', '订单'] };
  test('命中任一关键词', () => {
    const s = mkSession([user('我的订单到哪了', 1)]);
    assert.equal(sessionMatchesWhen(s, when), true);
  });
  test('大小写不敏感', () => {
    const s = mkSession([user('check the STATUS please', 1)]);
    assert.equal(sessionMatchesWhen(s, { intent_any: ['status'] }), true);
  });
  test('未命中', () => {
    const s = mkSession([user('你好', 1)]);
    assert.equal(sessionMatchesWhen(s, when), false);
  });
  test('无 when 条件恒真', () => {
    const s = mkSession([user('你好', 1)]);
    assert.equal(sessionMatchesWhen(s, { intent_any: [] }), true);
  });
});

describe('resolveKeyTemplate 事务键解析', () => {
  test('顶层参数', () => {
    assert.equal(resolveKeyTemplate('${order_id}', { order_id: 'A1001' }), 'A1001');
  });
  test('嵌套路径', () => {
    assert.equal(resolveKeyTemplate('${input.order_id}', { input: { order_id: 'B2' } }), 'B2');
  });
  test('路径缺失 → __missing__', () => {
    assert.equal(resolveKeyTemplate('${nope}', { order_id: 'A1' }), '__missing__');
  });
  test('字面量原样返回', () => {
    assert.equal(resolveKeyTemplate('fixed-key', {}), 'fixed-key');
  });
});

describe('forbid_tool', () => {
  const rule = R({ rule: 't', then: { forbid_tool: 'refund_order' } });
  test('调用了被禁工具 → 违规', () => {
    const s = mkSession([user('hi', 1), call('refund_order', { order_id: 'A' }, 2)]);
    const out = evaluateRuleOnSession(rule, s);
    assert.equal(out.length, 1);
    assert.equal(out[0].assertion, 'forbid_tool');
    assert.equal(out[0].turn, 2);
  });
  test('没调用 → 无违规', () => {
    const s = mkSession([user('hi', 1), call('query_order', {}, 2)]);
    assert.equal(evaluateRuleOnSession(rule, s).length, 0);
  });
  test('when 未命中 → 不评估', () => {
    const rule2 = R({ rule: 't', when: { intent_any: ['退款'] }, then: { forbid_tool: 'refund_order' } });
    const s = mkSession([user('只是查物流', 1), call('refund_order', {}, 2)]);
    assert.equal(evaluateRuleOnSession(rule2, s).length, 0);
  });
});

describe('allow_tool 白名单', () => {
  const rule = R({ rule: 't', then: { allow_tool: ['query_order', 'get_logistics'] } });
  test('白名单之外 → 违规', () => {
    const s = mkSession([call('send_email', {}, 1)]);
    const out = evaluateRuleOnSession(rule, s);
    assert.equal(out.length, 1);
    assert.equal(out[0].assertion, 'allow_tool');
  });
  test('都在白名单内 → 无违规', () => {
    const s = mkSession([call('query_order', {}, 1), call('get_logistics', {}, 2)]);
    assert.equal(evaluateRuleOnSession(rule, s).length, 0);
  });
});

describe('require_tool（仅 CI）', () => {
  const rule = R({ rule: 't', then: { require_tool: 'query_order' } });
  test('该调的没调 → 违规', () => {
    const s = mkSession([user('q', 1), call('get_logistics', {}, 2)]);
    const out = evaluateRuleOnSession(rule, s);
    assert.equal(out.length, 1);
    assert.equal(out[0].assertion, 'require_tool');
  });
  test('调过 → 无违规', () => {
    const s = mkSession([call('query_order', {}, 1)]);
    assert.equal(evaluateRuleOnSession(rule, s).length, 0);
  });
  test('多个必需工具调了其一即可', () => {
    const rule2 = R({ rule: 't', then: { require_tool: ['a', 'b'] } });
    const s = mkSession([call('b', {}, 1)]);
    assert.equal(evaluateRuleOnSession(rule2, s).length, 0);
  });
});

describe('max_tool_calls', () => {
  const rule = R({ rule: 't', then: { max_tool_calls: 2 } });
  test('超限 → 单条违规（不逐次报）', () => {
    const s = mkSession([call('a', {}, 1), call('a', {}, 2), call('a', {}, 3)]);
    const out = evaluateRuleOnSession(rule, s);
    assert.equal(out.length, 1);
    assert.equal(out[0].assertion, 'max_tool_calls');
  });
  test('未超限 → 无违规', () => {
    const s = mkSession([call('a', {}, 1), call('a', {}, 2)]);
    assert.equal(evaluateRuleOnSession(rule, s).length, 0);
  });
});

describe('idempotent 同一事务键不许重复', () => {
  const rule = R({ rule: 't', then: { idempotent: { tool: 'refund_order', key: '${order_id}', on_violation: 'block' } } });
  test('同键两次 → 在第二次报 1 条', () => {
    const s = mkSession([
      call('refund_order', { order_id: 'A1001', amount: 199 }, 7),
      call('refund_order', { order_id: 'A1001', amount: 199 }, 9),
    ]);
    const out = evaluateRuleOnSession(rule, s);
    assert.equal(out.length, 1);
    assert.equal(out[0].assertion, 'idempotent');
    assert.equal(out[0].turn, 9);
    assert.equal(out[0].evidence.firstTurn, 7);
  });
  test('不同键 → 无违规', () => {
    const s = mkSession([
      call('refund_order', { order_id: 'A1001' }, 1),
      call('refund_order', { order_id: 'B2002' }, 2),
    ]);
    assert.equal(evaluateRuleOnSession(rule, s).length, 0);
  });
  test('缺事务键 → 都归入 __missing__，第二次仍拦', () => {
    const s = mkSession([call('refund_order', {}, 1), call('refund_order', {}, 2)]);
    assert.equal(evaluateRuleOnSession(rule, s).length, 1);
  });
  test('同键不同工具不受影响', () => {
    const s = mkSession([call('query_order', { order_id: 'A1001' }, 1), call('refund_order', { order_id: 'A1001' }, 2)]);
    assert.equal(evaluateRuleOnSession(rule, s).length, 0);
  });
});

describe('evaluateTraceForCi 出口过滤', () => {
  const trace = parseTrace({
    trace_version: 1,
    name: 't',
    sessions: [{ id: 's1', events: [call('refund_order', {}, 1)] }],
  });
  test('where.ci=false 的规则被跳过并说明原因', () => {
    const rules = [R({ rule: 'runtime-only', then: { forbid_tool: 'refund_order' }, where: { ci: false, runtime: true } })];
    const { violations, skippedRules } = evaluateTraceForCi(rules, trace);
    assert.equal(violations.length, 0);
    assert.equal(skippedRules.length, 1);
    assert.match(skippedRules[0].reason, /where\.ci = false/);
  });
  test('runtime+ci 规则正常参与', () => {
    const rules = [R({ rule: 'both', then: { forbid_tool: 'refund_order' }, where: { ci: true, runtime: true } })];
    const { violations } = evaluateTraceForCi(rules, trace);
    assert.equal(violations.length, 1);
  });
});

describe('evaluateCallAtRuntime（guard 单次调用判定）', () => {
  const rules = [
    R({ rule: 'no-when-forbid', then: { forbid_tool: 'other_tool' }, where: { ci: false, runtime: true } }),
    R({ rule: 'intent-forbid', when: { intent_any: ['物流'] }, then: { forbid_tool: 'refund_order' }, where: { ci: false, runtime: true } }),
  ];
  test('无 when 规则直接生效', () => {
    const hit = evaluateCallAtRuntime(rules[0], 'other_tool', {}, createGuardState(), undefined);
    assert.equal(hit.assertion, 'forbid_tool');
  });
  test('intent 规则缺 intent 提示 → 跳过（返回 null）', () => {
    assert.equal(evaluateCallAtRuntime(rules[1], 'refund_order', {}, createGuardState(), undefined), null);
  });
  test('intent 提示命中 → 拦截', () => {
    const hit = evaluateCallAtRuntime(rules[1], 'refund_order', {}, createGuardState(), '查询物流');
    assert.equal(hit.assertion, 'forbid_tool');
  });
  test('intent 提示未命中 → 放行', () => {
    assert.equal(evaluateCallAtRuntime(rules[1], 'refund_order', {}, createGuardState(), '我要退款'), null);
  });
});
