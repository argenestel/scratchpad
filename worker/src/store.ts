// Adapted from server/src/store.ts: asynchronous D1 persistence.
import { missing } from './http.js';
import type { Bindings, Note, Annotation, Riddler } from './types.js';
export function normalizeAnchor(content: string, value: string | null): string | null {
  if (!value) return null;
  if (content.includes(value)) return value;
  const stripped = value.replace(/^[*_`]+|[*_`]+$/g, '');
  return stripped && content.includes(stripped) ? stripped : null;
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

export function createStore(env: Bindings) {
  const db = env.DB;
  async function get<T>(table: string, uid: string, id: string): Promise<T> {
    const row = await db
      .prepare(`SELECT data FROM ${table} WHERE user_id=? AND id=?`)
      .bind(uid, id)
      .first<{ data: string }>();
    return row ? JSON.parse(row.data) : missing();
  }
  async function list<T>(table: string, uid: string, noteId?: string): Promise<T[]> {
    const stmt =
      noteId === undefined
        ? db.prepare(`SELECT data FROM ${table} WHERE user_id=? ORDER BY rowid`).bind(uid)
        : db
            .prepare(`SELECT data FROM ${table} WHERE user_id=? AND note_id=? ORDER BY rowid`)
            .bind(uid, noteId);
    return (await stmt.all<{ data: string }>()).results.map((r) => JSON.parse(r.data));
  }
  const getNote = (uid: string, id: string) => get<Note>('notes', uid, id);
  const notes = (uid: string) => list<Note>('notes', uid);
  const getAnnotation = (uid: string, id: string) => get<Annotation>('annotations', uid, id);
  const annotations = (uid: string, id: string) => list<Annotation>('annotations', uid, id);
  async function putNote(uid: string, n: Note) {
    await db
      .prepare(
        'INSERT INTO notes(id,user_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE notes.user_id=excluded.user_id',
      )
      .bind(n.id, uid, JSON.stringify(n))
      .run();
  }
  async function putAnnotation(uid: string, a: Annotation) {
    const note = await getNote(uid, a.noteId);
    a.anchor = normalizeAnchor(note.content, a.anchor);
    await db
      .prepare(
        'INSERT INTO annotations(id,user_id,note_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE annotations.user_id=excluded.user_id',
      )
      .bind(a.id, uid, a.noteId, JSON.stringify(a))
      .run();
  }
  async function deleteAnnotation(uid: string, id: string) {
    await db.prepare('DELETE FROM annotations WHERE user_id=? AND id=?').bind(uid, id).run();
  }
  function newAnnotation(note: Note, riddlerId: string | null = null): Annotation {
    return {
      id: crypto.randomUUID(),
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
  async function seedRiddlers(uid: string) {
    if (await db.prepare('SELECT user_id FROM builtin_seeds WHERE user_id=?').bind(uid).first()) return;
    // Each statement checks the seed marker; D1 batch executes atomically.
    const statements = builtins.map(([id, name, persona, color]) => {
      const r: Riddler = { id: 'builtin-' + id, name, persona, color, builtin: true };
      return db
        .prepare(
          'INSERT OR IGNORE INTO riddlers(id,user_id,data) SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM builtin_seeds WHERE user_id=?)',
        )
        .bind(uid + '_' + r.id, uid, JSON.stringify(r), uid);
    });
    statements.push(db.prepare('INSERT OR IGNORE INTO builtin_seeds(user_id) VALUES(?)').bind(uid));
    await db.batch(statements);
  }
  async function riddlers(uid: string) {
    await seedRiddlers(uid);
    return list<Riddler>('riddlers', uid);
  }
  async function getRiddler(uid: string, id: string) {
    return (await riddlers(uid)).find((r) => r.id === id) || missing();
  }
  async function putRiddler(uid: string, r: Riddler) {
    await db
      .prepare(
        'INSERT INTO riddlers(id,user_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE riddlers.user_id=excluded.user_id',
      )
      .bind(uid + '_' + r.id, uid, JSON.stringify(r))
      .run();
  }
  async function removeRiddler(uid: string, id: string) {
    const all = await notes(uid);
    const statements = [
      db.prepare('DELETE FROM riddlers WHERE user_id=? AND id=?').bind(uid, uid + '_' + id),
    ];
    for (const n of all)
      if (n.riddlerIds.includes(id))
        statements.push(
          db
            .prepare('UPDATE notes SET data=? WHERE user_id=? AND id=?')
            .bind(JSON.stringify({ ...n, riddlerIds: n.riddlerIds.filter((r) => r !== id) }), uid, n.id),
        );
    await db.batch(statements);
  }
  return {
    getNote,
    notes,
    putNote,
    annotations,
    getAnnotation,
    putAnnotation,
    deleteAnnotation,
    newAnnotation,
    normalizeAnchor,
    seedRiddlers,
    riddlers,
    getRiddler,
    putRiddler,
    removeRiddler,
  };
}
