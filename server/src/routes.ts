import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Env, Note } from './types.js';
import { colorSchema } from './types.js';
import { body, routeId, idSchema } from './http.js';
import { db } from './db.js';
import * as store from './store.js';
export const createNoteSchema = z
  .object({
    title: z.string().max(1000).optional(),
    content: z.string().max(1000000).optional(),
    mode: z.enum(['thinks', 'ask']).optional(),
    purpose: z.string().max(10000).optional(),
  })
  .strict();
const patchNoteSchema = createNoteSchema.extend({
  inkColor: colorSchema.optional(),
  riddlerIds: z.array(idSchema).max(100).optional(),
  id: idSchema.optional(),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});
const riddlerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    persona: z.string().min(1).max(20000),
    color: colorSchema,
  })
  .strict();
export function registerRoutes(app: Hono<Env>) {
  app.get('/api/notes', (c) => {
    const uid = c.get('user').id;
    return c.json({
      notes: store
        .notes(uid)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((n) => ({
          id: n.id,
          title: n.title,
          snippet: n.content.slice(0, 180),
          mode: n.mode,
          inkColor: n.inkColor,
          updatedAt: n.updatedAt,
          annotationCount: store.annotations(uid, n.id).length,
        })),
    });
  });
  app.post('/api/notes', async (c) => {
    const data = await body(c, createNoteSchema);
    const now = Date.now();
    const n: Note = {
      id: randomUUID(),
      title: data.title ?? 'Untitled',
      content: data.content ?? '',
      mode: data.mode ?? 'thinks',
      purpose: data.purpose ?? '',
      inkColor: '#2b4acb',
      riddlerIds: [],
      createdAt: now,
      updatedAt: now,
    };
    store.putNote(c.get('user').id, n);
    return c.json({ note: n });
  });
  app.get('/api/notes/:id', (c) => {
    const uid = c.get('user').id,
      id = routeId(c);
    return c.json({ note: store.getNote(uid, id), annotations: store.annotations(uid, id) });
  });
  app.patch('/api/notes/:id', async (c) => {
    const uid = c.get('user').id,
      id = routeId(c),
      n = store.getNote(uid, id),
      data = await body(c, patchNoteSchema);
    if (data.id && data.id !== id) throw new HTTPException(400, { message: 'Note id is immutable' });
    if (data.riddlerIds) for (const rid of data.riddlerIds) store.getRiddler(uid, rid);
    const next = { ...n, ...data, id, createdAt: n.createdAt, updatedAt: Date.now() };
    store.putNote(uid, next);
    return c.json({ note: next });
  });
  app.delete('/api/notes/:id', (c) => {
    const uid = c.get('user').id,
      id = routeId(c);
    store.getNote(uid, id);
    db.prepare('DELETE FROM notes WHERE user_id=? AND id=?').run(uid, id);
    return c.json({ ok: true });
  });
  app.get('/api/riddlers', (c) => c.json({ riddlers: store.riddlers(c.get('user').id) }));
  app.post('/api/riddlers', async (c) => {
    const data = await body(c, riddlerSchema);
    const r = { ...data, id: randomUUID(), builtin: false };
    store.putRiddler(c.get('user').id, r);
    return c.json({ riddler: r });
  });
  app.patch('/api/riddlers/:id', async (c) => {
    const uid = c.get('user').id,
      id = routeId(c),
      r = store.getRiddler(uid, id);
    const next = { ...r, ...(await body(c, riddlerSchema.partial())) };
    store.putRiddler(uid, next);
    return c.json({ riddler: next });
  });
  app.delete('/api/riddlers/:id', (c) => {
    const uid = c.get('user').id,
      id = routeId(c),
      r = store.getRiddler(uid, id);
    store.removeRiddler(uid, id);
    return c.json({ ok: true });
  });
  app.patch('/api/annotations/:id', async (c) => {
    const uid = c.get('user').id,
      a = store.getAnnotation(uid, routeId(c)),
      data = await body(c, z.object({ status: z.enum(['open', 'resolved', 'dismissed']) }).strict());
    const next = { ...a, ...data };
    store.putAnnotation(uid, next);
    return c.json({ annotation: next });
  });
  app.delete('/api/annotations/:id', (c) => {
    const uid = c.get('user').id,
      id = routeId(c);
    store.getAnnotation(uid, id);
    store.deleteAnnotation(uid, id);
    return c.json({ ok: true });
  });
}
