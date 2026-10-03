// CLI 端到端测试：以子进程方式跑真实命令，断言退出码与输出
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-cli-'));
}

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    timeout: 30000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('check：CI 卡点', () => {
  test('事故 trace → 退出码 1，违规输出包含规则名与断言', () => {
    const r = runCli(['check', '--rules', EXAMPLE_RULES, '--trace', EXAMPLE_TRACE]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /refund-safety/);
    assert.match(r.stdout, /forbid_tool/);
    assert.match(r.stdout, /allow_tool/);
    assert.match(r.stdout, /idempotent/);
    assert.match(r.stdout, /A1001/);
  });

  test('--json 输出可解析的结构化报告', () => {
    const r = runCli(['check', '--rules', EXAMPLE_RULES, '--trace', EXAMPLE_TRACE, '--json']);
    assert.equal(r.code, 1);
    const report = JSON.parse(r.stdout);
    assert.equal(report.summary.violations, 5);
    assert.equal(report.summary.passed, false);
    const kinds = report.violations.map((v) => v.assertion);
    assert.ok(kinds.includes('forbid_tool') && kinds.includes('allow_tool') && kinds.includes('idempotent'));
  });

  test('合规 trace → 退出码 0', () => {
    const dir = tmpdir();
    const good = {
      trace_version: 1,
      name: 'good-chat',
      sessions: [
        {
          id: 's1',
          events: [
            { type: 'user', text: '订单 A1001 的物流到哪了' },
            { type: 'tool_call', id: 'c1', tool: 'query_order', args: { order_id: 'A1001' } },
            { type: 'tool_call', id: 'c2', tool: 'get_logistics', args: { order_id: 'A1001' } },
            { type: 'assistant', text: '明天送达' },
          ],
        },
      ],
    };
    const traceFile = path.join(dir, 'good.json');
    fs.writeFileSync(traceFile, JSON.stringify(good));
    const r = runCli(['check', '--rules', EXAMPLE_RULES, '--trace', traceFile]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /全部通过/);
  });

  test('缺 --trace → 用法错误退出码 2', () => {
    const r = runCli(['check', '--rules', EXAMPLE_RULES]);
    assert.equal(r.code, 2);
  });
});

describe('learn：从事故长出规则', () => {
  test('预览模式 → 退出码 0，不写文件', () => {
    const dir = tmpdir();
    const r = runCli(['learn', '--trace', EXAMPLE_TRACE], { cwd: dir });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /预览模式/);
    assert.match(r.stdout, /refund-incident-idempotent-refund-order/);
    assert.ok(!fs.existsSync(path.join(dir, 'agentguard-rules')), '预览模式不应创建规则目录');
  });

  test('--apply 写入规则，且生成的规则能反过来拦住这份事故 trace', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'agentguard-rules');
    const r1 = runCli(['learn', '--trace', EXAMPLE_TRACE, '--rules-dir', rulesDir, '--apply'], { cwd: dir });
    assert.equal(r1.code, 0);
    assert.match(r1.stdout, /已写入/);
    const files = fs.readdirSync(rulesDir).filter((f) => f.endsWith('.yaml'));
    assert.equal(files.length, 2);

    // 闭环：learn 出来的规则必须能拦住当初的事故
    const r2 = runCli(['check', '--rules', rulesDir, '--trace', EXAMPLE_TRACE]);
    assert.equal(r2.code, 1, 'learn 出的规则应当能拦住事故 trace');
    assert.match(r2.stdout, /idempotent/);
    assert.match(r2.stdout, /forbid_tool/);
  });

  test('--apply 不覆盖已存在的规则文件', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'agentguard-rules');
    runCli(['learn', '--trace', EXAMPLE_TRACE, '--rules-dir', rulesDir, '--apply'], { cwd: dir });
    const r2 = runCli(['learn', '--trace', EXAMPLE_TRACE, '--rules-dir', rulesDir, '--apply'], { cwd: dir });
    assert.equal(r2.code, 0);
    assert.match(r2.stdout, /跳过（已存在/);
  });

  test('--json 输出候选列表', () => {
    const dir = tmpdir();
    const r = runCli(['learn', '--trace', EXAMPLE_TRACE, '--json'], { cwd: dir });
    assert.equal(r.code, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.candidates.length, 2);
    assert.equal(out.candidates[0].confidence, 0.9);
  });
});

describe('export：翻译层，不抢地盘', () => {
  test('无条件规则 → 翻译为 promptfoo 原生断言；翻不过去的逐条明说', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'rules');
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(
      path.join(rulesDir, 'uncond.yaml'),
      [
        'rule: no-refund-ever',
        'then:',
        '  forbid_tool: refund_order',
        '  require_tool: check_balance',
        '  max_tool_calls: 10',
        '  allow_tool: [check_balance]',
        '  idempotent:',
        '    tool: refund_order',
        "    key: '${order_id}'",
        'where:',
        '  ci: true',
        '  runtime: false',
      ].join('\n')
    );
    const outFile = path.join(dir, 'pf.yaml');
    const r = runCli(['export', '--to', 'promptfoo', '--rules', rulesDir, '--out', outFile]);
    assert.equal(r.code, 0);
    const text = fs.readFileSync(outFile, 'utf8');
    assert.match(text, /not-trajectory:tool-used/);
    assert.match(text, /refund_order/);
    assert.match(text, /trajectory:tool-used/);
    assert.match(text, /trajectory:max-tool-calls/);
    // 翻不过去的要在 stdout 明说，而不是悄悄吞掉
    assert.match(r.stdout, /allow_tool/);
    assert.match(r.stdout, /白名单原语/);
    assert.match(r.stdout, /idempotent/);
    assert.match(r.stdout, /事务键/);
  });

  test('带 when.intent_any 的规则 → 转人工挂载', () => {
    const r = runCli(['export', '--to', 'promptfoo', '--rules', EXAMPLE_RULES, '--out', path.join(tmpdir(), 'pf.yaml')]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /需人工挂载/);
    assert.match(r.stdout, /intent_any/);
  });
});

describe('基础行为', () => {
  test('help → 退出码 0', () => {
    const r = runCli(['help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /agentguard/);
  });
  test('未知命令 → 退出码 2', () => {
    const r = runCli(['frobnicate']);
    assert.equal(r.code, 2);
  });
  test('--version', () => {
    const r = runCli(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^0\.1\.0/);
  });
});
