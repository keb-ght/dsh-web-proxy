// Anthropic Messages 兼容层：让 DSH（dsh-llm-deepseek-api-key，默认打 ${baseURL}/v1/messages）
// 和其它 Anthropic 客户端也能直接连这个反代。
//
// 只做协议翻译：Anthropic 请求 → 内部 prompt → DeepSeek Web 会话 → Anthropic 事件流。

const ANTHROPIC_VER = '2023-06-01';

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return b.text ?? '';
      if (b.type === 'thinking') return b.thinking ?? '';
      if (b.type === 'image') return '[image]';
      if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : blocksToText(b.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Anthropic messages(+system) → 我们内部的 OpenAI 风格 messages */
export function anthropicToMessages(body) {
  const out = [];
  const sys = blocksToText(body.system);
  if (sys.trim()) out.push({ role: 'system', content: sys });
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: blocksToText(m.content) });
  }
  return out;
}

const rid = () => 'msg_' + Math.random().toString(36).slice(2, 14);

function mapStopReason(reason) {
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'stop_sequence') return 'stop_sequence';
  return 'end_turn';
}

/** 非流式响应 */
export function buildMessage({ id = rid(), model, text, reasoning, usage }) {
  const content = [];
  if (reasoning) content.push({ type: 'thinking', thinking: reasoning });
  content.push({ type: 'text', text });
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
    },
  };
}

/** 流式事件序列生成器 */
export function anthropicStream({ id = rid(), model, iterator, created = () => Math.floor(Date.now() / 1000) }) {
  return (async function* () {
    const send = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    yield send('message_start', {
      type: 'message_start',
      message: {
        id, type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    // content_block 0: 正文（思考内容走独立的 thinking block，前端可忽略）
    yield send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });

    let usage = null;
    let outChars = 0;
    for await (const part of iterator) {
      if (part.reasoning) {
        // Anthropic 的 thinking block 需要 signature；这里降级为普通文本前缀，避免客户端校验失败
        yield send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.reasoning } });
      }
      if (part.content) {
        outChars += part.content.length;
        yield send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part.content } });
      }
      if (part.usage) usage = part.usage;
    }
    yield send('content_block_stop', { type: 'content_block_stop', index: 0 });
    yield send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? Math.max(1, Math.ceil(outChars / 4)),
      },
    });
    yield send('message_stop', { type: 'message_stop' });
  })();
}

export const ANTHROPIC_VERSION = ANTHROPIC_VER;
