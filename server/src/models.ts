import { z } from 'zod';
import { config } from './config.js';
import { getCredentials } from './auth.js';
import { authHeaders } from './ai/auth-headers.js';
import type { ModelInfo } from './types.js';

type ModelList = { models: ModelInfo[]; source: 'live' | 'fallback' };
const cache = new Map<string, { expires: number; value: ModelList }>();
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

export function fallbackModels(): ModelList {
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

export async function getModels(uid: string): Promise<ModelList> {
  const hit = cache.get(uid);
  if (hit && hit.expires > Date.now()) return hit.value;
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
    cache.set(uid, { expires: Date.now() + 10 * 60 * 1000, value });
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

export function clampEffort(models: ModelInfo[], model: string, effort: string): string {
  const info = models.find((m) => m.id === model) ?? fallbackModels().models[0];
  return info.efforts.includes(effort) ? effort : info.defaultEffort;
}
