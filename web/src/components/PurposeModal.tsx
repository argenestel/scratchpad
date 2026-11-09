import { useState } from 'react';
import { Modal } from '../ui';

const PRESETS = [
  'Quiz me on this as I go.',
  'Just listen. Only speak up if something is wrong.',
  'Be brutal. Find the weakest argument.',
  'Explain anything technical like I am new to it.',
  'This is a design doc. Push on edge cases and failure modes.',
  'Help me study for an exam.',
];

export function PurposeModal({ value, onSave, onClose }: { value: string; onSave: (v: string) => void; onClose: () => void }) {
  const [v, setV] = useState(value);
  return (
    <Modal title="What is this note for?" onClose={onClose}>
      <div className="field">
        <label htmlFor="purpose">Tell doddled what this note is for or how to behave in it</label>
        <textarea id="purpose" autoFocus value={v} onChange={(e) => setV(e.target.value)} placeholder="e.g. I'm drafting a pitch for investors. Poke holes in the market sizing." />
        <span className="hint">Applies only to this note. Riddlers keep their own voice but follow it too.</span>
      </div>
      <div className="presets" style={{ marginBottom: 18 }}>
        {PRESETS.map((p) => <button key={p} className="chip" onClick={() => setV(p)}>{p}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {value && <button className="btn ghost" onClick={() => onSave('')}>Clear</button>}
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(v.trim())}>Save</button>
      </div>
    </Modal>
  );
}
