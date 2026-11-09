// Typed client for the doddled server. Mirrors /CONTRACT.md.

export type Mode = 'thinks' | 'ask';
export type User = { id: string; email: string | null; name: string | null; plan: string | null; authMethod: 'chatgpt' | 'apikey' };
export type AuthMethods = { browser: boolean; device: boolean; codexImport: boolean; apiKey: boolean };
export type NoteSummary = { id: string; title: string; snippet: string; mode: Mode; inkColor: string; updatedAt: number; annotationCount: number };
export type Note = {
  id: string; title: string; content: string; mode: Mode; purpose: string; inkColor: string;
  riddlerIds: string[]; createdAt: number; updatedAt: number;
};
export type Riddler = { id: string; name: string; persona: string; color: string; builtin: boolean };
export type DrawingStep = { caption?: string; strokes: { d: string; width?: number }[]; labels?: { x: number; y: number; text: string }[] };
export type Drawing = { viewBox: string; steps: DrawingStep[] };
export type AnnotationKind = 'question' | 'explain' | 'drawing' | 'comment';
export type Reply = { id: string; role: 'user' | 'ai'; body: string; thinking: string | null; createdAt: number };
export type Annotation = {
  id: string; noteId: string; kind: AnnotationKind; anchor: string | null; body: string; drawing: Drawing | null;
  riddlerId: string | null; thinking: string | null; status: 'open' | 'resolved' | 'dismissed'; replies: Reply[]; createdAt: number;
};
export type ModelInfo = { id: string; name: string; description: string; defaultEffort: string; efforts: string[] };
export type Summary = 'concise' | 'detailed' | 'auto' | 'off';
export type Settings = { model: string; effort: string; summary: Summary; backgroundModel: string | null; backgroundEffort: string | null };
export type AskAction = 'ask' | 'explain' | 'draw' | 'question';

type RunTag = { runId?: string; annotationId?: string; riddlerId?: string | null };
export type StreamEvent =
  | ({ type: 'status'; state: 'thinking' | 'writing' | 'drawing' | 'idle'; label?: string; silent?: boolean } & RunTag)
  | ({ type: 'thinking'; delta: string } & RunTag)
  | ({ type: 'text'; delta: string } & RunTag)
  | ({ type: 'annotation'; annotation: Annotation } & RunTag)
  | ({ type: 'error'; error: string } & RunTag)
  | { type: 'done' }
  | { type: 'ping' };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    if (res.status === 401) window.dispatchEvent(new CustomEvent('dd:unauthorized'));
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

/** Parse an SSE byte stream into events. */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) continue;
      try { yield { type: event, ...JSON.parse(data.join('\n')) } as StreamEvent; } catch { /* skip malformed */ }
    }
  }
}

async function stream(path: string, body: unknown, onEvent: (e: StreamEvent) => void, signal?: AbortSignal) {
  const res = await fetch(path, {
    method: 'POST', credentials: 'same-origin', signal,
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    throw new ApiError(res.status, msg);
  }
  for await (const ev of parseSSE(res.body)) onEvent(ev);
}

export const api = {
  me: () => req<{ user: User | null; methods: AuthMethods }>('GET', '/api/auth/me'),
  startBrowser: () => req<{ url: string }>('POST', '/api/auth/chatgpt/start'),
  startDevice: () => req<{ deviceId: string; userCode: string; verificationUrl: string; interval: number }>('POST', '/api/auth/chatgpt/device'),
  pollDevice: (deviceId: string) => req<{ status: 'pending' } | { status: 'ok'; user: User }>('POST', '/api/auth/chatgpt/device/poll', { deviceId }),
  codexImport: () => req<{ user: User }>('POST', '/api/auth/codex-import'),
  apiKey: () => req<{ user: User }>('POST', '/api/auth/apikey'),
  logout: () => req<{ ok: true }>('POST', '/api/auth/logout'),

  models: () => req<{ models: ModelInfo[]; source: 'live' | 'fallback' }>('GET', '/api/models'),
  settings: () => req<{ settings: Settings }>('GET', '/api/settings'),
  patchSettings: (b: Partial<Settings>) => req<{ settings: Settings }>('PATCH', '/api/settings', b),

  notes: () => req<{ notes: NoteSummary[] }>('GET', '/api/notes'),
  createNote: (b: Partial<Pick<Note, 'title' | 'content' | 'mode' | 'purpose'>> = {}) => req<{ note: Note }>('POST', '/api/notes', b),
  note: (id: string) => req<{ note: Note; annotations: Annotation[] }>('GET', `/api/notes/${id}`),
  patchNote: (id: string, b: Partial<Note>) => req<{ note: Note }>('PATCH', `/api/notes/${id}`, b),
  deleteNote: (id: string) => req<{ ok: true }>('DELETE', `/api/notes/${id}`),

  riddlers: () => req<{ riddlers: Riddler[] }>('GET', '/api/riddlers'),
  createRiddler: (b: Pick<Riddler, 'name' | 'persona' | 'color'>) => req<{ riddler: Riddler }>('POST', '/api/riddlers', b),
  patchRiddler: (id: string, b: Partial<Riddler>) => req<{ riddler: Riddler }>('PATCH', `/api/riddlers/${id}`, b),
  deleteRiddler: (id: string) => req<{ ok: true }>('DELETE', `/api/riddlers/${id}`),

  patchAnnotation: (id: string, b: { status: Annotation['status'] }) => req<{ annotation: Annotation }>('PATCH', `/api/annotations/${id}`, b),
  deleteAnnotation: (id: string) => req<{ ok: true }>('DELETE', `/api/annotations/${id}`),

  ask: (noteId: string, b: { prompt: string; selection?: string; action?: AskAction; riddlerId?: string }, on: (e: StreamEvent) => void, signal?: AbortSignal) =>
    stream(`/api/notes/${noteId}/ask`, b, on, signal),
  reply: (annotationId: string, text: string, on: (e: StreamEvent) => void, signal?: AbortSignal) =>
    stream(`/api/annotations/${annotationId}/reply`, { text }, on, signal),
  riddle: (noteId: string, riddlerIds: string[]) => req<{ queued: number }>('POST', `/api/notes/${noteId}/riddle`, { riddlerIds }),
  nudge: (noteId: string) => req<{ queued: boolean }>('POST', `/api/notes/${noteId}/nudge`, {}),

  /** Long-lived SSE for background agents on a note. Returns a closer. */
  events(noteId: string, on: (e: StreamEvent) => void): () => void {
    const es = new EventSource(`/api/notes/${noteId}/events`, { withCredentials: true });
    for (const t of ['status', 'thinking', 'text', 'annotation', 'error', 'ping'] as const) {
      es.addEventListener(t, (m) => {
        try { on({ type: t, ...JSON.parse((m as MessageEvent).data || '{}') } as StreamEvent); } catch { /* ignore */ }
      });
    }
    return () => es.close();
  },
};
