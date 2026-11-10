import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Env, Emit } from '../types.js';
import { body, routeId, idSchema, empty } from '../http.js';
import * as store from '../store.js';
import { ask, reply } from './engine.js';
import * as jobs from '../jobs/index.js';
export function registerAI(app: Hono<Env>) {
  app.post('/api/notes/:id/ask', async (c) => {
    const uid = c.get('user').id,
      note = store.getNote(uid, routeId(c));
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
    if (data.riddlerId) store.getRiddler(uid, data.riddlerId);
    return streamSSE(c, async (s) => {
      const abort = new AbortController();
      s.onAbort(() => abort.abort());
      const emit: Emit = async (event, data) => {
        await s.writeSSE({ event, data: JSON.stringify(data) });
      };
      try {
        await ask(uid, note, data, emit, abort.signal);
      } catch {
        if (!abort.signal.aborted)
          await emit('error', { error: 'AI request failed. Check your sign-in and try again.' });
      } finally {
        if (!abort.signal.aborted) await emit('done', {});
      }
    });
  });
  app.post('/api/annotations/:id/reply', async (c) => {
    const uid = c.get('user').id,
      a = store.getAnnotation(uid, routeId(c));
    const { text } = await body(c, z.object({ text: z.string().min(1).max(50000) }).strict());
    return streamSSE(c, async (s) => {
      const abort = new AbortController();
      s.onAbort(() => abort.abort());
      const emit: Emit = async (event, data) => {
        await s.writeSSE({ event, data: JSON.stringify(data) });
      };
      try {
        await reply(uid, a, text, emit, abort.signal);
      } catch {
        if (!abort.signal.aborted)
          await emit('error', { error: 'AI reply failed. Check your sign-in and try again.' });
      } finally {
        if (!abort.signal.aborted) await emit('done', {});
      }
    });
  });
  app.post('/api/notes/:id/nudge', async (c) => {
    const id = routeId(c);
    await body(c, empty);
    return c.json({ queued: jobs.nudge(c.get('user').id, id) });
  });
  app.post('/api/notes/:id/riddle', async (c) => {
    const id = routeId(c);
    const data = await body(c, z.object({ riddlerIds: z.array(idSchema).min(1).max(100) }).strict());
    return c.json({ queued: jobs.riddle(c.get('user').id, id, [...new Set(data.riddlerIds)]) });
  });
  app.get('/api/notes/:id/events', (c) => {
    const uid = c.get('user').id,
      id = routeId(c);
    store.getNote(uid, id);
    return streamSSE(c, async (s) => {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let chain = Promise.resolve();
      const emit: Emit = (event, data) => {
        chain = chain
          .then(async () => {
            await s.writeSSE({ event, data: JSON.stringify(data) });
          })
          .catch(() => {
            finish();
          });
        return chain;
      };
      const unsubscribe = jobs.subscribe(uid, id, emit);
      const timer = setInterval(() => {
        void emit('ping', {});
      }, 20000);
      s.onAbort(finish);
      try {
        await emit('ping', {});
        await done;
      } finally {
        clearInterval(timer);
        unsubscribe();
      }
    });
  });
}
