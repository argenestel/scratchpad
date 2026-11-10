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

## v2

- Per-user preferences live in a new `user_settings` table, created at boot without changing existing tables. Defaults come from `DEFAULT_MODEL`, `REASONING_EFFORT`, and `REASONING_SUMMARY`. PATCH validates the partial settings shape and stores normalized efforts; null background preferences preserve inheritance. Effective inherited background effort is clamped again against the background model.
- ChatGPT model discovery uses client version `0.166.0`, the same authorization headers as Responses, and the existing credential refresh mutex with one retry after 401. Visible models are cached per user for ten minutes. API-key accounts and discovery failures receive the configured default model with low/medium/high efforts. Failures are retried on the next lookup. Unknown model ids use the fallback effort capabilities without substituting the requested model id.
- Each ask, reply, and review resolves preferences once and passes explicit model, effort, and summary options through all Responses retries. Riddlers use foreground preferences; read-along reviews use background preferences. Summary `off` omits the summary property from reasoning entirely.
- Background runs carry a UUID on every event, including errors and final annotations. Riddler identity and known annotation identity accompany subsequent events. Every run ends with one idle status; silent read-along runs include `silent: true`. A new event subscription receives a ping instead of an unscoped idle status.
- Smoke coverage retains the existing checks and adds settings defaults, validation, persistence and isolation, effort normalization/inheritance, actual Responses request options (including omitted summary), model discovery mapping/cache/expiry/401/failure fallback, and speaking, silent, and failed background run identity. Provider calls remain stubbed. Final verification: `npm run build` passes and `npm run smoke` passes 83 checks. The required Prettier 3.3.3 command completed successfully using the cached package.

## v3

- Notes and AI text use GFM Markdown. Prompts require language-tagged code fences and prefer small Mermaid diagrams for technical relationships. Draw requests let the model choose validated Drawing JSON or Markdown with a supported Mermaid fence; invalid output retains the existing retry and text fallback.
- Anchors first match verbatim, then retry without surrounding asterisks, underscores, or backticks. Persistence still checks against the current content and clears missing anchors.
- Every status includes the effective model, effort, and phase. Foreground streams start with reading, then thinking when sent, writing on output, drawing for validated ink, and done immediately before the final annotation. Background runs retain their identity and exactly one final idle status with phase done.
- Background overrides apply to both nudges and riddler jobs, resolving the older v2 description in favor of the v3 task. Foreground asks and replies use foreground preferences. Each run resolves preferences once.
- Smoke tests retain prior coverage and add phase ordering, model/effort identity, anchor edge stripping, draw-to-Mermaid output, invalid Mermaid retry, and riddler overrides. All provider traffic is stubbed.

## v4

- Both backends validate and persist `askStyle` and `readAlongStyle` (`comment` by default, or `block`). Node backfills existing JSON settings rows at boot; Worker uses D1 migration `0002_response_styles.sql`. Block insertion and annotation resolution remain client responsibilities.
- Mind map asks summarize the selection when supplied, otherwise the note. Both backends share the prompt and sanitizer: a single Mermaid mindmap fence, `root((Topic))`, indented children, 2–4 levels and at most 30 nodes. Labels retain letters, numbers, spaces, underscores, periods and hyphens. Surrounding prose is discarded. Invalid output retries once, then becomes a deterministic Markdown bullet outline of the source's nonempty lines (up to 30); empty source becomes `- Empty note`. The annotation stays kind `explain`, with drawing status during generation; only the sanitized result or fallback is streamed as text.
- Tests cover existing-row migrations, style defaults/round trips/validation, stubbed mind map generation, sanitization, successful retry and outline fallback.
