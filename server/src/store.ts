import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { missing } from './http.js';
import type { Note, Annotation, Riddler } from './types.js';
type Row = { data: string };
function decode<T>(r: unknown): T | undefined {
  return r ? JSON.parse((r as Row).data) : undefined;
}
export function getNote(uid: string, id: string): Note {
  return (
    decode<Note>(db.prepare('SELECT data FROM notes WHERE user_id=? AND id=?').get(uid, id)) || missing()
  );
}
export function notes(uid: string): Note[] {
  return db
    .prepare('SELECT data FROM notes WHERE user_id=?')
    .all(uid)
    .map((r) => decode<Note>(r)!);
}
export function putNote(uid: string, n: Note) {
  db.prepare(
    'INSERT INTO notes(id,user_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE notes.user_id=excluded.user_id',
  ).run(n.id, uid, JSON.stringify(n));
}
export function annotations(uid: string, noteId: string): Annotation[] {
  return db
    .prepare('SELECT data FROM annotations WHERE user_id=? AND note_id=? ORDER BY rowid')
    .all(uid, noteId)
    .map((r) => decode<Annotation>(r)!);
}
export function getAnnotation(uid: string, id: string): Annotation {
  return (
    decode<Annotation>(db.prepare('SELECT data FROM annotations WHERE user_id=? AND id=?').get(uid, id)) ||
    missing()
  );
}
export function putAnnotation(uid: string, a: Annotation) {
  const note = getNote(uid, a.noteId);
  if (a.anchor && !note.content.includes(a.anchor)) a.anchor = null;
  db.prepare(
    'INSERT INTO annotations(id,user_id,note_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE annotations.user_id=excluded.user_id',
  ).run(a.id, uid, a.noteId, JSON.stringify(a));
}
export function deleteAnnotation(uid: string, id: string) {
  db.prepare('DELETE FROM annotations WHERE user_id=? AND id=?').run(uid, id);
}
export function newAnnotation(note: Note, riddlerId: string | null = null): Annotation {
  return {
    id: randomUUID(),
    noteId: note.id,
    kind: 'comment',
    anchor: null,
    body: '',
    drawing: null,
    riddlerId,
    thinking: null,
    status: 'open',
    replies: [],
    createdAt: Date.now(),
  };
}
const builtins = [
  [
    'staff-engineer',
    'Staff Engineer',
    'Review as a pragmatic staff engineer. Probe system boundaries, failure modes, operational cost, and tradeoffs. Ask the most consequential technical question.',
    '#2b4acb',
  ],
  [
    'editor',
    'Editor',
    'Review as a precise editor. Question unclear intent, unsupported claims, structure and audience. Never rewrite the author’s prose.',
    '#a35865',
  ],
  [
    'investor',
    'Investor',
    'Review as a disciplined investor. Probe customer pain, distribution, differentiation, market size and economic assumptions.',
    '#52826b',
  ],
  [
    'professor',
    'Professor',
    'Review as a patient professor. Test understanding with sharp questions, illuminate concepts briefly, and respect requests to quiz the writer.',
    '#8362a0',
  ],
  [
    'skeptic',
    'Skeptic',
    'Review as a fair skeptic. Surface hidden assumptions, counterexamples, missing evidence and falsifiable predictions.',
    '#b17c35',
  ],
];
export function seedRiddlers(uid: string) {
  if (db.prepare('SELECT user_id FROM builtin_seeds WHERE user_id=?').get(uid)) return;
  db.transaction(() => {
    for (const [id, name, persona, color] of builtins) {
      const r: Riddler = { id: 'builtin-' + id, name, persona, color, builtin: true };
      db.prepare('INSERT OR IGNORE INTO riddlers(id,user_id,data) VALUES(?,?,?)').run(
        uid + '_' + r.id,
        uid,
        JSON.stringify(r),
      );
    }
    db.prepare('INSERT INTO builtin_seeds(user_id) VALUES(?)').run(uid);
  })();
}
export function riddlers(uid: string): Riddler[] {
  seedRiddlers(uid);
  return db
    .prepare('SELECT data FROM riddlers WHERE user_id=? ORDER BY rowid')
    .all(uid)
    .map((r) => decode<Riddler>(r)!);
}
export function getRiddler(uid: string, id: string): Riddler {
  return riddlers(uid).find((r) => r.id === id) || missing();
}
export function putRiddler(uid: string, r: Riddler) {
  db.prepare(
    'INSERT INTO riddlers(id,user_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE riddlers.user_id=excluded.user_id',
  ).run(uid + '_' + r.id, uid, JSON.stringify(r));
}
export function removeRiddler(uid: string, id: string) {
  db.transaction(() => {
    db.prepare('DELETE FROM riddlers WHERE user_id=? AND id=?').run(uid, uid + '_' + id);
    for (const n of notes(uid))
      if (n.riddlerIds.includes(id)) putNote(uid, { ...n, riddlerIds: n.riddlerIds.filter((x) => x !== id) });
  })();
}

// Existing users are seeded at boot; new users are seeded when their session is created.
for (const row of db.prepare('SELECT id FROM users').all() as { id: string }[]) seedRiddlers(row.id);
