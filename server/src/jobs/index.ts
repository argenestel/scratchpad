import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { db } from '../db.js';
import * as store from '../store.js';
import { review } from '../ai/engine.js';
import type { Emit } from '../types.js';
type Job = { uid: string; noteId: string; riddlerId?: string; nudge: boolean };
const queue: Job[] = [],
  queuedNudges = new Set<string>(),
  runningNudges = new Set<string>();
let active = 0,
  stopped = false;
const listeners = new Map<string, Set<Emit>>();
function key(uid: string, nid: string) {
  return uid + ':' + nid;
}
export function subscribe(uid: string, nid: string, emit: Emit) {
  const k = key(uid, nid);
  let set = listeners.get(k);
  if (!set) {
    set = new Set();
    listeners.set(k, set);
  }
  set.add(emit);
  return () => {
    set!.delete(emit);
    if (!set!.size) listeners.delete(k);
  };
}
export async function publish(uid: string, nid: string, event: string, data: Record<string, unknown>) {
  await Promise.allSettled([...(listeners.get(key(uid, nid)) || [])].map(async (e) => e(event, data)));
}
export function nudge(uid: string, nid: string) {
  const note = store.getNote(uid, nid),
    k = key(uid, nid);
  if (note.mode !== 'thinks' || queuedNudges.has(k)) return false;
  const hash = createHash('sha256').update(note.content).digest('hex');
  const prev = db.prepare('SELECT content_hash FROM reviews WHERE user_id=? AND note_id=?').get(uid, nid) as
    | { content_hash: string }
    | undefined;
  if (!runningNudges.has(k) && prev?.content_hash === hash) return false;
  queuedNudges.add(k);
  queue.push({ uid, noteId: nid, nudge: true });
  pump();
  return true;
}
export function riddle(uid: string, nid: string, ids: string[]) {
  store.getNote(uid, nid);
  for (const id of ids) store.getRiddler(uid, id);
  for (const riddlerId of ids) queue.push({ uid, noteId: nid, riddlerId, nudge: false });
  pump();
  return ids.length;
}
function pump() {
  if (stopped) return;
  while (active < config.concurrency && queue.length) {
    const index = queue.findIndex((j) => !j.nudge || !runningNudges.has(key(j.uid, j.noteId)));
    if (index < 0) return;
    const [j] = queue.splice(index, 1);
    const k = key(j.uid, j.noteId);
    if (j.nudge) {
      queuedNudges.delete(k);
      runningNudges.add(k);
    }
    active++;
    void run(j)
      .catch(() => {})
      .finally(() => {
        active--;
        if (j.nudge) runningNudges.delete(k);
        pump();
      });
  }
}
async function run(j: Job) {
  const { uid, noteId } = j;
  let annotationId: string | undefined;
  const emit: Emit = (event, data) =>
    publish(uid, noteId, event, {
      ...(['status', 'thinking', 'text'].includes(event)
        ? { ...(j.riddlerId ? { riddlerId: j.riddlerId } : {}), ...(annotationId ? { annotationId } : {}) }
        : {}),
      ...data,
    });
  try {
    const note = store.getNote(uid, noteId),
      hash = createHash('sha256').update(note.content).digest('hex');
    if (j.nudge) {
      if (note.mode !== 'thinks') return;
      const previous = db
        .prepare('SELECT content_hash,last_spoke FROM reviews WHERE user_id=? AND note_id=?')
        .get(uid, noteId) as { content_hash: string; last_spoke: number } | undefined;
      if (previous?.content_hash === hash) return;
      if (previous && Date.now() - previous.last_spoke < 45000) return;
    }
    const riddler = j.riddlerId ? store.getRiddler(uid, j.riddlerId) : undefined;
    const placeholder = j.nudge ? undefined : store.newAnnotation(note, j.riddlerId ?? null);
    if (placeholder) {
      store.putAnnotation(uid, placeholder);
      annotationId = placeholder.id;
    }
    await emit('status', {
      state: 'thinking',
      riddlerId: j.riddlerId ?? null,
      label: riddler?.name ?? 'Reading along',
      ...(annotationId ? { annotationId } : {}),
    });
    const result = await review(uid, note, riddler, emit, placeholder);
    const current = store.getNote(uid, noteId);
    if (j.nudge && (current.content !== note.content || current.mode !== 'thinks')) return;
    if (result) {
      if (placeholder) store.getAnnotation(uid, placeholder.id);
      store.putAnnotation(uid, result);
      await emit('annotation', { annotation: result });
    } else if (placeholder) {
      store.deleteAnnotation(uid, placeholder.id);
    }
    if (j.nudge)
      db.prepare(
        'INSERT INTO reviews(note_id,user_id,content_hash,last_spoke) VALUES(?,?,?,?) ON CONFLICT(note_id) DO UPDATE SET content_hash=excluded.content_hash,last_spoke=CASE WHEN excluded.last_spoke>0 THEN excluded.last_spoke ELSE reviews.last_spoke END WHERE reviews.user_id=excluded.user_id',
      ).run(noteId, uid, hash, result ? Date.now() : 0);
  } catch {
    if (annotationId) store.deleteAnnotation(uid, annotationId);
    await emit('error', { error: 'Review failed. Check your sign-in and try again.' });
  } finally {
    await emit('status', { state: 'idle', riddlerId: j.riddlerId ?? null });
  }
}
export function stopJobs() {
  stopped = true;
  queue.length = 0;
}
