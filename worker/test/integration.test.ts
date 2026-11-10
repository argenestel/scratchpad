import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyD1Migrations, env, runDurableObjectAlarm, SELF } from 'cloudflare:test';
import type { Bindings, Note } from '../src/types.js';

const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: D1Migration[] };
let cookie = '';
function request(path: string, method = 'GET', body?: unknown, authenticated = true) {
  return SELF.fetch('https://scratchpad.test' + path, {
    method,
    headers: { ...(authenticated ? { cookie } : {}), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(path: string, method = 'GET', body?: unknown) {
  const response = await request(path, method, body);
  expect(response.status).toBe(200);
  return response.json() as Promise<any>;
}
async function note(content = 'A design document about queues and failure modes.') {
  return (await json('/api/notes', 'POST', { content })).note as Note;
}
function provider(text: string) {
  const events = [
    { type: 'response.reasoning_summary_text.delta', delta: 'Considering the note.' },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed' },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  providerQueue.push(events);
}

/** Queued provider responses; any other outbound request fails (no real network in tests). */
const providerQueue: string[] = [];
async function stubFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = input instanceof Request ? input.url : String(input);
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (url === 'https://api.openai.com/v1/responses' && method === 'POST') {
    const body = providerQueue.shift();
    if (body === undefined) throw new Error('Unexpected provider request');
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }
  throw new Error(`Network disabled in tests: ${method} ${url}`);
}
async function framesUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
) {
  let text = '';
  const decoder = new TextDecoder();
  for (let i = 0; i < 100; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (predicate(text)) return text;
  }
  throw new Error('Expected SSE frames were not received');
}

beforeAll(async () => {
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS.slice(0, 1));
  await bindings.DB.prepare("INSERT INTO users(id,auth_method) VALUES('legacy','apikey')").run();
  await bindings.DB.prepare('INSERT INTO user_settings(user_id,data) VALUES(?,?)')
    .bind('legacy', JSON.stringify({ model: 'legacy-model', askStyle: 'block' }))
    .run();
  await applyD1Migrations(bindings.DB, bindings.TEST_MIGRATIONS);
  vi.stubGlobal('fetch', stubFetch);
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => expect(providerQueue).toHaveLength(0));
beforeEach(async () => {
  const response = await request('/api/auth/apikey', 'POST', {}, false);
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  await response.json();
});

describe('native Workers contract', () => {
  it('health and anonymous authorization', async () => {
    expect(await (await request('/api/health', 'GET', undefined, false)).json()).toEqual({ ok: true });
    for (const path of ['/api/notes', '/api/riddlers', '/api/settings', '/api/models']) {
      expect((await request(path, 'GET', undefined, false)).status).toBe(401);
    }
    const me = await json('/api/auth/me');
    expect(me.methods).toEqual({ browser: false, device: true, codexImport: false, apiKey: true });
    expect((await request('/api/auth/chatgpt/start', 'POST', {})).status).toBe(404);
    expect((await request('/api/auth/codex-import', 'POST', {})).status).toBe(404);
  });
  it('note CRUD and strict validation', async () => {
    const n = await note();
    expect((await json('/api/notes')).notes.map((n: Note) => n.id)).toContain(n.id);
    expect((await json(`/api/notes/${n.id}`)).annotations).toEqual([]);
    const updated = (await json(`/api/notes/${n.id}`, 'PATCH', { title: 'Queues', mode: 'ask' })).note;
    expect(updated.title).toBe('Queues');
    expect(updated.createdAt).toBe(n.createdAt);
    expect((await request(`/api/notes/${n.id}`, 'PATCH', { id: 'different' })).status).toBe(400);
    await json(`/api/notes/${n.id}`, 'DELETE');
    expect((await request(`/api/notes/${n.id}`)).status).toBe(404);
  });
  it('migrates existing settings without losing preferences', async () => {
    const row = await bindings.DB.prepare("SELECT data FROM user_settings WHERE user_id='legacy'").first<{
      data: string;
    }>();
    expect(JSON.parse(row!.data)).toEqual({
      model: 'legacy-model',
      askStyle: 'block',
      readAlongStyle: 'comment',
    });
  });
  it('settings GET/PATCH/PUT and model effort clamping', async () => {
    expect((await json('/api/settings')).settings).toMatchObject({
      askStyle: 'comment',
      readAlongStyle: 'comment',
    });
    expect(
      (await json('/api/settings', 'PATCH', { askStyle: 'block', readAlongStyle: 'block' })).settings,
    ).toMatchObject({ askStyle: 'block', readAlongStyle: 'block' });
    expect((await json('/api/settings')).settings).toMatchObject({
      askStyle: 'block',
      readAlongStyle: 'block',
    });
    for (const field of ['askStyle', 'readAlongStyle']) {
      expect((await request('/api/settings', 'PATCH', { [field]: 'invalid' })).status).toBe(400);
      expect((await request('/api/settings', 'PATCH', { [field]: null })).status).toBe(400);
    }
    await json('/api/settings', 'PATCH', { askStyle: 'comment', readAlongStyle: 'comment' });
    expect((await json('/api/settings')).settings.model).toBe('gpt-6.1-sol');
    const settings = (await json('/api/settings', 'PUT', { effort: 'unsupported', summary: 'off' })).settings;
    expect(settings.effort).toBe('medium');
    expect(settings.summary).toBe('off');
    await json('/api/settings', 'PATCH', { backgroundModel: 'another-model', backgroundEffort: 'high' });
    expect((await json('/api/settings')).settings.backgroundEffort).toBe('high');
    expect((await request('/api/settings', 'PATCH', { unknown: true })).status).toBe(400);
  });
  it('seeds five builtins once and preserves deletion', async () => {
    const { riddlers } = await json('/api/riddlers');
    expect(riddlers).toHaveLength(5);
    await json(`/api/riddlers/${riddlers[0].id}`, 'DELETE');
    expect((await json('/api/riddlers')).riddlers).toHaveLength(4);
  });
  it('streams ask, persists annotation, patches it, and replies', async () => {
    const n = await note();
    provider('Consider a dead-letter queue.');
    const response = await request(`/api/notes/${n.id}/ask`, 'POST', {
      prompt: 'Review it',
      selection: 'queues',
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const stream = await response.text();
    for (const event of ['thinking', 'text', 'annotation', 'done'])
      expect(stream).toContain(`event: ${event}`);
    const statuses = stream
      .split('\n\n')
      .filter((f) => f.startsWith('event: status'))
      .map((f) => JSON.parse(f.split('data: ')[1]));
    expect(statuses[0]).toMatchObject({ phase: 'reading', model: 'gpt-6.1-sol', effort: 'medium' });
    const a = (await json(`/api/notes/${n.id}`)).annotations[0];
    expect(a.body).toBe('Consider a dead-letter queue.');
    expect((await json(`/api/annotations/${a.id}`, 'PATCH', { status: 'resolved' })).annotation.status).toBe(
      'resolved',
    );
    provider('Use bounded retries.');
    expect(
      await (await request(`/api/annotations/${a.id}/reply`, 'POST', { text: 'What about retries?' })).text(),
    ).toContain('event: done');
    expect((await json(`/api/notes/${n.id}`)).annotations[0].replies).toHaveLength(2);
  });
  it('streams a sanitized mindmap and retries invalid output before an outline fallback', async () => {
    const n = await note();
    const valid = '```mermaid\nmindmap\n  root((Queues))\n    Retry\n```';
    const dirty = '```mermaid\nmindmap\n  root((Queues:))\n    "Retry" [safe]\n```';
    for (const scenario of [
      { outputs: [valid], body: valid },
      { outputs: [dirty], body: '```mermaid\nmindmap\n  root((Queues))\n    Retry safe\n```' },
      { outputs: ['invalid', valid], body: valid },
      { outputs: ['invalid', '```mermaid\nflowchart LR\n A-->B\n```'], body: '- queues' },
    ]) {
      for (const output of scenario.outputs) provider(output);
      const stream = await (
        await request(`/api/notes/${n.id}/ask`, 'POST', {
          prompt: 'Map this',
          action: 'mindmap',
          selection: 'queues',
        })
      ).text();
      expect(stream).toContain('"phase":"drawing"');
      expect(stream).not.toContain('"phase":"writing"');
      expect(stream).toContain('event: done');
      const frames = stream.split('\n\n').filter((f) => f.startsWith('event: annotation'));
      expect(frames).toHaveLength(1);
      const a = JSON.parse(frames[0].split('data: ')[1]).annotation;
      expect(a).toMatchObject({
        kind: 'explain',
        body: scenario.body,
        anchor: 'queues',
        drawing: null,
        status: 'open',
      });
      expect(
        (await json(`/api/notes/${n.id}`)).annotations.find((saved: any) => saved.id === a.id).body,
      ).toBe(scenario.body);
    }
  });
  it('receives a Durable Object background run through the events endpoint', async () => {
    const n = await note();
    const response = await request(`/api/notes/${n.id}/events`);
    const reader = response.body!.getReader();
    try {
      await framesUntil(reader, (text) => text.includes('event: ping'));
      provider(
        JSON.stringify({
          speak: true,
          kind: 'question',
          anchor: 'queues',
          body: 'How do retries terminate?',
          drawing: null,
        }),
      );
      expect((await json(`/api/notes/${n.id}/nudge`, 'POST', {})).queued).toBe(true);
      const stub = bindings.NOTE_ROOM.get(bindings.NOTE_ROOM.idFromName(n.id));
      // Drain concurrently so streaming backpressure cannot stall the alarm.
      const frames = framesUntil(reader, (text) => text.includes('"state":"idle"'));
      await runDurableObjectAlarm(stub);
      const text = await frames;
      const events = text
        .split('\n\n')
        .filter(Boolean)
        .map((frame) => ({
          event: frame.split('\n')[0].slice(7),
          data: JSON.parse(frame.split('data: ')[1]),
        }));
      const runs = events.filter((e) => e.event !== 'ping');
      expect(new Set(runs.map((e) => e.data.runId)).size).toBe(1);
      expect(runs[0].data.runId).toBeTruthy();
      expect(runs.filter((e) => e.event === 'status' && e.data.state === 'idle')).toHaveLength(1);
      expect(runs.find((e) => e.event === 'annotation')?.data.annotation.body).toBe(
        'How do retries terminate?',
      );
      expect((await json(`/api/notes/${n.id}/nudge`, 'POST', {})).queued).toBe(false);
    } finally {
      await reader.cancel();
    }
  });
});
