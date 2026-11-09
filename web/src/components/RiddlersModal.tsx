import { useState } from 'react';
import { api, type Riddler } from '../api';
import { I, INKS, Modal, toast } from '../ui';

const IDEAS = [
  { name: 'Security Reviewer', persona: 'Assumes every input is hostile. Asks how this gets abused, leaked, or escalated.' },
  { name: 'First-time User', persona: 'Has never seen this before. Flags jargon, missing steps, and anything confusing.' },
  { name: 'Historian', persona: 'Connects ideas to precedent. Asks who tried this before and what happened.' },
];

export function RiddlersModal({ riddlers, onChange, onClose }: { riddlers: Riddler[]; onChange: (r: Riddler[]) => void; onClose: () => void }) {
  const [editing, setEditing] = useState<Partial<Riddler> | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!editing?.name?.trim() || !editing.persona?.trim()) return;
    setBusy(true);
    try {
      const body = { name: editing.name.trim(), persona: editing.persona.trim(), color: editing.color ?? INKS[riddlers.length % INKS.length] };
      if (editing.id) {
        const { riddler } = await api.patchRiddler(editing.id, body);
        onChange(riddlers.map((r) => (r.id === riddler.id ? riddler : r)));
      } else {
        const { riddler } = await api.createRiddler(body);
        onChange([...riddlers, riddler]);
      }
      setEditing(null);
    } catch (e) { toast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  };

  const remove = async (r: Riddler) => {
    try { await api.deleteRiddler(r.id); onChange(riddlers.filter((x) => x.id !== r.id)); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <Modal title={editing ? (editing.id ? 'Edit riddler' : 'New riddler') : 'Riddlers'} onClose={onClose}>
      {editing ? (
        <>
          <div className="field">
            <label htmlFor="rn">Name</label>
            <input id="rn" autoFocus value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Staff Engineer" />
          </div>
          <div className="field">
            <label htmlFor="rp">Point of view</label>
            <textarea id="rp" value={editing.persona ?? ''} onChange={(e) => setEditing({ ...editing, persona: e.target.value })}
              placeholder="Has run this in production. Cares about failure modes, operability, and what breaks at 3am." />
          </div>
          {!editing.id && (
            <div className="presets" style={{ marginBottom: 14 }}>
              {IDEAS.map((i) => <button key={i.name} className="chip" onClick={() => setEditing({ ...editing, ...i })}>{i.name}</button>)}
            </div>
          )}
          <div className="field">
            <label>Ink</label>
            <div className="swatches" style={{ padding: 0 }}>
              {INKS.map((c) => <button key={c} className={`swatch ${(editing.color ?? INKS[0]) === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setEditing({ ...editing, color: c })} />)}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setEditing(null)}>Back</button>
            <button className="btn primary" disabled={busy || !editing.name?.trim() || !editing.persona?.trim()} onClick={save}>{editing.id ? 'Save' : 'Create riddler'}</button>
          </div>
        </>
      ) : (
        <>
          <p style={{ marginTop: 0, color: 'var(--text-2)', fontSize: 14 }}>Reviewers with different points of view. Pick some on a note and choose <b>Riddle it</b>. Each one reads it in the background and leaves notes in its own ink.</p>
          {riddlers.map((r) => (
            <div key={r.id} className="riddler-row">
              <div className="riddler-face" style={{ background: r.color }}>{r.name[0]}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="r-name">{r.name} {r.builtin && <span className="badge">built-in</span>}</div>
                <div className="r-persona">{r.persona}</div>
              </div>
              <button className="icon-btn" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><I.pen /></button>
              {!r.builtin && <button className="icon-btn" aria-label={`Delete ${r.name}`} onClick={() => remove(r)}><I.trash /></button>}
            </div>
          ))}
          <button className="btn" style={{ marginTop: 6 }} onClick={() => setEditing({ color: INKS[riddlers.length % INKS.length] })}><I.plus /> New riddler</button>
        </>
      )}
    </Modal>
  );
}
