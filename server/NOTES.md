# Backend decisions and verification

## Contract and scope

- `CONTRACT.md` is unchanged. All implementation lives in `server/`; the web app and Docker files were not edited.
- Responses use the contract's JSON shapes and SSE event names. AI failures emit `error` followed by `done` on foreground streams; a failed request cannot produce a successful final annotation.
- Timestamps are Unix milliseconds. New notes default to `Untitled`, empty content/purpose, `thinks`, ink `#42658c`, and no selected riddlers. Summaries contain the first 180 content characters; annotation counts include every status.
- Note ids and creation times are immutable; PATCH accepts their existing values, rejects changing the id, and preserves the original creation time. Update time is server-managed. Mutable note fields include title, content, mode, purpose, inkColor, and riddlerIds.
- Riddler PATCH changes name, persona, and color. Its id and builtin flag are server-managed. Builtins are editable/deletable per user and seed once for each user, including existing users on boot and new users at session creation. Deleted builtins do not reappear. Deleting a riddler also removes its selection from that user's notes; historical annotations retain the riddler id.
- Empty-body auth POSTs accept either no body or `{}`; routes requiring fields require JSON. Unknown object fields and malformed inputs are rejected. IDs are bounded URL-safe identifiers; colors accept hex RGB, RRGGBB, or RRGGBBAA.
- The test-only extension is `POST /api/auth/test-session` with `{identity?: string}`. It sets a normal signed session cookie and returns `{user}`. It returns 404 unless both startup and current `NODE_ENV` equal `test`.

## Auth and Responses

- Browser login uses the supplied pi reference's client id, scopes, PKCE parameters, and `originator=pi`. The callback binds `0.0.0.0:$OAUTH_CALLBACK_PORT`; the registered redirect URI deliberately remains exactly `http://localhost:1455/auth/callback`, as requested, even when the listener port is overridden.
- Browser state/verifier lifetime is ten minutes. Completion tickets are single-use with a one-minute lifetime. Device records expire after fifteen minutes; poll requests respect the provider interval, recognize pending and slow_down, and serialize concurrent polls for the same device.
- The provided OAuth reference does not contain the Responses transport implementation or email/plan extraction. The client uses Bearer authorization, `ChatGPT-Account-Id`, `OpenAI-Beta: responses=experimental`, `originator: pi`, `User-Agent: pi`, and SSE accept/content-type headers. Claims are read from access/id tokens at `https://api.openai.com/auth`, with standard email/name and `https://api.openai.com/profile` email fallbacks. Imported account_id is accepted when supplied.
- AES-256-GCM uses a SHA-256 key derived from APP_SECRET and a fresh 96-bit IV per encrypted token bundle. The bundle includes access/refresh/id tokens. The API key remains environment-only. Session ids have 256 bits of randomness, are stored in SQLite for thirty days, and are signed in the httpOnly, SameSite=Lax cookie. HTTPS APP_URL adds Secure.
- Refresh occurs automatically before an AI request when expiry is within five minutes, and once following a provider 401. A per-user promise mutex prevents concurrent refreshes; a request rejected with an older access token reuses an already refreshed token. Codex import reads its source file without writing it and refreshes an expiring token before storage.
- Secrets/provider response bodies are never logged or exposed in client errors. Login error HTML is deliberately generic. APP_SECRET is persisted with exclusive creation and mode 0600 when not supplied.
- Responses use the requested DEFAULT_MODEL and REASONING_EFFORT without model substitution. All requests have instructions, streaming, store:false, automatic reasoning summaries, and encrypted reasoning inclusion. Structured review output first requests text.format json_schema; HTTP 400/422 triggers one prompt-enforced JSON request without that option. The streaming parser handles chunk boundaries, CRLF, multiline data, failed/incomplete/error events, and missing completion.
- Official streaming reference consulted: https://developers.openai.com/api/reference/resources/responses/streaming-events . The supplied local pi module remains the OAuth reference.

## AI and jobs

- Prompts prohibit rewriting notes, favor concise questions/explanations, honor purpose and persona, and discourage repeated interruptions. Drawing outputs are validated against the contract shape, limited to 2–6 incremental steps, and checked for path syntax and coordinates inside the viewBox. Curve controls are bounded; arcs use a conservative envelope that may reject some otherwise valid near-edge arcs. Drawing validation failure retries once, then produces a text annotation. Spontaneously selected drawings use the same retry policy.
- Foreground output is saved as one annotation. Reply streams persist the user's reply before model invocation and append the AI reply after success. Anchors are normalized against the current note content at persistence, becoming null if absent.
- Review jobs are in-process model tasks, not additional operating-system workers. JOB_CONCURRENCY defaults to three. Each note has its own event subscribers; subscriptions have a serialized write chain, cleanup on disconnect, and twenty-second pings. Status/thinking/text events from riddler jobs include a stable annotationId plus riddlerId. The placeholder annotation is persisted before model invocation.
- Nudge coalescing allows one running and one queued job per note. A queued review reads the latest note. Successful reviews persist a SHA-256 content hash, including silent reviews; unchanged content skips. Speak-up cooldown is forty-five seconds for automatic nudges. Explicit ask/riddle requests bypass that cooldown. Nudges suppressed by cooldown remain eligible for a later idle request. Reviews of stale content and automatic reviews whose note switched to ask mode are discarded.
- Explicit riddle ids are deduplicated. A requested riddler returns a short final annotation even if it has no new concerns; an automatic nudge may remain silent. Failed or cancelled riddler reviews remove their placeholder. Jobs are not durable across process restarts; notes, annotations, review hashes/cooldowns, tokens, and sessions are durable.

## Verification

- `npm run build` passes with no TypeScript errors; `npm audit` reports 0 vulnerabilities.
- `npm run smoke` passes 49 checks against the real Hono app (via `app.request`) with a disposable database and all provider calls stubbed: health, 401, signed sessions/logout, note CRUD, validation, cross-user isolation, riddlers, annotations, SSE, reasoning/text streaming, replies, drawing retry/fallback/bounds, structured-format fallback, riddler job tagging, nudge dedupe, Codex import (read-only), encrypted token storage, refresh dedupe and 401 retry, SPA fallback, and test-helper rejection in production.
- Verified live in Docker: browser PKCE authorize URL, the :1455 callback listener, device-code start, Codex `auth.json` import, and streamed asks with reasoning summaries against the ChatGPT Codex backend.
- Reasoning summary mode is configurable with `REASONING_SUMMARY` (default `concise`, which produced the richest visible thinking from the Codex backend in testing).

## Commands

Run from `server/`:

```sh
npm install
npm run dev     # tsx watch
npm run build
npm start
npm run smoke
```
