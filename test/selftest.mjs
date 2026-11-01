// 自检：不联网，验证 PoW 求解器、SSE 解析、补丁应用、prompt 拼装、工具解析
import assert from 'node:assert';
import { parseSSE, applyPatch, extractText } from '../dsp/sse.mjs';
import { messagesToPrompt, extractToolCall } from '../dsp/chat.mjs';
import { parseToolCalls } from '../dsp/tool-parser.mjs';
import { solveChallenge } from '../dsp/pow/solver.mjs';

let pass = 0;
const ok = (name) => { console.log('  ok -', name); pass++; };

// 1) PoW wasm 能装载（假挑战按预期失败）
try {
  await solveChallenge(
    { algorithm: 'DeepSeekHashV1', challenge: 'a'.repeat(32), salt: '1', difficulty: 1, signature: 's', expireAt: Date.now() + 60000 },
    { timeoutMs: 20000 },
  );
  ok('pow worker 返回答案');
} catch (e) {
  assert.match(String(e.message), /No solution found|Unsupported algorithm/, '意外错误: ' + e.message);
  ok('pow worker + wasm 已装载');
}

// 2) SSE 事件解析（跨 chunk）
const enc = new TextEncoder();
const stream = new ReadableStream({
  start(c) {
    c.enqueue(enc.encode('event: ready\ndata: {"response_message_id":2}\n\n'));
    c.enqueue(enc.encode('event: message\ndata: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"你'));
    c.enqueue(enc.encode('"}]}}}\n\n'));
    c.enqueue(enc.encode('event: close\ndata: {"close_behavior":"success"}\n\n'));
    c.close();
  },
});
const events = [];
for await (const e of parseSSE(stream)) events.push(e);
assert.deepEqual(events.map((e) => e.event), ['ready', 'message', 'close']);
ok('SSE 事件解析（跨 chunk 边界）');

// 3) 补丁应用：全量 + APPEND 简写
const state = {};
Object.assign(state, events[1].data.v);
applyPatch(state, { p: 'response/fragments/-1/content', o: 'APPEND', v: '好' });
const { content } = extractText(state);
assert.equal(content, '你好');
ok('补丁应用（p/o/v + -1 末元素）');

// 4) prompt 拼装：system 整块 + 用户消息同段 + tool 结果有边界
const prompt = messagesToPrompt([
  { role: 'system', content: '你是助手' },
  { role: 'user', content: '第一问' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
  { role: 'tool', name: 'bash', tool_call_id: 'c1', content: 'file.txt' },
  { role: 'user', content: '继续' },
]);
assert.match(prompt, /^你是助手/);
assert.match(prompt, /Assistant 调用了工具: bash/);
assert.match(prompt, /仅供阅读/);
assert.match(prompt, /继续$/);
ok('prompt 拼装（system 整块 + tool 结果边界）');

// 5) 工具解析：标记协议
const tagged = parseToolCalls('<|tool▁calls▁begin|>[{"name":"bash","arguments":{"command":"ls"}}]<|tool▁calls▁end|>');
assert.equal(tagged.calls[0].name, 'bash');
ok('工具解析（标记协议）');

// 6) 工具解析：DSML 双竖线变体
const dsml = parseToolCalls('<||DSML|| invoke name="bash"><||DSML|| parameter name="command">ls</||DSML|| parameter></||DSML|| invoke>');
assert.equal(dsml.calls[0].name, 'bash');
ok('工具解析（DSML 变体）');

// 7) 工具解析：自然格式 + 纯聊天不误判
const natural = extractToolCall('```json\n{"tool":"bash","command":"ls"}\n```', [
  { type: 'function', function: { name: 'bash', parameters: { properties: { command: { type: 'string' } }, required: ['command'] } } },
]);
assert.equal(natural.name, 'bash');
assert.equal(extractToolCall('你好呀', []), null);
ok('工具解析（自然格式 + 纯聊天不误判）');

console.log(`\n${pass} 项通过`);
