// guard 端到端测试：真实起一个 MCP 代理 + mock 上游，逐调用验证拦截/放行/审计
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const MOCK_SERVER = path.join(ROOT, 'test', 'fixtures', 'mockMcpServer.mjs');

const GUARD_RULES = [
  'rule: no-when-forbid',
  'then:',
  '  forbid_tool: other_tool',
  'where:',
  '  ci: false',
  '  runtime: true',
  '---',
  'rule: idempotent-guard',
  'then:',
  '  idempotent:',
  '    tool: refund_order',
  "    key: '${order_id}'",
  '    on_violation: block',
  'where:',
  '  ci: false',
  '  runtime: true',
  '---',
  'rule: intent-guard',
  'when:',
  '  intent_any: ["物流"]',
  'then:',
  '  forbid_tool: refund_order',
  'where:',
  '  ci: false',
  '  runtime: true',
].join('\n');

class GuardClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.stderr = '';
    this.nextId = 100;
    this.closed = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (this.stderr += c));
  }
  request(method, params, timeoutMs = 8000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`请求超时: ${method} (id=${id})`)), timeoutMs);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}

async function startGuard(rulesDir, auditFile) {
  const child = spawn(
    process.execPath,
    [CLI, 'guard', '--rules', rulesDir, '--upstream', `node "${MOCK_SERVER}"`, '--audit', auditFile],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const client = new GuardClient(child);
  // 等 guard 就绪（初始化握手成功即视为就绪）
  const init = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2024-11-05');
  return { child, client, auditFile };
}

describe('guard：运行时护栏（MCP stdio 代理）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-guard-'));
  const rulesDir = path.join(dir, 'rules');
  const auditFile = path.join(dir, 'audit.jsonl');
  fs.mkdirSync(rulesDir);
  fs.writeFileSync(path.join(rulesDir, 'rules.yaml'), GUARD_RULES);

  let ctx;
  test('启动代理并完成初始化握手', async () => {
    ctx = await startGuard(rulesDir, auditFile);
    assert.ok(ctx.child.pid);
  });

  test('tools/list 原样透传上游', async () => {
    const resp = await ctx.client.request('tools/list', {});
    assert.equal(resp.result.tools.length, 3);
  });

  test('白名单外不涉及的工具正常放行（query_order）', async () => {
    const resp = await ctx.client.request('tools/call', { name: 'query_order', arguments: { order_id: 'A1001' } });
    assert.match(resp.result.content[0].text, /MOCK-OK/);
    assert.match(resp.result.content[0].text, /A1001/);
  });

  test('幂等断言：第一次放行，同事务键第二次被拦（-32001）', async () => {
    const first = await ctx.client.request('tools/call', { name: 'refund_order', arguments: { order_id: 'A1001', amount: 199 } });
    assert.ok(first.result, '第一次退款应放行');
    const second = await ctx.client.request('tools/call', { name: 'refund_order', arguments: { order_id: 'A1001', amount: 199 } });
    assert.equal(second.error.code, -32001);
    assert.match(second.error.message, /idempotent-guard/);
    assert.match(second.error.message, /idempotent/);
    assert.equal(second.error.data.keyValue, 'A1001');
  });

  test('不同事务键放行（A1001 拦过不等于 B2002 也拦）', async () => {
    const resp = await ctx.client.request('tools/call', { name: 'refund_order', arguments: { order_id: 'B2002', amount: 50 } });
    assert.ok(resp.result, '不同订单的退款应放行');
  });

  test('无条件 forbid 规则直接拦截（other_tool）', async () => {
    const resp = await ctx.client.request('tools/call', { name: 'other_tool', arguments: {} });
    assert.equal(resp.error.code, -32001);
    assert.match(resp.error.message, /no-when-forbid/);
  });

  test('intent 规则：带 _meta.agentguard.intent 提示命中 → 拦；无提示 → 跳过放行', async () => {
    const blocked = await ctx.client.request('tools/call', {
      name: 'refund_order',
      arguments: { order_id: 'C3333', amount: 10 },
      _meta: { agentguard: { intent: '查询物流进度' } },
    });
    assert.equal(blocked.error.code, -32001);
    assert.match(blocked.error.message, /intent-guard/);

    const passed = await ctx.client.request('tools/call', { name: 'refund_order', arguments: { order_id: 'D4444', amount: 10 } });
    assert.ok(passed.result, '无意图提示时应跳过 intent 规则放行');
  });

  test('审计日志对超大参数做截断（不落全量）', async () => {
    const huge = { order_id: 'E5555', payload: 'x'.repeat(5000) };
    const resp = await ctx.client.request('tools/call', { name: 'refund_order', arguments: huge });
    assert.ok(resp.result, '大参数调用本身应放行');
  });

  test('审计日志记录了 allow 与 block', async () => {
    await new Promise((r) => setTimeout(r, 300)); // 等最后一次审计落盘
    const lines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const allows = lines.filter((l) => l.decision === 'allow');
    const blocks = lines.filter((l) => l.decision === 'block');
    assert.ok(allows.length >= 4, `应有放行记录，实际 ${allows.length}`);
    assert.equal(blocks.length, 3);
    assert.ok(blocks.every((b) => b.rule && b.assertion && b.ts));
    assert.ok(blocks.some((b) => b.assertion === 'idempotent'));
    assert.ok(blocks.some((b) => b.assertion === 'forbid_tool'));
    const truncated = lines.find((l) => l.args && typeof l.args === 'object' && l.args._truncated);
    assert.ok(truncated, '超大参数应被截断记录');
    assert.match(truncated.args._truncated, /共 \d+ 字符/);
  });

  after(async () => {
    if (!ctx) return;
    ctx.child.stdin.end();
    const code = await Promise.race([ctx.closed, new Promise((r) => setTimeout(() => r(null), 5000))]);
    if (code === null) ctx.child.kill();
  });
});
