// 演示脚本：真实起 guard 代理 + mock 上游，验证「learn 出来的规则」能在线上拦住重复退款
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url)); // demo-guard.mjs 位于项目根目录
const demoDir = path.join(os.tmpdir(), 'ag-demo');
const rulesDir = path.join(demoDir, 'rules');

// 自包含：规则不存在就先从事故 trace learn 一份（演示里用 --runtime，只做线上护栏）
if (!fs.existsSync(rulesDir)) {
  console.log('（首次运行：先从事故 trace 生成演示规则…）\n');
  fs.mkdirSync(demoDir, { recursive: true });
  spawnSync(
    process.execPath,
    ['src/cli.js', 'learn', '--trace', path.join(ROOT, 'examples', 'traces', 'refund_incident.json'), '--rules-dir', rulesDir, '--runtime', '--apply'],
    { cwd: ROOT, stdio: 'inherit' }
  );
}

const child = spawn(
  process.execPath,
  [
    'src/cli.js',
    'guard',
    '--rules', rulesDir,
    '--upstream', `node "${path.join(ROOT, 'test', 'fixtures', 'mockMcpServer.mjs')}"`,
    '--audit', path.join(demoDir, 'audit.jsonl'),
  ],
  { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
);

let id = 0;
const pending = new Map();
child.stdout.setEncoding('utf8');
readline.createInterface({ input: child.stdout }).on('line', (l) => {
  if (!l.trim()) return;
  const m = JSON.parse(l);
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c) => process.stderr.write(c));

function req(method, params) {
  return new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n');
  });
}

const step = (t) => console.log('\n=== ' + t + ' ===');

try {
  await req('initialize', { protocolVersion: '2024-11-05', capabilities: {} });

  step('tools/call refund_order order_id=A1001（第 1 次）');
  const r1 = await req('tools/call', { name: 'refund_order', arguments: { order_id: 'A1001', amount: 199 } });
  console.log(r1.result ? '放行 → 上游返回: ' + r1.result.content[0].text : '意外拦截: ' + JSON.stringify(r1.error));

  step('tools/call refund_order order_id=A1001（第 2 次，同一订单）');
  const r2 = await req('tools/call', { name: 'refund_order', arguments: { order_id: 'A1001', amount: 199 } });
  console.log(r2.error ? '拦截 ✗ code=' + r2.error.code + ' → ' + r2.error.message : '意外放行（不应发生）');

  step('tools/call refund_order order_id=B2002（另一笔订单）');
  const r3 = await req('tools/call', { name: 'refund_order', arguments: { order_id: 'B2002', amount: 50 } });
  console.log(r3.result ? '放行 → 上游返回: ' + r3.result.content[0].text : '意外拦截: ' + JSON.stringify(r3.error));

  child.stdin.end();
  await new Promise((r) => setTimeout(r, 600));

  step('审计日志 audit.jsonl（learn 出的规则自动带 runtime 出口）');
  console.log(fs.readFileSync(path.join(demoDir, 'audit.jsonl'), 'utf8').trim());
} catch (err) {
  console.error('演示失败:', err.message);
} finally {
  child.kill();
  process.exit(0);
}
