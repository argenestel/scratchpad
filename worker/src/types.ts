export * from '../../server/src/types.js';
import type { User } from '../../server/src/types.js';
export type Bindings = {
  DB: D1Database;
  NOTE_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_SECRET: string;
  OPENAI_API_KEY?: string;
  DEFAULT_MODEL: string;
  REASONING_EFFORT: string;
  REASONING_SUMMARY: 'concise' | 'detailed' | 'auto' | 'off';
  JOB_CONCURRENCY: string;
};
export type Env = { Bindings: Bindings; Variables: { user: User } };
