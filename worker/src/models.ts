// Adapted from server/src/models.ts: D1 ten-minute per-user cache.
import { z } from 'zod';
import type { Bindings } from './types.js';
import { createAuth } from './auth.js';
import { authHeaders } from './shared/auth-headers.js';
import type { ModelInfo } from './types.js';

type ModelList = { models: ModelInfo[]; source: 'live' | 'fallback' };

const liveSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string().min(1),
      display_name: z.string(),
      description: z.string(),
      visibility: z.string(),
      default_reasoning_level: z.string().min(1),
      supported_reasoning_levels: z
        .array(z.object({ effort: z.string().min(1), description: z.string() }))
        .min(1),
    }),
  ),
});

export function createModels(env: Bindings) {
  const config = { model: env.DEFAULT_MODEL, effort: env.REASONING_EFFORT };
  const { getCredentials } = createAuth(env);
  function fallbackModels(): ModelList {
    return {
      models: [
        {
          id: config.model,
          name: config.model,
          description: '',
          defaultEffort: ['low', 'medium', 'high'].includes(config.effort) ? config.effort : 'medium',
          efforts: ['low', 'medium', 'high'],
        },
      ],
      source: 'fallback',
    };
  }

  async function getModels(uid: string): Promise<ModelList> {
    const hit = await env.DB.prepare('SELECT data,expires_at FROM model_cache WHERE user_id=?')
      .bind(uid)
      .first<{ data: string; expires_at: number }>();
    if (hit && hit.expires_at > Date.now()) return JSON.parse(hit.data) as ModelList;
    try {
      let credentials = await getCredentials(uid);
      if (credentials.authMethod === 'apikey') return fallbackModels();
      let res = await fetchModels(credentials);
      if (res.status === 401) {
        await res.body?.cancel();
        credentials = await getCredentials(uid, true, credentials.access);
        res = await fetchModels(credentials);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error('Models unavailable');
      }
      const payload = liveSchema.parse(await res.json());
      const models = payload.models
        .filter((m) => m.visibility === 'list')
        .map((m) => ({
          id: m.slug,
          name: m.display_name,
          description: m.description,
          defaultEffort: m.default_reasoning_level,
          efforts: m.supported_reasoning_levels.map((level) => level.effort),
        }));
      if (!models.length || models.some((m) => !m.efforts.includes(m.defaultEffort)))
        throw new Error('Invalid models');
      const value: ModelList = { models, source: 'live' };
      await env.DB.prepare(
        'INSERT INTO model_cache(user_id,data,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at',
      )
        .bind(uid, JSON.stringify(value), Date.now() + 600000)
        .run();
      return value;
    } catch {
      return fallbackModels();
    }
  }

  function fetchModels(credentials: Awaited<ReturnType<typeof getCredentials>>) {
    return fetch('https://chatgpt.com/backend-api/codex/models?client_version=0.166.0', {
      headers: authHeaders(credentials),
      signal: AbortSignal.timeout(30000),
    });
  }

  function clampEffort(models: ModelInfo[], model: string, effort: string): string {
    const info = models.find((m) => m.id === model) ?? fallbackModels().models[0];
    return info.efforts.includes(effort) ? effort : info.defaultEffort;
  }

  return { getModels, clampEffort, fallbackModels };
}
