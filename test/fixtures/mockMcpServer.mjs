// 测试用 mock MCP server：换行分隔 JSON，回显 tools/call
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === undefined) return; // 忽略响应
  let result;
  switch (msg.method) {
    case 'initialize':
      result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '0.0.1' } };
      break;
    case 'tools/list':
      result = { tools: [{ name: 'refund_order' }, { name: 'query_order' }, { name: 'other_tool' }] };
      break;
    case 'tools/call':
      result = { content: [{ type: 'text', text: 'MOCK-OK ' + JSON.stringify(msg.params?.arguments ?? {}) }] };
      break;
    default:
      result = { ok: true };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
});
