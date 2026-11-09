import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
const positive = z.coerce.number().int().positive();
const dataDir = path.resolve(process.env.DATA_DIR || './data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let secret = process.env.APP_SECRET?.trim();
if (secret && (secret.startsWith('replace-with') || secret.length < 32))
  throw new Error(
    'APP_SECRET is a placeholder or too short (min 32 chars). Leave it empty to auto-generate one in DATA_DIR.',
  );
if (!secret) {
  const file = path.join(dataDir, 'secret');
  try {
    secret = readFileSync(file, 'utf8').trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const value = randomBytes(48).toString('base64url');
    try {
      writeFileSync(file, value, { mode: 0o600, flag: 'wx' });
      secret = value;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      secret = readFileSync(file, 'utf8').trim();
    }
  }
}
if (!secret) throw new Error('APP_SECRET must not be empty');
export const config = {
  dataDir,
  secret,
  port: positive.max(65535).parse(process.env.PORT || 3000),
  callbackPort: positive.max(65535).parse(process.env.OAUTH_CALLBACK_PORT || 1455),
  appUrl: z
    .url()
    .parse(process.env.APP_URL || 'http://localhost:3000')
    .replace(/\/$/, ''),
  webDist: path.resolve(
    process.env.WEB_DIST || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist'),
  ),
  codexAuthFile: process.env.CODEX_AUTH_FILE,
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.DEFAULT_MODEL || 'gpt-6.1-sol',
  effort: process.env.REASONING_EFFORT || 'medium',
  summary: z.enum(['concise', 'detailed', 'auto', 'off']).parse(process.env.REASONING_SUMMARY || 'concise'),
  concurrency: positive.parse(process.env.JOB_CONCURRENCY || 3),
  nodeEnv: process.env.NODE_ENV || 'development',
};
