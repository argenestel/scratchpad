import { DurableObject } from 'cloudflare:workers';
import { createStore } from './store.js';
import { createEngine } from './shared/engine.js';
import { createSettings } from './settings.js';
import { statusEmitter } from '../../server/src/ai/status.js';
import type { AIOptions, Bindings, Emit } from './types.js';

type Job = {
  id: string;
  uid: string;
  noteId: string;
  nudge: boolean;
  riddlerId?: string;
  running?: boolean;
  annotationId?: string;
  completed?: boolean;
};
type QueueState = { uid?: string; noteId?: string; jobs: Job[] };
type Subscriber = { controller: ReadableStreamDefaultController<Uint8Array>; close: () => void };
const encoder = new TextEncoder();
const STATE_KEY = 'queue';
const COOLDOWN = 45_000;

async function contentHash(content: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(content)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A room is addressed by the authenticated user and note, never by a client-supplied object ID. */
export class NoteRoom extends DurableObject<Bindings> {
  private state: QueueState = { jobs: [] };
  private subscribers = new Set<Subscriber>();
  private lock: Promise<unknown> = Promise.resolve();
  private alarmActive = false;
  private store: ReturnType<typeof createStore>;
  private engine: ReturnType<typeof createEngine>;
  private settings: ReturnType<typeof createSettings>;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.store = createStore(env);
    this.engine = createEngine(env);
    this.settings = createSettings(env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<QueueState>(STATE_KEY)) ?? { jobs: [] };
      // Both an interrupted nudge and its queued successor read the latest content on
      // recovery, so one recovered nudge covers both. Retain its stable run/annotation ID.
      let recoveredNudge = false;
      this.state.jobs = this.state.jobs.filter((job) => {
        if (job.completed || (job.nudge && recoveredNudge)) return false;
        if (job.nudge) recoveredNudge = true;
        job.running = false;
        return true;
      });
      await this.persist();
    });
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.lock.then(work);
    this.lock = result.catch(() => {});
    return result;
  }

  private async persist() {
    // Persist queue and wakeup together, so an accepted job always has a durable alarm.
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put(STATE_KEY, this.state);
      // While a handler is active, keep a recovery wakeup without repeatedly scheduling
      // immediate alarms. Its finally block brings pending work forward again.
      if (this.state.jobs.length) await storage.setAlarm(Date.now() + (this.alarmActive ? 60_000 : 1));
      else await storage.deleteAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    const uid = request.headers.get('x-user-id');
    const noteId = request.headers.get('x-note-id');
    if (!uid || !noteId) return Response.json({ error: 'Missing room identity' }, { status: 400 });
    const valid = await this.exclusive(async () => {
      if (this.state.uid && (this.state.uid !== uid || this.state.noteId !== noteId)) return false;
      if (!this.state.uid) {
        this.state.uid = uid;
        this.state.noteId = noteId;
        await this.persist();
      }
      return true;
    });
    if (!valid) return Response.json({ error: 'Room identity mismatch' }, { status: 403 });
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && path === '/events') return this.events(request);
    if (request.method !== 'POST') return Response.json({ error: 'Not found' }, { status: 404 });
    if (path === '/nudge') {
      const queued = await this.exclusive(async () => {
        const note = await this.store.getNote(uid, noteId);
        if (note.mode !== 'thinks' || this.state.jobs.some((job) => job.nudge && !job.running)) return false;
        if (!this.state.jobs.some((job) => job.nudge && job.running)) {
          const hash = await contentHash(note.content);
          const previous = await this.env.DB.prepare(
            'SELECT content_hash FROM reviews WHERE user_id=? AND note_id=?',
          )
            .bind(uid, noteId)
            .first<{ content_hash: string }>();
          if (previous?.content_hash === hash) return false;
        }
        this.state.jobs.push({ id: crypto.randomUUID(), uid, noteId, nudge: true });
        await this.persist();
        return true;
      });
      return Response.json({ queued });
    }
    if (path === '/riddle') {
      let data: unknown;
      try {
        data = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
      }
      const ids = (data as { riddlerIds?: unknown } | null)?.riddlerIds;
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        return Response.json({ error: 'riddlerIds must be an array of strings' }, { status: 400 });
      }
      await this.store.getNote(uid, noteId);
      await Promise.all(ids.map((id: string) => this.store.getRiddler(uid, id)));
      await this.exclusive(async () => {
        for (const riddlerId of ids as string[]) {
          this.state.jobs.push({ id: crypto.randomUUID(), uid, noteId, nudge: false, riddlerId });
        }
        await this.persist();
      });
      return Response.json({ queued: ids.length });
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  private events(request: Request): Response {
    if (this.subscribers.size >= 128)
      return Response.json({ error: 'Too many subscribers' }, { status: 429 });
    let close = () => {};
    const stream = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          let closed = false;
          let timer: ReturnType<typeof setInterval> | undefined;
          const subscriber: Subscriber = { controller, close: () => close() };
          close = () => {
            if (closed) return;
            closed = true;
            if (timer) clearInterval(timer);
            request.signal.removeEventListener('abort', close);
            this.subscribers.delete(subscriber);
            try {
              controller.close();
            } catch {
              /* Already cancelled. */
            }
          };
          this.subscribers.add(subscriber);
          request.signal.addEventListener('abort', close, { once: true });
          controller.enqueue(encoder.encode('event: ping\ndata: {}\n\n'));
          timer = setInterval(
            () => this.send(subscriber, encoder.encode('event: ping\ndata: {}\n\n')),
            20_000,
          );
          if (request.signal.aborted) close();
        },
        cancel: () => close(),
      },
      { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
    );
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  private send(subscriber: Subscriber, frame: Uint8Array) {
    // A slow browser must never block a model stream or accumulate an unbounded queue.
    if ((subscriber.controller.desiredSize ?? 0) < frame.byteLength) {
      subscriber.close();
      return;
    }
    try {
      subscriber.controller.enqueue(frame);
    } catch {
      subscriber.close();
    }
  }

  private publish: Emit = (event, data) => {
    const frame = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const subscriber of this.subscribers) this.send(subscriber, frame);
  };

  async alarm(): Promise<void> {
    if (this.alarmActive) return;
    this.alarmActive = true;
    const concurrency = Math.max(1, Math.min(16, Number.parseInt(this.env.JOB_CONCURRENCY || '3', 10) || 3));
    // Limit one alarm invocation to a batch. Jobs accepted during it retain their own wakeup.
    let jobs: Job[] = [];
    try {
      jobs = await this.exclusive(async () => {
        this.state.jobs = this.state.jobs.filter((job) => !job.completed);
        let nudgeRunning = this.state.jobs.some((job) => job.nudge && job.running);
        const selected: Job[] = [];
        for (const job of this.state.jobs) {
          if (selected.length >= concurrency) break;
          if (job.running || (job.nudge && nudgeRunning)) continue;
          job.running = true;
          if (job.nudge) nudgeRunning = true;
          selected.push(job);
        }
        await this.persist();
        return selected;
      });
      // Settle the entire batch before allowing another alarm to claim concurrency slots.
      const results = await Promise.allSettled(
        jobs.map(async (job) => {
          await this.run(job);
          await this.exclusive(async () => {
            this.state.jobs = this.state.jobs.filter((candidate) => candidate.id !== job.id);
            await this.persist();
          });
        }),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    } finally {
      await this.exclusive(async () => {
        // Release claims even when a storage failure causes the platform to retry this
        // alarm in the same isolate. Completed checkpoints must never invoke AI again.
        for (const job of this.state.jobs) job.running = false;
        this.state.jobs = this.state.jobs.filter((job) => !job.completed);
        this.alarmActive = false;
        await this.persist();
      });
    }
  }

  private async run(job: Job) {
    const { uid, noteId } = job;
    const runId = job.id;
    let annotationId: string | undefined = job.annotationId;
    let silent = job.nudge;
    let options: AIOptions = {
      model: this.env.DEFAULT_MODEL || 'gpt-6.1-sol',
      effort: this.env.REASONING_EFFORT || 'medium',
      summary: this.env.REASONING_SUMMARY || 'concise',
    };
    let finished = false;
    const emit: Emit = (event, data) => {
      // Even if a provider emits its own terminal status, this room owns the single final idle.
      if (event === 'status' && data.state === 'idle' && !finished) return;
      if (!annotationId && typeof data.annotationId === 'string') annotationId = job.annotationId ?? job.id;
      return statusEmitter(this.publish, options)(event, {
        ...data,
        runId,
        ...(job.riddlerId ? { riddlerId: job.riddlerId } : {}),
        ...(annotationId ? { annotationId } : {}),
      });
    };
    try {
      options = await this.settings.aiOptions(uid, true);
      const note = await this.store.getNote(uid, noteId);
      const hash = await contentHash(note.content);
      if (job.nudge) {
        if (note.mode !== 'thinks') return;
        const previous = await this.env.DB.prepare(
          'SELECT content_hash,last_spoke FROM reviews WHERE user_id=? AND note_id=?',
        )
          .bind(uid, noteId)
          .first<{ content_hash: string; last_spoke: number }>();
        if (previous?.content_hash === hash || (previous && Date.now() - previous.last_spoke < COOLDOWN))
          return;
      }
      const riddler = job.riddlerId ? await this.store.getRiddler(uid, job.riddlerId) : undefined;
      const placeholder = job.nudge ? undefined : this.store.newAnnotation(note, job.riddlerId ?? null);
      if (placeholder) {
        // Reuse a persisted placeholder when an interrupted alarm is recovered.
        placeholder.id = job.annotationId ?? job.id;
        annotationId = placeholder.id;
        await this.exclusive(async () => {
          job.annotationId = annotationId;
          await this.persist();
        });
        await this.store.putAnnotation(uid, placeholder);
      }
      await emit('status', {
        state: 'thinking',
        phase: 'reading',
        riddlerId: job.riddlerId ?? null,
        label: riddler?.name ?? 'Reading along',
      });
      const result = await this.engine.review(uid, note, riddler, emit, placeholder, options);
      const current = await this.store.getNote(uid, noteId);
      if (job.nudge && (current.content !== note.content || current.mode !== 'thinks')) return;
      if (result) {
        if (placeholder) await this.store.getAnnotation(uid, placeholder.id);
        // D1 and DO storage cannot share a transaction. A deterministic annotation key
        // makes an interrupted write an upsert on recovery rather than a duplicate.
        result.id = job.annotationId ?? job.id;
        annotationId = result.id;
        await this.store.putAnnotation(uid, result);
        silent = false;
        await emit('annotation', { annotation: result });
      } else if (placeholder) await this.store.deleteAnnotation(uid, placeholder.id);
      if (job.nudge) {
        await this.env.DB.prepare(
          'INSERT INTO reviews(note_id,user_id,content_hash,last_spoke) VALUES(?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET content_hash=excluded.content_hash,last_spoke=CASE WHEN excluded.last_spoke>0 THEN excluded.last_spoke ELSE reviews.last_spoke END WHERE reviews.user_id=excluded.user_id',
        )
          .bind(noteId, uid, hash, result ? Date.now() : 0)
          .run();
      }
    } catch {
      silent = false;
      if (annotationId) {
        try {
          await this.store.deleteAnnotation(uid, annotationId);
        } catch {
          /* Note may have been deleted. */
        }
      }
      await emit('error', { error: 'Review failed. Check your sign-in and try again.' });
    } finally {
      await this.exclusive(async () => {
        job.completed = true;
        try {
          await this.persist();
        } catch (error) {
          job.completed = false;
          throw error;
        }
      });
      finished = true;
      await emit('status', {
        state: 'idle',
        phase: 'done',
        riddlerId: job.riddlerId ?? null,
        ...(silent ? { silent: true } : {}),
      });
    }
  }
}
