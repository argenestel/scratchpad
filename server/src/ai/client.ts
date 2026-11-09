import { authHeaders } from './auth-headers.js';
import { getCredentials } from '../auth.js';
import type { Emit, AIOptions } from '../types.js';
export async function response(
  uid: string,
  instructions: string,
  input: string,
  emit: Emit,
  options: AIOptions,
  format?: Record<string, unknown>,
  signal?: AbortSignal,
) {
  let credentials = await getCredentials(uid),
    useFormat = !!format,
    refreshed = false;
  const controller = AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
  let res: Response;
  for (;;) {
    const headers = authHeaders(credentials);
    await emit('status', { state: 'thinking', phase: 'thinking' });
    res = await fetch(
      credentials.authMethod === 'chatgpt'
        ? 'https://chatgpt.com/backend-api/codex/responses'
        : 'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: options.model,
          stream: true,
          store: false,
          instructions,
          input: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
          reasoning: {
            effort: options.effort,
            ...(options.summary === 'off' ? {} : { summary: options.summary }),
          },
          include: ['reasoning.encrypted_content'],
          ...(useFormat ? { text: { format } } : {}),
        }),
        signal: controller,
      },
    );
    if (res.status === 401 && !refreshed && credentials.authMethod === 'chatgpt') {
      await res.body?.cancel();
      credentials = await getCredentials(uid, true, credentials.access);
      refreshed = true;
      continue;
    }
    if ((res.status === 400 || res.status === 422) && useFormat) {
      await res.body?.cancel();
      useFormat = false;
      continue;
    }
    break;
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`AI request failed (${res.status}); check your account and model access`);
  }
  if (!res.body) throw new Error('AI returned no stream');
  let text = '',
    thinking = '',
    buffer = '',
    completed = false;
  async function frame(raw: string) {
    const data = raw
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const e = JSON.parse(data);
    if (e.type === 'response.reasoning_summary_text.delta') {
      thinking += e.delta;
      await emit('thinking', { delta: e.delta });
    } else if (e.type === 'response.output_text.delta') {
      if (!text) await emit('status', { state: 'writing' });
      text += e.delta;
      await emit('text', { delta: e.delta });
    } else if (e.type === 'response.completed') {
      completed = true;
      if (!text) {
        for (const o of e.response?.output || [])
          for (const c of o.content || []) if (c.type === 'output_text') text += c.text;
        if (text) {
          await emit('status', { state: 'writing' });
          await emit('text', { delta: text });
        }
      }
    } else if (['response.failed', 'response.incomplete', 'error'].includes(e.type))
      throw new Error('AI response could not be completed');
  }
  const reader = res.body.getReader(),
    decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        await frame(raw);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) await frame(buffer);
    if (!completed) throw new Error('AI stream ended before completion');
    return { text, thinking };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
