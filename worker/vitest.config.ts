import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          APP_SECRET: 'offline-test-secret-at-least-32-characters',
          OPENAI_API_KEY: 'offline-provider-key',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
}));
