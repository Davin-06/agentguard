// guard：运行时护栏。一个 MCP stdio 透明代理——
//   Agent 客户端 ↔ agentguard guard ↔ 真实 MCP server
// 对客户端来说它就是一个普通 MCP server；对上游服务器来说它就是一个普通客户端。
// 只拦截 tools/call：where.runtime 的规则在这里逐调用生效；其余方法原样透传。
//
// 消息格式：MCP stdio 规范的换行分隔 JSON。
//
// 已知边界（诚实声明）：
// - MCP 代理看不到用户聊天消息，when.intent_any 规则只有在调用方通过
//   tools/call 参数的 _meta.agentguard.intent 注入意图时才会生效，否则跳过（启动时告警一次）。
// - require_tool 仅在 CI 有意义，guard 忽略并告警一次。
// - max_tool_calls 在 runtime 统计的是"经过本代理的调用数"。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadRules } from './rule.js';
import { evaluateCallAtRuntime } from './engine.js';
import { normalizeArgs, resolveKeyTemplate } from './util.js';

const BLOCK_ERROR_CODE = -32001; // agentguard 拦截专用错误码

export function createGuardState() {
  return { toolCallCounts: new Map(), idempotentSeen: new Map(), callSeq: 0 };
}

/** 对单次 tools/call 做完整判定：返回 { blocked } 或 { allowed, stateUpdates } */
export function decideCall(rules, tool, args, state, intentHint, warnings) {
  for (const rule of rules) {
    if (!rule.where.runtime) continue;
    if (rule.when.intent_any.length > 0 && intentHint === undefined) {
      if (warnings && !warnings.intentWarned) {
        warnings.intentWarned = true;
        warnings.onWarn?.(
          `agentguard: ${countIntentRules(rules)} 条含 when.intent_any 的规则在 runtime 生效需要调用方在 params._meta.agentguard.intent 里提供意图提示，本次调用已跳过这些规则`
        );
      }
      continue;
    }
    const hit = evaluateCallAtRuntime(rule, tool, args, state, intentHint);
    if (hit) {
      const entry = rule.then.idempotent?.find((e) => e.tool === tool);
      const logOnly = hit.assertion === 'idempotent' && entry && entry.on_violation === 'log';
      return { blocked: !logOnly, logOnly, violation: hit };
    }
  }
  return { blocked: false };
}

/** 判定为放行后更新会话状态（计数、幂等登记） */
export function commitCall(rules, tool, args, state) {
  state.callSeq += 1;
  state.toolCallCounts.set(tool, (state.toolCallCounts.get(tool) || 0) + 1);
  for (const rule of rules) {
    if (!rule.where.runtime || !rule.then.idempotent) continue;
    for (let i = 0; i < rule.then.idempotent.length; i++) {
      const entry = rule.then.idempotent[i];
      if (entry.tool !== tool) continue;
      const kv = entry.key === '${__args__}' ? JSON.stringify(normalizeArgs(args)) : resolveKeyTemplate(entry.key, args);
      const seenKey = `${i}:${kv}`;
      if (!state.idempotentSeen.has(seenKey)) state.idempotentSeen.set(seenKey, state.callSeq);
    }
  }
}

function countIntentRules(rules) {
  return rules.filter((r) => r.where.runtime && r.when.intent_any.length > 0).length;
}

class LineFramer {
  constructor(onLine) {
    this.buf = '';
    this.onLine = onLine;
  }
  push(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }
}

export function runGuard({ rulesPath, upstream, auditFile, onWarn = () => {} }) {
  let load;
  try {
    load = loadRules(rulesPath);
  } catch (err) {
    console.error(`agentguard: 加载规则失败 —— ${err.message}`);
    console.error(`agentguard: 请确认 --rules 指向存在的规则目录/文件（可先运行 learn --apply 生成）`);
    process.exit(2);
  }
  const { rules, warnings } = load;
  for (const w of warnings) onWarn(`agentguard: ${w}`);

  // 审计预检：审计日志是合规底线，写不进去就拒绝启动（而不是静默丢审计）。
  // 必须写入真实记录做探针——Windows 上对目录 append 空字符串不会报错。
  try {
    fs.mkdirSync(path.dirname(path.resolve(auditFile)), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), decision: 'open', note: 'agentguard audit log opened' }) + '\n');
  } catch (err) {
    console.error(`agentguard: 审计日志不可写（${auditFile}）：${err.message}`);
    console.error('agentguard: 没有审计的护栏等于没有护栏 —— 已拒绝启动。请用 --audit 指定可写的路径。');
    process.exit(2);
  }
  if (rules.some((r) => r.where.runtime && r.then.require_tool)) {
    onWarn('agentguard: require_tool 仅在 CI 有意义，guard 已忽略对应的 runtime 规则');
  }
  const runtimeRules = rules.filter((r) => r.where.runtime);
  if (runtimeRules.length === 0) {
    onWarn('agentguard: 警告 —— 没有任何 where.runtime=true 的规则，护栏在空转，所有工具调用都会放行');
  }
  onWarn(`agentguard: 已加载 ${runtimeRules.length} 条 runtime 规则（共 ${rules.length} 条），上游：${upstream}`);

  const state = createGuardState();
  const guardFlags = { intentWarned: false, onWarn };
  // 审计日志里的参数做截断：真实场景参数可能巨大甚至含敏感内容，全量落盘不可取
  const auditArgs = (args) => {
    const s = JSON.stringify(args ?? {});
    if (s.length <= 300) return args ?? {};
    return { _truncated: s.slice(0, 300) + `…(共 ${s.length} 字符，完整内容请看上游日志)` };
  };
  const audit = (record) => {
    try {
      if ('args' in record) record.args = auditArgs(record.args);
      fs.appendFileSync(auditFile, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
    } catch {
      /* 审计失败不阻断代理 */
    }
  };

  // Windows 走 shell（--upstream 里的引号路径交给 cmd 解析）；POSIX 按空格切分后直接 spawn，
  // 否则整串命令会被当成单个可执行文件名导致 ENOENT
  const isWin = process.platform === 'win32';
  const [upCmd, upArgs] = isWin
    ? [upstream, []]
    : (() => {
        const parts = upstream.trim().split(/\s+/);
        return [parts[0], parts.slice(1)];
      })();
  const upstreamProc = spawn(upCmd, upArgs, { shell: isWin, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); // id -> true（本代理转发出去、等待上游响应的请求）

  const send = (stream, obj) => stream.write(JSON.stringify(obj) + '\n');

  const forwardToUpstream = new LineFramer((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      upstreamProc.stdin.write(line + '\n'); // 非 JSON 原样透传
      return;
    }
    if (msg && typeof msg === 'object' && msg.method === 'tools/call' && msg.id !== undefined) {
      handleToolsCall(msg);
      return;
    }
    // 其余请求/通知原样转发；客户端的响应也原样转发给上游
    if (msg && msg.id !== undefined && msg.method) pending.set(msg.id, true);
    send(upstreamProc.stdin, msg ?? line);
  });

  function handleToolsCall(msg) {
    const tool = msg.params?.name;
    const args = msg.params?.arguments ?? {};
    const intentHint = msg.params?._meta?.agentguard?.intent;

    if (typeof tool !== 'string') {
      send(process.stdout, {
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32602, message: 'agentguard: tools/call 缺少 params.name' },
      });
      return;
    }

    const decision = decideCall(runtimeRules, tool, args, state, intentHint, guardFlags);

    if (decision.blocked) {
      audit({ decision: 'block', tool, args, rule: decision.violation.rule, assertion: decision.violation.assertion, message: decision.violation.message });
      send(process.stdout, {
        jsonrpc: '2.0',
        id: msg.id,
        error: {
          code: BLOCK_ERROR_CODE,
          message: `agentguard: 已被规则 "${decision.violation.rule}" 拦截（${decision.violation.assertion}）：${decision.violation.message}`,
          data: decision.violation.evidence ?? {},
        },
      });
      return;
    }

    if (decision.logOnly) {
      audit({ decision: 'log', tool, args, rule: decision.violation.rule, assertion: decision.violation.assertion, message: decision.violation.message });
    }

    // 放行：登记状态、转发上游、等响应回传
    commitCall(runtimeRules, tool, args, state);
    pending.set(msg.id, true);
    audit({ decision: 'allow', tool, args });
    send(upstreamProc.stdin, msg);
  }

  const fromUpstream = new LineFramer((line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(line + '\n');
      return;
    }
    if (msg && typeof msg === 'object' && msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
      pending.delete(msg.id);
    }
    send(process.stdout, msg ?? line);
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => forwardToUpstream.push(chunk));
  process.stdin.on('end', () => {
    try { upstreamProc.stdin.end(); } catch { /* 上游可能已退出 */ }
  });
  upstreamProc.stdout.setEncoding('utf8');
  upstreamProc.stdout.on('data', (chunk) => fromUpstream.push(chunk));
  upstreamProc.stderr.setEncoding('utf8');
  upstreamProc.stderr.on('data', (chunk) => process.stderr.write(chunk));
  upstreamProc.on('exit', (code) => {
    onWarn(`agentguard: 上游已退出（code ${code}），代理随之退出`);
    process.exit(code ?? 1);
  });
  process.on('SIGINT', () => {
    try { upstreamProc.kill(); } catch { /* 忽略 */ }
    process.exit(0);
  });

  return { upstreamProc };
}
