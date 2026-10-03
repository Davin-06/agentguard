// 大项目（需求用户）场景回归测试：压测中发现的每个漏洞都固化成用例
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const EXAMPLE_TRACE = path.join(ROOT, 'examples', 'traces', 'refund_incident.json');
const EXAMPLE_RULES = path.join(ROOT, 'examples', 'rules');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-real-'));
}

describe('大项目场景：learn 在失控循环（大会话）下不能挂死', () => {
  test('3000 次相同调用 → 秒级完成且只报一条候选（含重复次数证据）', () => {
    const dir = tmpdir();
    const events = [{ type: 'user', text: '帮我导出报表' }];
    for (let i = 0; i < 3000; i++) {
      events.push({ type: 'tool_call', id: `c${i}`, tool: 'export_report', args: { range: 'Q3', format: 'csv' } });
    }
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, JSON.stringify({ trace_version: 1, name: 'big-loop', sessions: [{ id: 's1', events }] }));
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, 'learn', '--trace', big], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    const dt = Date.now() - t0;
    assert.equal(r.status, 0);
    assert.ok(dt < 10000, `learn 应秒级完成，实际 ${dt}ms（O(n²) 回归？）`);
    assert.match(r.stdout, /idempotent/);
    assert.match(r.stdout, /共重复 3000 次/);
  });
});

describe('大项目场景：嵌套 trace 目录（按日期/服务分片）不能漏', () => {
  test('子目录里的 trace 也要被检查，且聚合退出码正确', () => {
    const dir = tmpdir();
    const traceDir = path.join(dir, 'traces');
    fs.mkdirSync(path.join(traceDir, '2026-09'), { recursive: true });
    fs.writeFileSync(
      path.join(traceDir, 'good.json'),
      JSON.stringify({ trace_version: 1, name: 'good', sessions: [{ id: 's1', events: [{ type: 'tool_call', id: 'c1', tool: 'query_order', args: {} }] }] })
    );
    fs.writeFileSync(
      path.join(traceDir, '2026-09', 'bad.json'),
      JSON.stringify({
        trace_version: 1,
        name: 'bad',
        sessions: [
          {
            id: 's1',
            events: [
              { type: 'user', text: '物流怎么还没更新' },
              { type: 'tool_call', id: 'c1', tool: 'refund_order', args: { order_id: 'A1001' } },
            ],
          },
        ],
      })
    );
    const r = spawnSync(process.execPath, [CLI, 'check', '--rules', EXAMPLE_RULES, '--trace', traceDir], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1, '子目录里的违规 trace 必须被抓到');
    assert.match(r.stdout, /bad/);
    assert.match(r.stdout, /2 份 trace/);
  });
});

describe('大项目场景：审计写失败必须拒绝启动（合规底线）', () => {
  test('--audit 指向不可写路径 → 退出码 2 + 明确报错，而不是静默丢审计', () => {
    const dir = tmpdir();
    // 用一个"目录"当审计文件路径，必然写失败
    const auditDir = path.join(dir, 'audit-is-a-dir');
    fs.mkdirSync(auditDir);
    const r = spawnSync(
      process.execPath,
      [CLI, 'guard', '--rules', EXAMPLE_RULES, '--upstream', 'node no-such-server.js', '--audit', auditDir],
      { cwd: dir, encoding: 'utf8', timeout: 20000 }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /审计日志不可写/);
    assert.match(r.stderr, /拒绝启动/);
  });
});

describe('大项目场景：规则里拼错工具名 → 假安全要被点名', () => {
  test('引用了 trace 中从未出现过的工具 → 输出 lint 提示', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'rules');
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(
      path.join(rulesDir, 'typo.yaml'),
      ['rule: typo-forbid', 'then:', '  forbid_tool: refnd_order', 'where:', '  ci: true', '  runtime: false'].join('\n')
    );
    const r = spawnSync(process.execPath, [CLI, 'check', '--rules', rulesDir, '--trace', EXAMPLE_TRACE], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /refnd_order/);
    assert.match(r.stderr, /从未生效/);
  });
  test('正常规则不触发 lint 提示', () => {
    const dir = tmpdir();
    const r = spawnSync(process.execPath, [CLI, 'check', '--rules', EXAMPLE_RULES, '--trace', EXAMPLE_TRACE], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1);
    assert.doesNotMatch(r.stderr, /从未在任何 trace 中被调用过/);
  });
});

describe('大项目场景：多团队规则名冲突的治理', () => {
  function makeDupRules(dir) {
    const rulesDir = path.join(dir, 'rules');
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(path.join(rulesDir, 'a.yaml'), ['rule: no-refund', 'then:', '  forbid_tool: refund_order', 'where:', '  ci: true', '  runtime: false'].join('\n'));
    fs.writeFileSync(path.join(rulesDir, 'b.yaml'), ['rule: no-refund', 'then:', '  allow_tool: [query_order]', 'where:', '  ci: true', '  runtime: false'].join('\n'));
    return rulesDir;
  }
  test('默认：警告但继续运行', () => {
    const dir = tmpdir();
    const r = spawnSync(process.execPath, [CLI, 'check', '--rules', makeDupRules(dir), '--trace', EXAMPLE_TRACE], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /重复/);
  });
  test('--strict：冲突直接拒绝（退出码 2），用于 monorepo CI 门禁', () => {
    const dir = tmpdir();
    const r = spawnSync(process.execPath, [CLI, 'check', '--rules', makeDupRules(dir), '--trace', EXAMPLE_TRACE, '--strict'], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--strict/);
    assert.match(r.stderr, /no-refund/);
  });
});

describe('大项目场景：export --out 指向不存在的嵌套目录', () => {
  test('自动创建目录并写入', () => {
    const dir = tmpdir();
    const outFile = path.join(dir, 'deep', 'nested', 'pf.yaml');
    const r = spawnSync(process.execPath, [CLI, 'export', '--to', 'promptfoo', '--rules', EXAMPLE_RULES, '--out', outFile], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 0);
    assert.ok(fs.existsSync(outFile));
  });
});
