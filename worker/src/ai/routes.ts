// Adapted from server/src/ai/routes.ts: foreground streams and trusted room forwarding.
import type { Hono } from 'hono';
import { z } from 'zod';
import { body, routeId, idSchema, empty } from '../http.js';
import { createStore } from '../store.js';
import { createEngine } from '../shared/engine.js';
import type { Bindings, Env, Emit } from '../types.js';

function foreground(work: (emit: Emit, signal: AbortSignal) => Promise<void>, request: Request) {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const abort = new AbortController();
  const cancel = () => abort.abort();
  request.signal.addEventListener('abort', cancel, { once: true });
  void writer.closed.catch(cancel);
  const emit: Emit = async (event, data) => {
    await writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  };
  void (async () => {
    try {
      await work(emit, abort.signal);
    } catch {
      if (!abort.signal.aborted)
        await emit('error', { error: 'AI request failed. Check your sign-in and try again.' });
    } finally {
      if (!abort.signal.aborted) {
        await emit('done', {});
        await writer.close();
      }
    }
  })()
    .catch(() => {})
    .finally(() => request.signal.removeEventListener('abort', cancel));
  return new Response(stream.readable, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' },
  });
}
export function registerAI(app: Hono<Env>, env: Bindings) {
  const store = createStore(env);
  const engine = createEngine(env);
  app.post('/api/notes/:id/ask', async (c) => {
    const uid = c.get('user').id;
    const note = await store.getNote(uid, routeId(c));
    const data = await body(
      c,
      z
        .object({
          prompt: z.string().min(1).max(50000),
          selection: z.string().max(1000000).optional(),
          action: z.enum(['ask', 'explain', 'draw', 'question', 'mindmap']).optional(),
          riddlerId: idSchema.optional(),
        })
        .strict(),
    );
    if (data.riddlerId) await store.getRiddler(uid, data.riddlerId);
    return foreground((emit, signal) => engine.ask(uid, note, data, emit, signal), c.req.raw);
  });
  app.post('/api/annotations/:id/reply', async (c) => {
    const uid = c.get('user').id;
    const annotation = await store.getAnnotation(uid, routeId(c));
    const { text } = await body(c, z.object({ text: z.string().min(1).max(50000) }).strict());
    return foreground((emit, signal) => engine.reply(uid, annotation, text, emit, signal), c.req.raw);
  });
  async function room(uid: string, noteId: string, path: string, data?: unknown) {
    await store.getNote(uid, noteId);
    const stub = env.NOTE_ROOM.get(env.NOTE_ROOM.idFromName(noteId));
    return stub.fetch(
      new Request('https://room' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'x-user-id': uid, 'x-note-id': noteId, 'content-type': 'application/json' },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
    );
  }
  app.get('/api/notes/:id/events', (c) => room(c.get('user').id, routeId(c), '/events'));
  app.post('/api/notes/:id/nudge', async (c) => {
    await body(c, empty);
    return room(c.get('user').id, routeId(c), '/nudge', {});
  });
  app.post('/api/notes/:id/riddle', async (c) => {
    const { riddlerIds } = await body(
      c,
      z.object({ riddlerIds: z.array(idSchema).min(1).max(100) }).strict(),
    );
    const uid = c.get('user').id;
    const ids = [...new Set(riddlerIds)];
    for (const id of ids) await store.getRiddler(uid, id);
    return room(uid, routeId(c), '/riddle', { riddlerIds: ids });
  });
}
