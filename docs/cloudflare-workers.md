# Cloudflare Workers

The `worker/` target hosts scratchpad directly on Cloudflare: Workers Static Assets
serves `web/dist`, Hono handles `/api/*`, D1 stores application data, and one
`NoteRoom` Durable Object per note coordinates background work and SSE subscribers.
The existing Docker target remains available.

| | Native Workers | Docker + Cloudflare Tunnel |
| --- | --- | --- |
| Runtime | Cloudflare Workers + D1 + Durable Objects | Node 22 + SQLite on your host |
| Hosting | No always-on host to maintain | Host and persistent Docker volume required |
| Sign-in | ChatGPT device code; optional shared API-key fallback | Device code, local browser callback, optional Codex file import/API key |
| Background work | Durable Object stored queue and alarms | Node process queue |
| Data | Separate D1 database | Existing SQLite volume |
| Setup | This guide | [Tunnel guide](cloudflare-tunnel.md) |

## First deployment

Use Node 22 and a Cloudflare account with Workers, D1, and SQLite-backed Durable
Objects enabled. From the repository root:

```sh
npm ci --prefix web
npm ci --prefix worker
npm run build --prefix web
cd worker
npx wrangler login
npx wrangler d1 create scratchpad
```

Copy the returned database UUID into the `database_id` of the `DB` binding in
`worker/wrangler.toml`, replacing its placeholder. Keep `database_name = "scratchpad"`.
Configure `APP_URL` in the same file to the final HTTPS origin (your Worker URL
or custom domain). Defaults for `DEFAULT_MODEL`, `REASONING_EFFORT`, and
`REASONING_SUMMARY` are also configured there.

Set a stable random secret of at least 32 characters when prompted:

```sh
npx wrangler secret put APP_SECRET
# Optional shared, single-user API-key login:
npx wrangler secret put OPENAI_API_KEY
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

`APP_SECRET` signs session cookies and encrypts stored OAuth tokens. Keep it in
Cloudflare secrets, never in source or Wrangler vars. Preserve it across deploys;
changing it invalidates cookies and makes existing token bundles unreadable.
The optional API-key login uses one shared account and is suitable for a private
instance. Use ChatGPT device sign-in for separate user accounts.

Wrangler uploads assets and applies the `NoteRoom` Durable Object migration from
`wrangler.toml` during deployment. Preserve migration tags and add new tags for
future class changes; D1 SQL migrations are a separate command, applied before
deploying code that needs them. See [D1 setup](https://developers.cloudflare.com/d1/get-started/)
and [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
This creates a fresh D1 database; it does not copy data from a Docker volume.

## Local development and checks

Build the web app first, then run these from `worker/`:

```sh
# Create worker/.dev.vars with APP_SECRET="<random value, at least 32 characters>".
# Add OPENAI_API_KEY there only if needed. Do not commit this file.
npx wrangler d1 migrations apply DB --local
npx wrangler dev
```

Local D1 and Durable Object state are separate from production. Open Wrangler's
local URL; use the local HTTP origin for `APP_URL` when testing locally. The
frontend and API share an origin, including the signed `dd_session` cookie.

```sh
npm run typecheck
npm test
npx wrangler deploy --dry-run
```

Tests use Vitest with `@cloudflare/vitest-pool-workers`, exercising the Workers
runtime and local D1/Durable Object bindings. A dry run bundles the Worker and
assets without publishing. It does not validate production credentials or prove
that live ChatGPT sign-in/provider calls work.

## Auth, state, and streaming

Hosted sign-in uses the device-code flow. `/api/auth/me` advertises
`browser: false`, `device: true`, and `codexImport: false`. The fixed
`localhost:1455` browser callback cannot run in Workers, and a Worker cannot read
your local Codex `auth.json`. No callback port or Codex credential mount is needed.
Device polling state is stored in D1. OAuth refresh is serialized per user with
an expiring D1 lease in `refresh_locks`, so independent isolates coordinate token
rotation. The per-user `model_cache` table caches the model catalog for ten minutes.

Each note's `NoteRoom` persists its background queue and schedules alarms, allowing
riddler/read-along work to run without an attached browser. Subscribers receive
live SSE events with the contract's `runId`, status, thinking, text, annotation,
and ping events. Reconnect after network interruption or deployment; reload the
note to reconcile saved annotations because SSE is a live stream, not a durable
event replay log. Alarms can retry, so external AI execution is not an exactly-once
operation. Background work must use the stored queue, not only `waitUntil()`.

Cloudflare currently allows HTTP/SSE requests to continue while the client stays
connected; this does not remove CPU or subrequest limits. Workers Free has 10 ms
CPU and 50 subrequests per invocation; Paid defaults to 30 s CPU (configurable up
to 300 s) and 10,000 subrequests. Network waits do not count as CPU time.
`waitUntil()` adds only up to 30 s after response completion/disconnect. Monitor
CPU, D1 usage, and open SSE connections; use Paid if the workload exceeds Free
quotas. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## GitHub Actions

[The deployment workflow](../.github/workflows/deploy-cloudflare.yml) runs on pushes
to `main` affecting `worker/**`, `web/**`, shared `server/src/ai/**`, or the workflow,
and supports manual `workflow_dispatch`. It installs locked dependencies, builds
the web app, checks/types/tests the Worker, applies remote D1 migrations, then
deploys. Production deployments are serialized.

Before enabling it, configure the database ID, provision Worker application
secrets with Wrangler as above, and add these repository Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the destination account ID.
- `CLOUDFLARE_API_TOKEN`: an account-scoped token with **Workers Scripts: Edit**,
  **D1: Edit**, and **Account Settings: Read** for the destination account. Add
  zone-scoped **Workers Routes: Edit** and **Zone: Read** only if deploying routes
  or custom domains that need them. See [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/)
  and [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

`APP_SECRET` and `OPENAI_API_KEY` are Worker secrets, not frontend build variables.
The workflow's [checkout v4](https://github.com/actions/checkout/tree/v4) and
[setup-node v4](https://github.com/actions/setup-node/tree/v4) use Node 22 for builds.
No Cloudflare resources or production deployments are created merely by adding
these files; deployment requires the account configuration and commands above.
