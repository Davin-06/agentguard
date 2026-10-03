// 针对审查修复的回归测试
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadRules } from '../src/rule.js';
import { normalizeArgs, argsEqual } from '../src/util.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const EXAMPLE_TRACE = path.join(ROOT, 'examples', 'traces', 'refund_incident.json');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentguard-fix-'));
}

describe('修复回归：规则目录递归（Node 18.16 无 readdir recursive 选项）', () => {
  test('子目录里的规则文件也要被加载到', () => {
    const dir = tmpdir();
    fs.mkdirSync(path.join(dir, 'team-a'));
    fs.mkdirSync(path.join(dir, 'team-a', 'nested'));
    fs.writeFileSync(
      path.join(dir, 'top.yaml'),
      ['rule: top-rule', 'then:', '  forbid_tool: tool_x', 'where:', '  ci: true', '  runtime: false'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'team-a', 'mid.yaml'),
      ['rule: mid-rule', 'then:', '  forbid_tool: tool_y', 'where:', '  ci: true', '  runtime: false'].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'team-a', 'nested', 'deep.yaml'),
      ['rule: deep-rule', 'then:', '  forbid_tool: tool_z', 'where:', '  ci: true', '  runtime: false'].join('\n')
    );
    const { rules } = loadRules(dir);
    const names = rules.map((r) => r.rule).sort();
    assert.deepEqual(names, ['deep-rule', 'mid-rule', 'top-rule']);
  });
});

describe('修复回归：嵌套参数键序不影响判等', () => {
  test('normalizeArgs 递归排序键', () => {
    const a = { order_id: 'A1', meta: { channel: 'app', uid: 9 } };
    const b = { meta: { uid: 9, channel: 'app' }, order_id: 'A1' };
    assert.deepEqual(normalizeArgs(a), normalizeArgs(b));
    assert.equal(argsEqual(a, b), true);
  });
  test('嵌套内容不同仍要区分', () => {
    assert.equal(argsEqual({ m: { a: 1 } }, { m: { a: 2 } }), false);
  });
});

describe('修复回归：check 支持 trace 目录', () => {
  test('目录下多份 trace 一起评估，任何一份违规即退出码 1', () => {
    const dir = tmpdir();
    // good.json 合规、bad.json 直接复用事故 trace
    fs.writeFileSync(
      path.join(dir, 'good.json'),
      JSON.stringify({
        trace_version: 1,
        name: 'good',
        sessions: [{ id: 's1', events: [{ type: 'tool_call', id: 'c1', tool: 'query_order', args: {} }] }],
      })
    );
    fs.copyFileSync(EXAMPLE_TRACE, path.join(dir, 'bad.json'));
    const r = spawnSync(process.execPath, [CLI, 'check', '--rules', path.join(ROOT, 'examples', 'rules'), '--trace', dir], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /good/);
    assert.match(r.stdout, /refund-incident/);
    assert.match(r.stdout, /2 份 trace/);
  });
  test('全合规目录 → 退出码 0', () => {
    const dir = tmpdir();
    fs.writeFileSync(
      path.join(dir, 'ok.json'),
      JSON.stringify({
        trace_version: 1,
        name: 'ok',
        sessions: [{ id: 's1', events: [{ type: 'tool_call', id: 'c1', tool: 'query_order', args: {} }] }],
      })
    );
    const r = spawnSync(process.execPath, [CLI, 'check', '--rules', path.join(ROOT, 'examples', 'rules'), '--trace', dir], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 0);
  });
});

describe('修复回归：require_tool 多工具 any-of 语义导出转人工', () => {
  test('单工具 require 照常翻译；多工具 require 不再生成语义反转的断言', () => {
    const dir = tmpdir();
    const rulesDir = path.join(dir, 'rules');
    fs.mkdirSync(rulesDir);
    fs.writeFileSync(
      path.join(rulesDir, 'r.yaml'),
      [
        'rule: single-require',
        'then:',
        '  require_tool: check_balance',
        'where:',
        '  ci: true',
        '  runtime: false',
        '---',
        'rule: multi-require',
        'then:',
        '  require_tool: [check_balance, check_risk]',
        'where:',
        '  ci: true',
        '  runtime: false',
      ].join('\n')
    );
    const outFile = path.join(dir, 'pf.yaml');
    const r = spawnSync(process.execPath, [CLI, 'export', '--to', 'promptfoo', '--rules', rulesDir, '--out', outFile], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 0);
    const text = fs.readFileSync(outFile, 'utf8');
    assert.match(text, /trajectory:tool-used/); // 单工具的翻译了
    assert.match(r.stdout, /any-of/); // 多工具的转人工并说明原因
    assert.match(r.stdout, /multi-require/);
    // 确保没有为 check_risk 生成第二条断言（语义反转）
    const used = [...text.matchAll(/value: (\w+)/g)].map((m) => m[1]);
    assert.ok(!used.includes('check_risk'), 'multi-require 不应生成 check_risk 断言');
  });
});

describe('修复回归：拼错参数名给警告', () => {
  test('未识别参数输出警告且不影响执行', () => {
    const r = spawnSync(process.execPath, [CLI, 'check', '--rulez', 'oops', '--rules', path.join(ROOT, 'examples', 'rules'), '--trace', EXAMPLE_TRACE], {
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /未识别的参数 --rulez/);
  });
});
