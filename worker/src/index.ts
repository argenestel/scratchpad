import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { createAuth } from './auth.js';
import { registerRoutes } from './routes.js';
import { createSettings } from './settings.js';
import { registerAI } from './ai/routes.js';
import type { Bindings, Env } from './types.js';
export { NoteRoom } from './room.js';

export function createApp(env: Bindings) {
  const app = new Hono<Env>();
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.use(
    '/api/*',
    bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: 'Request too large' }, 413) }),
  );
  app.onError((error, c) => {
    if (error instanceof z.ZodError)
      return c.json(
        {
          error: 'Invalid input: ' + error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; '),
        },
        400,
      );
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    return c.json({ error: 'Internal server error' }, 500);
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  const auth = createAuth(env);
  auth.registerAuth(app);
  app.use('/api/*', auth.requireUser);
  registerRoutes(app, env);
  createSettings(env).registerSettings(app);
  registerAI(app, env);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.all('*', (c) => env.ASSETS.fetch(c.req.raw));
  return app;
}
export default {
  fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
    return createApp(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Bindings>;
