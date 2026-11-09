import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const tmp = await mkdtemp(path.join(os.tmpdir(), 'scratchpad-smoke-'));
process.env.NODE_ENV = 'test';
process.env.DEFAULT_MODEL = 'smoke-default';
process.env.REASONING_EFFORT = 'medium';
process.env.REASONING_SUMMARY = 'concise';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.WEB_DIST = path.join(tmp, 'web');
process.env.APP_SECRET = 'smoke-only-secret-0123456789abcdefghijklmnop';
process.env.OPENAI_API_KEY = '';
process.env.CODEX_AUTH_FILE = '';
await import('node:fs/promises').then((fs) => fs.mkdir(path.join(tmp, 'web'), { recursive: true }));
const { app } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const base = 'http://localhost';
let checks = 0;
const originalFetch = globalThis.fetch;
const modelOutputs: Array<string | number> = [];
let expectedModel = 'smoke-default';
let expectedReasoning: Record<string, string> = { effort: 'medium', summary: 'concise' };
let discoveryCalls = 0;
const discoveryOutputs: Array<number | object> = [];
const liveModels = {
  models: [
    {
      slug: 'smoke-default',
      display_name: 'Default model',
      description: 'For writing',
      visibility: 'list',
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [
        { effort: 'medium', description: 'Balanced' },
        { effort: 'high', description: 'Thorough' },
      ],
    },
    {
      slug: 'smoke-background',
      display_name: 'Reader',
      description: 'For reading',
      visibility: 'list',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [
        { effort: 'low', description: 'Quick' },
        { effort: 'ultra', description: 'Deep' },
      ],
    },
    {
      slug: 'hidden-model',
      display_name: 'Hidden',
      description: '',
      visibility: 'hide',
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low', description: '' }],
    },
  ],
};
let modelCalls = 0,
  refreshCalls = 0;
const fakeJWT = (claims: Record<string, unknown>) =>
  'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
const fakeAccount = 'smoke-chatgpt-account';
function fakeAccess() {
  return fakeJWT({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: fakeAccount, chatgpt_plan_type: 'plus' },
    nonce: refreshCalls,
  });
}
globalThis.fetch = async (url, init) => {
  if (String(url) === 'https://auth.openai.com/oauth/token') {
    refreshCalls++;
    await Promise.resolve();
    assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'), 'refresh_token');
    return Response.json({
      access_token: fakeAccess(),
      refresh_token: 'smoke-rotated-refresh',
      expires_in: 3600,
    });
  }
  if (String(url) === 'https://chatgpt.com/backend-api/codex/models?client_version=0.166.0') {
    discoveryCalls++;
    const headers = new Headers(init?.headers);
    assert.match(headers.get('Authorization')!, /^Bearer /);
    assert.equal(headers.get('ChatGPT-Account-Id'), fakeAccount);
    const next = discoveryOutputs.shift() ?? liveModels;
    return typeof next === 'number' ? new Response('{}', { status: next }) : Response.json(next);
  }
  assert.match(
    String(url),
    /^https:\/\/(?:api\.openai\.com\/v1|chatgpt\.com\/backend-api\/codex)\/responses$/,
  );
  const data = JSON.parse(String(init?.body));
  assert.equal(data.stream, true);
  assert.equal(data.store, false);
  assert.match(data.instructions, /GFM Markdown/);
  assert.match(data.instructions, /language tag/);
  assert.match(data.instructions, /stateDiagram-v2/);
  assert.deepEqual(data.include, ['reasoning.encrypted_content']);
  assert.equal(data.model, expectedModel);
  assert.deepEqual(data.reasoning, expectedReasoning);
  modelCalls++;
  const next = modelOutputs.shift();
  assert.notEqual(next, undefined, 'Unexpected model request');
  if (typeof next === 'number') return new Response('{}', { status: next });
  const frames = [
    { type: 'response.reasoning_summary_text.delta', delta: 'A brief reasoning summary.' },
    { type: 'response.output_text.delta', delta: next },
    { type: 'response.completed', response: { output: [] } },
  ]
    .map((event) => 'data: ' + JSON.stringify(event) + '\r\n\r\n')
    .join('');
  const bytes = new TextEncoder().encode(frames);
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13));
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
};
function events(raw: string) {
  return raw
    .trim()
    .split('\n\n')
    .map((frame) => ({
      event: frame
        .split('\n')
        .find((l) => l.startsWith('event:'))
        ?.slice(6)
        .trim(),
      data: JSON.parse(
        frame
          .split('\n')
          .find((l) => l.startsWith('data:'))!
          .slice(5),
      ),
    }));
}

function checkStatuses(
  received: ReturnType<typeof events>,
  model = expectedModel,
  effort = expectedReasoning.effort,
) {
  const statuses = received.filter((e) => e.event === 'status');
  assert.ok(statuses.length >= 2);
  assert.equal(received[0].event, 'status');
  assert.equal(statuses[0].data.state, 'thinking');
  assert.equal(statuses[0].data.phase, 'reading');
  for (const { data } of statuses) {
    assert.equal(data.model, model);
    assert.equal(data.effort, effort);
    assert.ok(['reading', 'thinking', 'writing', 'drawing', 'done'].includes(data.phase));
  }
  assert.equal(statuses.at(-1)!.data.phase, 'done');
  checks++;
}

async function request(
  base: string,
  url: string,
  method = 'GET',
  payload?: unknown,
  cookie?: string,
  expected = 200,
) {
  const res = await app.request(base + url, {
    method,
    headers: {
      ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  assert.equal(res.status, expected, `${method} ${url}: ${await res.clone().text()}`);
  checks++;
  return res;
}
try {
  await import('node:fs/promises').then((fs) => fs.mkdir(path.join(tmp, 'web'), { recursive: true }));
  await writeFile(path.join(tmp, 'web', 'index.html'), '<html>scratchpad smoke SPA</html>');
  assert.deepEqual(await (await request(base, '/api/health')).json(), { ok: true });
  await request(base, '/api/notes', 'GET', undefined, undefined, 401);
  const login = await request(base, '/api/auth/test-session', 'POST', {});
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/i);
  assert.match(login.headers.get('set-cookie')!, /SameSite=Lax/i);
  const me = await (await request(base, '/api/auth/me', 'GET', undefined, cookie)).json();
  assert.ok(me.user.id);
  await request(base, '/api/settings', 'GET', undefined, undefined, 401);
  await request(base, '/api/models', 'GET', undefined, undefined, 401);
  const defaults = {
    model: 'smoke-default',
    effort: 'medium',
    summary: 'concise',
    backgroundModel: null,
    backgroundEffort: null,
  };
  assert.deepEqual(
    (await (await request(base, '/api/settings', 'GET', undefined, cookie)).json()).settings,
    defaults,
  );
  assert.deepEqual(await (await request(base, '/api/models', 'GET', undefined, cookie)).json(), {
    models: [
      {
        id: 'smoke-default',
        name: 'smoke-default',
        description: '',
        defaultEffort: 'medium',
        efforts: ['low', 'medium', 'high'],
      },
    ],
    source: 'fallback',
  });
  assert.equal(discoveryCalls, 0);
  const changed = (
    await (
      await request(base, '/api/settings', 'PATCH', { effort: 'ultra', backgroundEffort: 'max' }, cookie)
    ).json()
  ).settings;
  assert.deepEqual(changed, { ...defaults, backgroundEffort: 'medium' });
  await request(base, '/api/settings', 'PATCH', { summary: 'invalid' }, cookie, 400);
  await request(base, '/api/settings', 'PATCH', { model: '' }, cookie, 400);
  await request(base, '/api/settings', 'PATCH', { surprise: true }, cookie, 400);
  await request(base, '/api/settings', 'PATCH', { backgroundEffort: null }, cookie);

  const { note } = await (
    await request(
      base,
      '/api/notes',
      'POST',
      { title: 'Smoke', content: 'My original notes', purpose: 'just listen' },
      cookie,
    )
  ).json();
  assert.equal(note.mode, 'thinks');
  assert.deepEqual(note.riddlerIds, []);
  assert.equal(
    (await (await request(base, '/api/notes', 'GET', undefined, cookie)).json()).notes[0].id,
    note.id,
  );
  assert.equal(
    (await (await request(base, `/api/notes/${note.id}`, 'GET', undefined, cookie)).json()).note.content,
    'My original notes',
  );
  assert.equal(
    (
      await (
        await request(
          base,
          `/api/notes/${note.id}`,
          'PATCH',
          { content: 'Edited by the writer', mode: 'ask', inkColor: '#123456' },
          cookie,
        )
      ).json()
    ).note.content,
    'Edited by the writer',
  );
  await request(base, `/api/notes/${note.id}/nudge`, 'POST', {}, cookie);
  const builtins = (await (await request(base, '/api/riddlers', 'GET', undefined, cookie)).json()).riddlers;
  assert.deepEqual(
    builtins.map((r: any) => r.name),
    ['Staff Engineer', 'Editor', 'Investor', 'Professor', 'Skeptic'],
  );
  const { riddler } = await (
    await request(
      base,
      '/api/riddlers',
      'POST',
      { name: 'Tester', persona: 'Ask test questions', color: '#123456' },
      cookie,
    )
  ).json();
  await request(base, `/api/riddlers/${riddler.id}`, 'PATCH', { name: 'Tester 2' }, cookie);
  await request(base, `/api/notes/${note.id}`, 'PATCH', { riddlerIds: [riddler.id] }, cookie);
  const other = await request(base, '/api/auth/test-session', 'POST', { identity: 'other' });
  const otherCookie = other.headers.get('set-cookie')!.split(';')[0];
  await request(base, '/api/settings', 'PATCH', { effort: 'high', summary: 'detailed' }, cookie);
  assert.deepEqual(
    (await (await request(base, '/api/settings', 'GET', undefined, otherCookie)).json()).settings,
    defaults,
  );
  const persistedSettings = db.prepare('SELECT data FROM user_settings WHERE user_id=?').get(me.user.id) as {
    data: string;
  };
  assert.equal(JSON.parse(persistedSettings.data).summary, 'detailed');
  assert.deepEqual(
    (await (await request(base, '/api/notes', 'GET', undefined, otherCookie)).json()).notes,
    [],
  );
  for (const method of ['GET', 'PATCH', 'DELETE'])
    await request(
      base,
      `/api/notes/${note.id}`,
      method,
      method === 'PATCH' ? { title: 'stolen' } : undefined,
      otherCookie,
      404,
    );
  await request(base, `/api/riddlers/${riddler.id}`, 'DELETE', undefined, otherCookie, 404);
  await request(base, '/api/notes', 'POST', { mode: 'invalid' }, cookie, 400);
  await request(base, `/api/notes/${note.id}`, 'PATCH', { riddlerIds: ['nonexistent'] }, cookie, 404);
  await request(base, '/api/annotations/missing', 'PATCH', { status: 'resolved' }, cookie, 404);
  await request(base, `/api/riddlers/${riddler.id}`, 'DELETE', undefined, cookie);
  assert.deepEqual(
    (await (await request(base, `/api/notes/${note.id}`, 'GET', undefined, cookie)).json()).note.riddlerIds,
    [],
  );
  const stream = await app.request(base + `/api/notes/${note.id}/events`, { headers: { Cookie: cookie } });
  assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ping/);
  await reader.cancel();
  checks++;

  // All model traffic below is intercepted by the local fetch mock above.
  const { config } = await import('../src/config.js');
  config.apiKey = 'smoke-placeholder';
  const authURL = (await (await request(base, '/api/auth/chatgpt/start', 'POST')).json()).url;
  assert.equal(new URL(authURL).searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(new URL(authURL).searchParams.get('originator'), 'pi');
  await request(base, '/api/auth/apikey', 'POST');
  expectedReasoning = { effort: 'high', summary: 'detailed' };
  modelOutputs.push('What assumption would change your conclusion?');
  const answer = events(
    await (
      await request(
        base,
        `/api/notes/${note.id}/ask`,
        'POST',
        { prompt: 'Probe this', selection: 'not in the note', action: 'question' },
        cookie,
      )
    ).text(),
  );
  checkStatuses(answer);
  assert.equal(answer[1].data.phase, 'thinking');
  assert.equal(
    answer.find((e) => e.event === 'text')!.data.delta,
    'What assumption would change your conclusion?',
  );
  assert.equal(answer.at(-3)!.data.phase, 'done');
  const annotation = answer.find((e) => e.event === 'annotation')!.data.annotation;
  assert.equal(annotation.anchor, null);
  assert.equal(annotation.kind, 'question');
  assert.equal(answer.at(-1)!.event, 'done');
  assert.ok(answer.some((e) => e.event === 'thinking'));
  await request(base, '/api/settings', 'PATCH', { summary: 'off' }, cookie);
  expectedReasoning = { effort: 'high' };
  modelOutputs.push('Check it with a small counterexample.');
  const replyEvents = events(
    await (
      await request(
        base,
        `/api/annotations/${annotation.id}/reply`,
        'POST',
        { text: 'How can I test that?' },
        cookie,
      )
    ).text(),
  );
  checkStatuses(replyEvents);
  const thread = replyEvents.find((e) => e.event === 'annotation')!.data.annotation;
  assert.deepEqual(
    thread.replies.map((r: any) => r.role),
    ['user', 'ai'],
  );
  await request(base, `/api/annotations/${annotation.id}`, 'PATCH', { status: 'resolved' }, otherCookie, 404);
  await request(base, `/api/annotations/${annotation.id}`, 'PATCH', { status: 'resolved' }, cookie);
  await request(base, '/api/settings', 'PATCH', { effort: 'medium', summary: 'concise' }, cookie);
  expectedReasoning = { effort: 'medium', summary: 'concise' };
  const drawing = {
    viewBox: '0 0 400 240',
    steps: [
      { strokes: [{ d: 'M 10 10 L 100 100', width: 2 }] },
      {
        strokes: [{ d: 'M 100 100 C 110 120 150 130 200 180' }],
        labels: [{ x: 100, y: 100, text: 'a relationship' }],
      },
    ],
  };
  const mermaid =
    'Request flow:\n\n```mermaid\nsequenceDiagram\n  Client->>Server: Request\n  Server-->>Client: Response\n```';
  modelOutputs.push(mermaid);
  const diagramEvents = events(
    await (
      await request(
        base,
        `/api/notes/${note.id}/ask`,
        'POST',
        {
          prompt: 'Draw the client/server request sequence',
          selection: '*_`Edited by the writer`_*',
          action: 'draw',
        },
        cookie,
      )
    ).text(),
  );
  checkStatuses(diagramEvents);
  const diagram = diagramEvents.find((e) => e.event === 'annotation')!.data.annotation;
  assert.equal(diagram.kind, 'explain');
  assert.equal(diagram.body, mermaid);
  assert.equal(diagram.drawing, null);
  assert.equal(diagram.anchor, 'Edited by the writer');
  assert.equal(
    diagramEvents
      .filter((e) => e.event === 'text')
      .map((e) => e.data.delta)
      .join(''),
    mermaid,
  );
  checks++;
  const { normalizeAnchor } = await import('../src/store.js');
  assert.equal(normalizeAnchor('**literal** and code', '**literal**'), '**literal**');
  assert.equal(normalizeAnchor('plain code', '`code`'), 'code');
  assert.equal(normalizeAnchor('plain code', '**absent**'), null);
  assert.equal(normalizeAnchor('plain code', '***'), null);
  checks++;
  modelOutputs.push('```mermaid\nunsupportedDiagram\n```', JSON.stringify(drawing));
  const drawnEvents = events(
    await (
      await request(
        base,
        `/api/notes/${note.id}/ask`,
        'POST',
        { prompt: 'Draw a relationship', action: 'draw' },
        cookie,
      )
    ).text(),
  );
  checkStatuses(drawnEvents);
  assert.ok(drawnEvents.some((e) => e.event === 'status' && e.data.phase === 'drawing'));
  const drawn = drawnEvents.find((e) => e.event === 'annotation')!.data.annotation;
  assert.equal(drawn.kind, 'drawing');
  assert.deepEqual(drawn.drawing, drawing);
  modelOutputs.push('invalid JSON', 'still invalid');
  const fallback = events(
    await (
      await request(base, `/api/notes/${note.id}/ask`, 'POST', { prompt: 'Draw it', action: 'draw' }, cookie)
    ).text(),
  ).find((e) => e.event === 'annotation')!.data.annotation;
  assert.equal(fallback.kind, 'comment');
  assert.equal(fallback.drawing, null);
  const { drawingSchema } = await import('../src/types.js');
  assert.equal(
    drawingSchema.safeParse({
      ...drawing,
      steps: [{ strokes: [{ d: 'M 900 900 L 10 10' }] }, drawing.steps[1]],
    }).success,
    false,
  );
  const { subscribe } = await import('../src/jobs/index.js');
  async function background(
    pathname: string,
    payload: unknown,
    owner = { uid: me.user.id, noteId: note.id, cookie },
  ) {
    const received: Array<{ event: string; data: any }> = [];
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsub = subscribe(owner.uid, owner.noteId, (event, data) => {
      received.push({ event, data });
      if (event === 'status' && data.state === 'idle') finish();
    });
    const timer = setTimeout(finish, 3000);
    try {
      const res = await request(base, pathname, 'POST', payload, owner.cookie);
      await done;
      assert.ok(
        received.some((e) => e.event === 'status' && e.data.state === 'idle'),
        'Job did not finish',
      );
      assert.equal(received.filter((e) => e.event === 'status' && e.data.state === 'idle').length, 1);
      const runId = received[0].data.runId;
      assert.equal(typeof runId, 'string');
      assert.ok(runId.length > 0);
      for (const event of received) {
        assert.equal(event.data.runId, runId, `${event.event} missing stable runId`);
      }
      assert.equal(received.at(-1)!.data.state, 'idle');
      checkStatuses(received);
      checks++;
      return { received, result: await res.json() };
    } finally {
      clearTimeout(timer);
      unsub();
    }
  }
  modelOutputs.push(
    400,
    JSON.stringify({
      speak: true,
      kind: 'question',
      anchor: '**Edited by the writer**',
      body: 'What evidence supports this?',
      drawing: null,
    }),
  );
  const riddled = await background(`/api/notes/${note.id}/riddle`, { riddlerIds: [builtins[0].id] });
  assert.equal(riddled.result.queued, 1);
  assert.ok(
    riddled.received.some(
      (e) => e.event === 'thinking' && e.data.annotationId && e.data.riddlerId === builtins[0].id,
    ),
  );
  assert.ok(riddled.received.some((e) => e.event === 'annotation'));
  const finalRiddle = riddled.received.find((e) => e.event === 'annotation')!.data;
  assert.equal(finalRiddle.annotation.anchor, 'Edited by the writer');
  for (const event of riddled.received) {
    assert.equal(event.data.riddlerId, builtins[0].id);
    assert.equal(event.data.annotationId, finalRiddle.annotation.id);
  }
  await request(
    base,
    `/api/notes/${note.id}`,
    'PATCH',
    { mode: 'thinks', purpose: 'Probe assumptions' },
    cookie,
  );
  await request(
    base,
    '/api/settings',
    'PATCH',
    { backgroundModel: 'reader-model', backgroundEffort: 'high' },
    cookie,
  );
  expectedModel = 'reader-model';
  expectedReasoning = { effort: 'high', summary: 'concise' };
  modelOutputs.push(JSON.stringify({ speak: false, kind: 'comment', anchor: null, body: '', drawing: null }));
  const nudged = await background(`/api/notes/${note.id}/nudge`, {});
  assert.equal(nudged.result.queued, true);
  assert.equal(nudged.received.at(-1)!.data.silent, true);
  assert.notEqual(nudged.received[0].data.runId, riddled.received[0].data.runId);
  expectedModel = 'smoke-default';
  expectedReasoning = { effort: 'medium', summary: 'concise' };
  const before = modelCalls;
  assert.equal(
    (await (await request(base, `/api/notes/${note.id}/nudge`, 'POST', {}, cookie)).json()).queued,
    false,
  );
  assert.equal(modelCalls, before);
  assert.equal(
    (await (await request(base, `/api/notes/${note.id}`, 'GET', undefined, cookie)).json()).note.content,
    'Edited by the writer',
  );
  await request(base, `/api/notes/${note.id}`, 'PATCH', { content: 'A new passage for the reader' }, cookie);
  await request(base, '/api/settings', 'PATCH', { backgroundEffort: null }, cookie);
  expectedModel = 'reader-model';
  modelOutputs.push(
    JSON.stringify({
      speak: true,
      kind: 'comment',
      anchor: null,
      body: 'A useful margin note.',
      drawing: null,
    }),
  );
  const spoken = await background(`/api/notes/${note.id}/nudge`, {});
  const finalNudge = spoken.received.find((e) => e.event === 'annotation')!.data;
  assert.equal(finalNudge.annotationId, finalNudge.annotation.id);
  assert.equal(spoken.received.at(-1)!.data.annotationId, finalNudge.annotation.id);
  assert.equal(spoken.received.at(-1)!.data.silent, undefined);
  expectedModel = 'reader-model';
  modelOutputs.push(
    JSON.stringify({
      speak: true,
      kind: 'explain',
      anchor: null,
      body: 'Review with background preferences.',
      drawing: null,
    }),
  );
  const overriddenRiddle = await background(`/api/notes/${note.id}/riddle`, { riddlerIds: [builtins[0].id] });
  assert.equal(
    overriddenRiddle.received.find((e) => e.event === 'annotation')!.data.annotation.body,
    'Review with background preferences.',
  );
  modelOutputs.push(500);
  const failedRun = await background(`/api/notes/${note.id}/riddle`, { riddlerIds: [builtins[0].id] });
  assert.equal(failedRun.received.at(-2)!.event, 'error');
  assert.ok(failedRun.received.at(-2)!.data.error);
  assert.equal(failedRun.received.at(-1)!.data.silent, undefined);
  expectedModel = 'smoke-default';
  await request(base, `/api/annotations/${annotation.id}`, 'DELETE', undefined, cookie);

  const credsFile = path.join(tmp, 'codex-auth.json');
  const originalCredentials = JSON.stringify({
    tokens: {
      access_token: fakeAccess(),
      refresh_token: 'smoke-original-refresh',
      id_token: fakeJWT({
        email: 'smoke@example.invalid',
        name: 'Smoke ChatGPT',
        'https://api.openai.com/auth': { chatgpt_account_id: fakeAccount, chatgpt_plan_type: 'plus' },
      }),
      account_id: fakeAccount,
    },
  });
  await writeFile(credsFile, originalCredentials, { mode: 0o400 });
  config.codexAuthFile = credsFile;
  const imported = await request(base, '/api/auth/codex-import', 'POST');
  const importedUser = (await imported.json()).user;
  assert.equal(importedUser.email, 'smoke@example.invalid');
  assert.equal(importedUser.authMethod, 'chatgpt');
  const importedCookie = imported.headers.get('set-cookie')!.split(';')[0];
  const tokenRow = db.prepare('SELECT tokens FROM users WHERE id=?').get(importedUser.id) as {
    tokens: string;
  };
  assert.ok(!tokenRow.tokens.includes('smoke-original-refresh'));
  const { getCredentials } = await import('../src/auth.js');
  const old = await getCredentials(importedUser.id);
  await Promise.all([
    getCredentials(importedUser.id, true, old.access),
    getCredentials(importedUser.id, true, old.access),
  ]);
  assert.equal(refreshCalls, 1, 'Concurrent refresh must share a mutex');
  checks++;
  modelOutputs.push(401, 'A response after refreshing.');
  const oauthNote = (
    await (await request(base, '/api/notes', 'POST', { content: 'OAuth user note' }, importedCookie)).json()
  ).note;
  const after401 = events(
    await (
      await request(base, `/api/notes/${oauthNote.id}/ask`, 'POST', { prompt: 'Explain' }, importedCookie)
    ).text(),
  );
  assert.ok(after401.some((e) => e.event === 'annotation'));
  assert.equal(refreshCalls, 2, '401 should refresh once');
  const mappedModels = [
    {
      id: 'smoke-default',
      name: 'Default model',
      description: 'For writing',
      defaultEffort: 'medium',
      efforts: ['medium', 'high'],
    },
    {
      id: 'smoke-background',
      name: 'Reader',
      description: 'For reading',
      defaultEffort: 'low',
      efforts: ['low', 'ultra'],
    },
  ];
  const discoveryBeforeCache = discoveryCalls;
  assert.deepEqual(await (await request(base, '/api/models', 'GET', undefined, importedCookie)).json(), {
    models: mappedModels,
    source: 'live',
  });
  assert.equal(discoveryCalls, discoveryBeforeCache, 'Models cached per user');
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 11 * 60 * 1000;
    discoveryOutputs.push(401, liveModels);
    await request(base, '/api/models', 'GET', undefined, importedCookie);
    assert.equal(discoveryCalls, discoveryBeforeCache + 2);
    assert.equal(refreshCalls, 3, 'Model discovery refreshes once after 401');
    Date.now = () => realNow() + 22 * 60 * 1000;
    discoveryOutputs.push(503);
    const unavailable = await (await request(base, '/api/models', 'GET', undefined, importedCookie)).json();
    assert.equal(unavailable.source, 'fallback');
    assert.deepEqual(unavailable.models[0].efforts, ['low', 'medium', 'high']);
    discoveryOutputs.push(liveModels);
    assert.equal(
      (await (await request(base, '/api/models', 'GET', undefined, importedCookie)).json()).source,
      'live',
    );
  } finally {
    Date.now = realNow;
  }
  const liveSettings = (
    await (
      await request(
        base,
        '/api/settings',
        'PATCH',
        {
          model: 'smoke-background',
          effort: 'high',
          backgroundModel: 'smoke-default',
          backgroundEffort: 'ultra',
          summary: 'auto',
        },
        importedCookie,
      )
    ).json()
  ).settings;
  assert.deepEqual(liveSettings, {
    model: 'smoke-background',
    effort: 'low',
    summary: 'auto',
    backgroundModel: 'smoke-default',
    backgroundEffort: 'medium',
  });
  await request(
    base,
    '/api/settings',
    'PATCH',
    { effort: 'ultra', backgroundModel: null, backgroundEffort: null },
    importedCookie,
  );
  expectedModel = 'smoke-background';
  expectedReasoning = { effort: 'ultra', summary: 'auto' };
  modelOutputs.push('Using your selected model.');
  await request(
    base,
    `/api/notes/${oauthNote.id}/ask`,
    'POST',
    { prompt: 'Use my preferences' },
    importedCookie,
  );
  // A null background effort inherits, then clamps against the background model.
  await request(base, '/api/settings', 'PATCH', { backgroundModel: 'smoke-default' }, importedCookie);
  const { aiOptions } = await import('../src/settings.js');
  assert.deepEqual(await aiOptions(importedUser.id, true), {
    model: 'smoke-default',
    effort: 'medium',
    summary: 'auto',
  });
  expectedModel = 'smoke-default';
  expectedReasoning = { effort: 'medium', summary: 'auto' };
  modelOutputs.push(JSON.stringify({ speak: false, kind: 'comment', anchor: null, body: '', drawing: null }));
  const inheritedNudge = await background(
    `/api/notes/${oauthNote.id}/nudge`,
    {},
    {
      uid: importedUser.id,
      noteId: oauthNote.id,
      cookie: importedCookie,
    },
  );
  assert.equal(inheritedNudge.received.at(-1)!.data.silent, true);
  const reclamped = (
    await (await request(base, '/api/settings', 'PATCH', { model: 'smoke-default' }, importedCookie)).json()
  ).settings;
  assert.equal(reclamped.effort, 'medium', 'Changing the model reclamps the stored effort');

  checks++;

  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(credsFile, 'utf8'), originalCredentials, 'Codex import must remain read-only');
  assert.equal(modelOutputs.length, 0);
  await request(base, `/api/notes/${note.id}`, 'DELETE', undefined, cookie);
  await request(base, `/api/notes/${note.id}`, 'GET', undefined, cookie, 404);
  const spa = await request(base, '/notes/example');
  assert.match(await spa.text(), /scratchpad smoke SPA/);
  await request(base, '/api/auth/logout', 'POST', {}, cookie);
  await request(base, '/api/notes', 'GET', undefined, cookie, 401);
  process.env.NODE_ENV = 'production';
  await request(base, '/api/auth/test-session', 'POST', {}, undefined, 404);
  console.log(`Smoke passed (${checks} checks; no external OAuth or AI calls).`);
} finally {
  globalThis.fetch = originalFetch;
  db.close();
  await rm(tmp, { recursive: true, force: true });
}
