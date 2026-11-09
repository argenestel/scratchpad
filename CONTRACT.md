# scratchpad — shared contract (server ⇄ web)

A notebook that thinks with you. You write; scratchpad reads along and leaves margin
notes: questions, explanations, ink drawings. "Riddlers" are AI reviewer personas.
All AI goes through the user's own ChatGPT account (Codex OAuth), reasoning enabled.

## Layout
```
/server        Node 22 + TypeScript, Hono, better-sqlite3, zod. Entry: src/index.ts
/web           Vite + React 18 + TS (built to /web/dist, served by server in prod)
/Dockerfile    multi-stage; final image runs `node server/dist/index.js`
/docker-compose.yml
```
Server env: `PORT=3000`, `APP_URL=http://localhost:3000`, `DATA_DIR=/data`,
`APP_SECRET` (cookie signing + token encryption), `OAUTH_CALLBACK_PORT=1455`,
`DEFAULT_MODEL=gpt-6.1-sol`, `REASONING_EFFORT=medium`, `CODEX_AUTH_FILE=/codex/auth.json` (optional ro mount),
`OPENAI_API_KEY` (optional fallback → api.openai.com/v1/responses).
In dev, Vite (5173) proxies `/api` → 3000.

All responses JSON unless SSE. Errors: `{ "error": string }` with 4xx/5xx.
Session: httpOnly cookie `dd_session`. All `/api/*` except `/api/auth/*`, `/api/health` require it (401 otherwise).

## Types
```ts
type User = { id: string; email: string | null; name: string | null; plan: string | null; authMethod: 'chatgpt' | 'apikey' }
type Mode = 'thinks' | 'ask'           // thinks = reads along & speaks up; ask = only when called
type NoteSummary = { id; title; snippet; mode: Mode; inkColor; updatedAt: number; annotationCount: number }
type Note = { id; title; content: string /* plain text, paragraphs split by \n\n */; mode: Mode;
              purpose: string /* "what this note is for / how to behave" */; inkColor: string /* hex */;
              riddlerIds: string[]; createdAt: number; updatedAt: number }
type Riddler = { id; name; persona: string; color: string; builtin: boolean }
type Drawing = { viewBox: string /* "0 0 400 240" */;
                 steps: { caption?: string; strokes: { d: string; width?: number }[];
                          labels?: { x: number; y: number; text: string }[] }[] }
type Annotation = { id; noteId; kind: 'question' | 'explain' | 'drawing' | 'comment';
                    anchor: string | null /* exact substring of note content it refers to */;
                    body: string /* markdown */; drawing: Drawing | null; riddlerId: string | null;
                    thinking: string | null /* reasoning summary */; status: 'open' | 'resolved' | 'dismissed';
                    replies: Reply[]; createdAt: number }
type Reply = { id; role: 'user' | 'ai'; body: string; thinking: string | null; createdAt: number }
```

## Auth (Codex / pi "Sign in with ChatGPT")
- `GET  /api/health` → `{ ok: true }`
- `GET  /api/auth/me` → `{ user: User | null, methods: { browser: true, device: true, codexImport: boolean, apiKey: boolean } }`
- `POST /api/auth/chatgpt/start` → `{ url }` — PKCE authorize URL. Server runs a listener on :1455 `/auth/callback`,
  exchanges code, creates session ticket, redirects browser to `APP_URL/api/auth/complete?ticket=…` which sets cookie and 302s to `/`.
- `POST /api/auth/chatgpt/device` → `{ deviceId, userCode, verificationUrl, interval }`
- `POST /api/auth/chatgpt/device/poll` `{ deviceId }` → `{ status: 'pending' } | { status: 'ok', user }` (sets cookie when ok)
- `POST /api/auth/codex-import` → `{ user }` (reads CODEX_AUTH_FILE, refreshes if needed, sets cookie)
- `POST /api/auth/apikey` → `{ user }` (only when OPENAI_API_KEY set; local single-user)
- `POST /api/auth/logout` → `{ ok: true }`

## Notes
- `GET    /api/notes` → `{ notes: NoteSummary[] }` (updatedAt desc)
- `POST   /api/notes` `{ title?, content?, mode?, purpose? }` → `{ note }`
- `GET    /api/notes/:id` → `{ note, annotations: Annotation[] }`
- `PATCH  /api/notes/:id` partial Note fields → `{ note }`
- `DELETE /api/notes/:id` → `{ ok: true }`

## Riddlers
- `GET /api/riddlers` → `{ riddlers }` (seeded builtins: Staff Engineer, Editor, Investor, Professor, Skeptic)
- `POST /api/riddlers` `{ name, persona, color }` → `{ riddler }`; `PATCH /api/riddlers/:id`; `DELETE /api/riddlers/:id`

## Annotations
- `PATCH  /api/annotations/:id` `{ status }` → `{ annotation }`
- `DELETE /api/annotations/:id` → `{ ok: true }`

## AI (SSE: `text/event-stream`, frames `event: <name>\ndata: <json>\n\n`)
Events common to all streams:
- `status`     `{ state: 'thinking' | 'writing' | 'drawing' | 'idle', riddlerId?: string|null, label?: string }`
- `thinking`   `{ delta: string, annotationId?: string }`        — reasoning summary text
- `text`       `{ delta: string, annotationId?: string }`        — answer body text
- `annotation` `{ annotation: Annotation }`                     — created/updated (final)
- `error`      `{ error: string }`
- `done`       `{}`

Endpoints:
- `POST /api/notes/:id/ask` `{ prompt: string, selection?: string, action?: 'ask'|'explain'|'draw'|'question', riddlerId?: string }`
  → SSE; ends with one `annotation` then `done`. `draw` must produce a Drawing.
- `POST /api/annotations/:id/reply` `{ text }` → SSE; ends with `annotation` (with new replies) then `done`.
- `POST /api/notes/:id/riddle` `{ riddlerIds: string[] }` → `{ queued: number }` — background: each riddler reviews note.
- `POST /api/notes/:id/nudge` `{}` → `{ queued: boolean }` — called by web (debounced ~4s idle) in `thinks` mode;
  background agent decides whether to speak up (may produce nothing). Server dedupes/coalesces per note.
- `GET  /api/notes/:id/events` → long-lived SSE for background agents on that note: `status`, `thinking`, `text`, `annotation`, `ping` every 20s.

## Settings & models (v2)
```ts
type Effort = string   // one of the chosen model's efforts, e.g. 'low'|'medium'|'high'|'xhigh'|'max'|'ultra'
type ModelInfo = { id: string; name: string; description: string; defaultEffort: Effort; efforts: Effort[] }
type Settings = {
  model: string;                       // used for asks, replies, riddlers
  effort: Effort;
  summary: 'concise' | 'detailed' | 'auto' | 'off';   // reasoning summary streamed as "thinking"; off = no summary
  backgroundModel: string | null;      // read-along agent; null = same as model
  backgroundEffort: Effort | null;     // null = same as effort
}
```
- `GET   /api/models` → `{ models: ModelInfo[], source: 'live' | 'fallback' }`
  ChatGPT users: live from `https://chatgpt.com/backend-api/codex/models?client_version=…` (only `visibility: 'list'`),
  cached ~10 min per user. API-key users / failures: fallback list built from `DEFAULT_MODEL`.
- `GET   /api/settings` → `{ settings: Settings }` (per user; defaults from env `DEFAULT_MODEL`, `REASONING_EFFORT`, `REASONING_SUMMARY`)
- `PATCH /api/settings` `Partial<Settings>` → `{ settings }`. Effort is clamped to the model's supported list (model default if unsupported).
  All AI calls use the caller's settings (background jobs use backgroundModel/backgroundEffort when set).

## Background stream identity (v2)
Every event emitted by a background job on `GET /api/notes/:id/events` carries `runId: string` (stable for that job run),
plus `riddlerId` when relevant and `annotationId` once known. The final `annotation` event also carries `runId`.
When a read-along run decides to stay silent it ends with `status { state: 'idle', runId, silent: true }`.
Every run ends with exactly one `status { state: 'idle', runId }`.

## v3: markdown notes, dev-friendly output, richer status
- `Note.content` is **Markdown** (GFM: headings, lists, task lists `- [ ]`, fenced code with language, quotes, inline code).
  Existing plain-text notes are valid Markdown. `anchor` remains an exact substring of `content`; prefer anchoring on plain
  prose or a single code line (no markdown syntax characters at the anchor edges).
- AI `body` / reply text is GFM Markdown. Code uses fenced blocks with a language tag. For architecture, flows, sequences,
  state machines and data models the AI should prefer a fenced ```mermaid block inside the body (rendered by the web UI)
  over the ink `Drawing`; `action: 'draw'` still returns a `Drawing` unless the selection/prompt is clearly a system/flow
  diagram, in which case it may return kind `explain` with a mermaid block.
- Every `status` event (foreground and background) additionally carries `model: string` and `effort: string` (resolved
  from settings) and, when `state` changes, `phase: 'reading' | 'thinking' | 'writing' | 'drawing' | 'done'`.
  Foreground streams emit `status { state:'thinking', phase:'reading' }` immediately on request receipt.

## v4: response style and mind maps
- `Settings` gains `askStyle: 'comment' | 'block'` (default `'comment'`) and `readAlongStyle: 'comment' | 'block'`
  (default `'comment'`). `'block'` means the web client writes the AI answer into the note as a scratchpad block and
  marks the annotation `resolved` (it stays in history under Done); the server still creates the annotation as usual.
  Both are validated and persisted per user like the other settings (Node server and Worker/D1).
- `POST /api/notes/:id/ask` accepts `action: 'mindmap'`: the AI returns `kind: 'explain'` with a body that is a single
  fenced ```mermaid block using Mermaid `mindmap` syntax (root = the note's main topic; 2–4 levels; short labels; no
  special characters that break mindmap syntax). Optional `selection` narrows it to that passage.
