import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { config } from './config.js';
import type { Env } from './types.js';
import { registerAuth, requireUser } from './auth.js';
import { registerRoutes } from './routes.js';
import { registerAI } from './ai/routes.js';
export const app = new Hono<Env>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use(
  '/api/*',
  bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) }),
);
app.onError((err, c) => {
  if (err instanceof z.ZodError)
    return c.json(
      { error: 'Invalid input: ' + err.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') },
      400,
    );
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  return c.json({ error: 'Internal server error' }, 500);
});
app.get('/api/health', (c) => c.json({ ok: true }));
registerAuth(app);
app.use('/api/*', requireUser);
registerRoutes(app);
registerAI(app);
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.use('*', serveStatic({ root: config.webDist }));
app.get('*', serveStatic({ root: config.webDist, path: 'index.html' }));
app.notFound((c) => c.json({ error: 'Not found' }, 404));
