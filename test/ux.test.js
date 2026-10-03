// 新用户首次体验的回归测试：模拟真实上手路径里的每个硌手点
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

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-ux-'));
}

function runCli(args, opts = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || ROOT,
    timeout: 30000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

describe('新用户旅程：求助路径', () => {
  test('check --help 给帮助而不是报错', () => {
    const r = runCli(['check', '--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /用法/);
    assert.match(r.stdout, /agentguard check/);
  });
  test('guard -h 同样给帮助', () => {
    const r = runCli(['guard', '-h']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /upstream/);
  });
});

describe('新用户旅程：init 一键脚手架', () => {
  test('init 生成示例规则与 trace，check 能直接跑通整个故事', () => {
    const dir = tmpdir();
    const r1 = runCli(['init'], { cwd: dir });
    assert.equal(r1.code, 0);
    assert.match(r1.stdout, /已生成/);
    assert.match(r1.stdout, /下一步/);
    assert.ok(fs.existsSync(path.join(dir, 'agentguard-rules', 'example-refund-safety.yaml')));
    assert.ok(fs.existsSync(path.join(dir, 'traces', 'example-incident.json')));

    // 新生成的示例自洽：check 立刻能跑并抓到示例事故
    const r2 = runCli(['check', '--rules', 'agentguard-rules', '--trace', 'traces'], { cwd: dir });
    assert.equal(r2.code, 1);
    assert.match(r2.stdout, /example-refund-safety/);
    assert.match(r2.stdout, /idempotent/);
  });

  test('init 幂等：已有文件不覆盖', () => {
    const dir = tmpdir();
    runCli(['init'], { cwd: dir });
    const ruleFile = path.join(dir, 'agentguard-rules', 'example-refund-safety.yaml');
    fs.writeFileSync(ruleFile, '# 用户自己的修改', 'utf8');
    const r2 = runCli(['init'], { cwd: dir });
    assert.equal(r2.code, 0);
    assert.match(r2.stdout, /跳过（已存在/);
    assert.equal(fs.readFileSync(ruleFile, 'utf8'), '# 用户自己的修改', '不应覆盖用户已修改的文件');
  });
});

describe('新用户旅程：参数解析', () => {
  test('--runtime=false 是明确的否定，不应被当真值字符串', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'rules');
    const r = runCli(['learn', '--trace', EXAMPLE_TRACE, '--rules-dir', rulesDir, '--runtime=false', '--apply']);
    assert.equal(r.code, 0);
    const text = fs.readFileSync(path.join(rulesDir, 'refund-incident-idempotent-refund-order.yaml'), 'utf8');
    assert.match(text, /ci: true/);
    assert.match(text, /runtime: true/);
  });
  test('--runtime=true 生效为 runtime-only', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'rules');
    runCli(['learn', '--trace', EXAMPLE_TRACE, '--rules-dir', rulesDir, '--runtime=true', '--apply']);
    const text = fs.readFileSync(path.join(rulesDir, 'refund-incident-idempotent-refund-order.yaml'), 'utf8');
    assert.match(text, /ci: false/);
    assert.match(text, /runtime: true/);
  });
});

describe('新用户旅程：trace 文件兼容性', () => {
  test('带 BOM 的 trace（Windows 工具导出常态）能正常加载', () => {
    const dir = tmpdir();
    const bomFile = path.join(dir, 'bom.json');
    fs.writeFileSync(bomFile, '﻿' + fs.readFileSync(EXAMPLE_TRACE, 'utf8'), 'utf8');
    const r = runCli(['check', '--rules', path.join(ROOT, 'examples', 'rules'), '--trace', bomFile]);
    assert.equal(r.code, 1, 'BOM trace 应被正常评估（事故被照常抓到）');
    assert.match(r.stdout, /refund-safety/);
  });
});

describe('新用户旅程：护栏空转要有警告', () => {
  test('所有规则 where.ci=false 时 check 给出明确警告（而不是静默通过）', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'rules');
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(
      path.join(rulesDir, 'runtime-only.yaml'),
      ['rule: never-in-ci', 'then:', '  forbid_tool: refund_order', 'where:', '  ci: false', '  runtime: true'].join('\n')
    );
    const r = runCli(['check', '--rules', rulesDir, '--trace', EXAMPLE_TRACE]);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /护栏空转/);
  });
});

describe('新用户旅程：违规输出可读性', () => {
  test('违规行带参数预览，用户不用翻 trace 就知道发生了什么', () => {
    const r = runCli(['check', '--rules', path.join(ROOT, 'examples', 'rules'), '--trace', EXAMPLE_TRACE]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /order_id/);
    assert.match(r.stdout, /--json/);
  });
});
