# scratchpad

An AI notebook that thinks with you: margin questions, explanations, step-by-step
ink drawings, and Riddler reviewer personas. In **thinks** mode it reads along and
speaks up; in **ask** mode it responds when called.

## Quick start

Requires Docker and Docker Compose v2.24+.

```sh
cp .env.example .env && docker compose up -d --build
```

Open http://localhost:3000. `APP_SECRET` is generated on first boot and kept in the
data volume unless you set one (min 32 chars). Data persists in the `scratchpad-data`
volume at `/data`. See `.env.example` for configuration.

## Sign in

1. **Sign in with ChatGPT**, the same way Codex and pi do: browser OAuth with the
   fixed callback `http://localhost:1455/auth/callback`.
2. **Device code login** for remote hosts: follow the verification URL and enter
   the displayed code.
3. **Import Codex credentials**: enable the commented read-only mount of
   `${HOME}/.codex/auth.json` and `CODEX_AUTH_FILE=/codex/auth.json` in Compose.
   The server imports those credentials and refreshes them if needed.
4. **API-key fallback**: set `OPENAI_API_KEY` in `.env` to enable local single-user
   sign-in through the OpenAI Responses API.

Compose binds ports 3000 and 1455 to localhost. For a remote host, use
`ssh -L 1455:localhost:1455 -L 3000:localhost:3000 host`, then open
http://localhost:3000. Device login avoids the OAuth callback tunnel; remote
access still needs a tunnel or configured exposure for the app itself. Set
`APP_URL` to the URL your browser uses when changing the deployment.

## Deploy

| Option | What runs | Data | Sign-in | Guide |
| --- | --- | --- | --- | --- |
| Docker (local) | Node + SQLite container | Docker volume | Browser OAuth, device code, Codex import | Quick start above |
| Cloudflare Tunnel | Same container, exposed on your domain | Docker volume on your machine/VPS | Device code (browser OAuth only on localhost) | [docs/cloudflare-tunnel.md](docs/cloudflare-tunnel.md) |
| Cloudflare Workers | Serverless Worker + D1 + Durable Objects | D1 | Device code, optional API key | [docs/cloudflare-workers.md](docs/cloudflare-workers.md) |

The Workers build lives in `worker/` and serves the same API contract and the same web build.
CI typechecks and tests it in workerd on every push; deploys run once you set the
`CLOUDFLARE_DEPLOY` repository variable and Cloudflare secrets.

## Architecture

The Vite React frontend builds to `web/dist`. A Node 22 TypeScript server using
Hono and better-sqlite3 serves the frontend, API, sessions, and persistent notes.
A background agent queue uses `JOB_CONCURRENCY` to limit parallel jobs. AI runs
through a Codex Responses harness with reasoning summaries streamed to the UI.
`CONTRACT.md` defines the shared API, layout, and environment variables.

Reasoning is always on (`REASONING_EFFORT`, default `medium`), and its summary
(`REASONING_SUMMARY`, default `concise`) streams into each margin note as "thinking".
The default model is `DEFAULT_MODEL=gpt-6.1-sol`.

## Local development

```sh
make dev
# Equivalent:
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Open http://localhost:5173. The `server` and `web` services bind-mount their source
and keep dependencies in separate named volumes. The server dev image includes
the compiler tools needed by better-sqlite3. Dependencies install on startup,
then both services run with hot reload. The production `scratchpad` service is placed
behind the `production` profile in this override to avoid port conflicts. Stop
dev with `docker compose -f docker-compose.yml -f docker-compose.dev.yml down`.

Without Docker, use Node 22 and run `npm ci` (or `npm install` if no lockfile
exists) in each app directory. Run `npm run dev` in `server` with
`DATA_DIR=../data` and `APP_URL=http://localhost:5173`; run `npm run dev -- --host`
in `web` with `VITE_API_PROXY=http://localhost:3000`. Supply the server variables
from `.env.example` through your shell. For production, both apps use
`npm run build`, and the server uses `npm start`.

Use `make up`, `make down`, `make logs`, `make build`, and `make shell` for the
production Compose service. Image builds use `npm ci` when a lockfile exists and
fall back to `npm install` otherwise.
