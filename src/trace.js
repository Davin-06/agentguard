// AgentGuard trace 格式（v1）加载与校验
//
// {
//   "trace_version": 1,
//   "name": "refund-incident",
//   "sessions": [
//     { "id": "chat-001",
//       "events": [
//         { "type": "user", "text": "..." },
//         { "type": "assistant", "text": "..." },
//         { "type": "tool_call", "id": "c1", "tool": "refund_order", "args": {...} },
//         { "type": "tool_result", "call_id": "c1", "ok": true, "text": "..." }
//       ] }
//   ]
// }
//
// 事件序号（turn）从 1 开始，即事件在 events 数组中的位置。

import fs from 'node:fs';

/** 校验并归一化 trace。有问题抛 Error。 */
export function parseTrace(doc, sourceFile = '<memory>') {
  if (!doc || typeof doc !== 'object') throw new Error(`${sourceFile}: trace 必须是 JSON 对象`);
  if (doc.trace_version !== 1) {
    throw new Error(`${sourceFile}: trace_version 必须是 1（当前只支持 v1 格式）`);
  }
  const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : 'trace';
  if (!Array.isArray(doc.sessions) || doc.sessions.length === 0) {
    throw new Error(`${sourceFile}: sessions 必须是非空数组`);
  }

  const sessions = doc.sessions.map((s, si) => {
    if (!s || typeof s !== 'object') throw new Error(`${sourceFile}: sessions[${si}] 必须是对象`);
    if (!Array.isArray(s.events)) throw new Error(`${sourceFile}: sessions[${si}].events 必须是数组`);
    const id = typeof s.id === 'string' && s.id ? s.id : `session-${si + 1}`;

    const events = s.events.map((e, ei) => {
      const turn = ei + 1;
      if (!e || typeof e !== 'object') throw new Error(`${sourceFile}: sessions[${si}].events[${ei}] 必须是对象`);
      switch (e.type) {
        case 'user':
        case 'assistant':
          return { type: e.type, turn, text: typeof e.text === 'string' ? e.text : '' };
        case 'tool_call':
          if (typeof e.tool !== 'string' || !e.tool) {
            throw new Error(`${sourceFile}: sessions[${si}].events[${ei}] tool_call 缺少 tool 字段`);
          }
          return {
            type: 'tool_call',
            turn,
            callId: typeof e.id === 'string' ? e.id : `call-${turn}`,
            tool: e.tool,
            args: e.args === undefined ? {} : e.args,
          };
        case 'tool_result':
          return {
            type: 'tool_result',
            turn,
            callId: typeof e.call_id === 'string' ? e.call_id : '',
            ok: e.ok !== false,
            text: typeof e.text === 'string' ? e.text : '',
          };
        default:
          throw new Error(
            `${sourceFile}: sessions[${si}].events[${ei}] 的 type "${e.type}" 不识别（支持 user/assistant/tool_call/tool_result）`
          );
      }
    });

    return { id, events };
  });

  return { traceVersion: 1, name, sessions, sourceFile };
}

export function loadTrace(file) {
  let text = fs.readFileSync(file, 'utf8');
  // Windows 工具导出的 JSON 常带 BOM，JSON.parse 会直接炸，这里静默剥掉
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file}: 不是合法的 JSON（${err.message}）`);
  }
  return parseTrace(doc, file);
}

/** session 的全部用户消息（小写拼接），供 intent 匹配 */
export function userTexts(session) {
  return session.events.filter((e) => e.type === 'user').map((e) => e.text.toLowerCase());
}
