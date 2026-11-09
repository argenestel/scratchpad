import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { startCallbackListener } from './auth.js';
import { stopJobs } from './jobs/index.js';
const callback = startCallbackListener();
const server = serve({ fetch: app.fetch, hostname: '0.0.0.0', port: config.port }, () => {
  console.log(`scratchpad listening on port ${config.port}`);
});
callback.on('error', () => {
  console.error('OAuth callback listener could not start');
  server.close();
  process.exitCode = 1;
});
server.on('error', () => {
  console.error('HTTP listener could not start');
  callback.close();
  process.exitCode = 1;
});
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  stopJobs();
  callback.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
