import { z } from 'zod';
import type { Hono } from 'hono';
import { config } from './config.js';
import { db } from './db.js';
import { body } from './http.js';
import { clampEffort, getModels } from './models.js';
import type { Env, Settings, ModelInfo } from './types.js';

export const settingsSchema = z
  .object({
    model: z.string().min(1).max(200),
    effort: z.string().min(1).max(100),
    askStyle: z.enum(['comment', 'block']),
    readAlongStyle: z.enum(['comment', 'block']),
    summary: z.enum(['concise', 'detailed', 'auto', 'off']),
    backgroundModel: z.string().min(1).max(200).nullable(),
    backgroundEffort: z.string().min(1).max(100).nullable(),
  })
  .strict();

function defaults(): Settings {
  return {
    model: config.model,
    effort: config.effort,
    summary: config.summary,
    askStyle: 'comment',
    readAlongStyle: 'comment',
    backgroundModel: null,
    backgroundEffort: null,
  };
}

function resolveSettings(uid: string, models: ModelInfo[], patch: Partial<Settings> = {}): Settings {
  const row = db.prepare('SELECT data FROM user_settings WHERE user_id=?').get(uid) as
    | { data: string }
    | undefined;
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

export async function getSettings(uid: string, patch: Partial<Settings> = {}): Promise<Settings> {
  const { models } = await getModels(uid);
  return resolveSettings(uid, models, patch);
}

export async function aiOptions(uid: string, background = false) {
  const { models } = await getModels(uid);
  const settings = resolveSettings(uid, models);
  const model = background ? (settings.backgroundModel ?? settings.model) : settings.model;
  const effort = background ? (settings.backgroundEffort ?? settings.effort) : settings.effort;
  return { model, effort: clampEffort(models, model, effort), summary: settings.summary };
}

export function registerSettings(app: Hono<Env>) {
  app.get('/api/models', async (c) => c.json(await getModels(c.get('user').id)));
  app.get('/api/settings', async (c) => c.json({ settings: await getSettings(c.get('user').id) }));
  app.patch('/api/settings', async (c) => {
    const patch = await body(c, settingsSchema.partial());
    const uid = c.get('user').id;
    const settings = await getSettings(uid, patch);
    db.prepare(
      'INSERT INTO user_settings(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data',
    ).run(uid, JSON.stringify(settings));
    return c.json({ settings });
  });
}
