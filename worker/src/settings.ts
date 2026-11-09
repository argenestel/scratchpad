// Adapted from server/src/settings.ts: asynchronous D1 settings.
import { z } from 'zod';
import type { Hono } from 'hono';
import type { Bindings } from './types.js';

import { body } from './http.js';
import { createModels } from './models.js';
import type { Env, Settings, ModelInfo } from './types.js';

export const settingsSchema = z
  .object({
    model: z.string().min(1).max(200),
    effort: z.string().min(1).max(100),
    summary: z.enum(['concise', 'detailed', 'auto', 'off']),
    backgroundModel: z.string().min(1).max(200).nullable(),
    backgroundEffort: z.string().min(1).max(100).nullable(),
  })
  .strict();

export function createSettings(env: Bindings) {
  const config = { model: env.DEFAULT_MODEL, effort: env.REASONING_EFFORT, summary: env.REASONING_SUMMARY };
  const { clampEffort, getModels } = createModels(env);
  function defaults(): Settings {
    return {
      model: config.model,
      effort: config.effort,
      summary: config.summary,
      backgroundModel: null,
      backgroundEffort: null,
    };
  }

  async function resolveSettings(
    uid: string,
    models: ModelInfo[],
    patch: Partial<Settings> = {},
  ): Promise<Settings> {
    const row = await env.DB.prepare('SELECT data FROM user_settings WHERE user_id=?')
      .bind(uid)
      .first<{ data: string }>();
    const settings: Settings = { ...defaults(), ...(row ? JSON.parse(row.data) : {}), ...patch };
    settings.effort = clampEffort(models, settings.model, settings.effort);
    if (settings.backgroundEffort !== null) {
      settings.backgroundEffort = clampEffort(
        models,
        settings.backgroundModel ?? settings.model,
        settings.backgroundEffort,
      );
    }
    return settings;
  }

  async function getSettings(uid: string, patch: Partial<Settings> = {}): Promise<Settings> {
    const { models } = await getModels(uid);
    return resolveSettings(uid, models, patch);
  }

  async function aiOptions(uid: string, background = false) {
    const { models } = await getModels(uid);
    const settings = await resolveSettings(uid, models);
    const model = background ? (settings.backgroundModel ?? settings.model) : settings.model;
    const effort = background ? (settings.backgroundEffort ?? settings.effort) : settings.effort;
    return { model, effort: clampEffort(models, model, effort), summary: settings.summary };
  }

  function registerSettings(app: Hono<Env>) {
    app.get('/api/models', async (c) => c.json(await getModels(c.get('user').id)));
    app.get('/api/settings', async (c) => c.json({ settings: await getSettings(c.get('user').id) }));
    const update: import('hono').Handler<Env> = async (c) => {
      const patch = await body(c, settingsSchema.partial());
      const uid = c.get('user').id;
      const settings = await getSettings(uid, patch);
      await env.DB.prepare(
        'INSERT INTO user_settings(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data',
      )
        .bind(uid, JSON.stringify(settings))
        .run();
      return c.json({ settings });
    };
    app.patch('/api/settings', update);
    app.put('/api/settings', update);
  }

  return { getSettings, aiOptions, registerSettings };
}
