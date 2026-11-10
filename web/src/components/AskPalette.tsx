import { useEffect, useRef, useState } from 'react';
import type { Annotation, AskAction, ModelInfo, ResponseStyle, Riddler, Settings } from '../api';
import { I } from '../ui';
import { AnnotationView } from './AnnotationView';
import type { Run } from './RunProgress';

const ACTIONS: { id: AskAction; label: string; icon: keyof typeof ICONS; hint: string }[] = [
  { id: 'ask', label: 'Ask', icon: 'chat', hint: 'Ask anything about this note' },
  { id: 'explain', label: 'Explain', icon: 'bulb', hint: 'Walk me through it' },
  { id: 'draw', label: 'Diagram', icon: 'draw', hint: 'Sketch or flow diagram' },
  { id: 'question', label: 'Quiz me', icon: 'question', hint: 'Test my understanding' },
  { id: 'mindmap', label: 'Mind map', icon: 'mindmap', hint: 'Map the ideas, written into the note' },
];
const ICONS = { chat: I.chat, bulb: I.bulb, draw: I.draw, question: I.question, mindmap: I.mindmap };

/** ⌘K palette: type a question, watch scratchpad think, read the answer — all in one place. */
export function AskPalette({ quote, riddlers, inkColor, ai, run, result, defaultStyle, runStyle, onSubmit, onClose, onOpenSettings, onUpdate, onRemove }: {
  quote: string | null; riddlers: Riddler[]; inkColor: string;
  ai: { settings: Settings; model?: ModelInfo } | null;
  run: Run | null; result: Annotation | null; defaultStyle: ResponseStyle;
  /** Where the running answer will go (known once a request is sent). */
  runStyle?: ResponseStyle;
  onSubmit: (action: AskAction, prompt: string, quote: string | null, riddlerId: string | null, style: ResponseStyle) => void;
  onClose: () => void; onOpenSettings: () => void;
  onUpdate: (a: Annotation) => void; onRemove: (id: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [action, setAction] = useState<AskAction>('ask');
  const [as, setAs] = useState<string | null>(null);
  const [q, setQ] = useState(quote);
  const [style, setStyle] = useState<ResponseStyle>(defaultStyle);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = !!run || !!result;
  const riddler = riddlers.find((r) => r.id === (result?.riddlerId ?? run?.riddlerId ?? as));

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const submit = () => {
    if (!prompt.trim() && !q) return;
    onSubmit(action, prompt.trim(), q, as, action === 'mindmap' ? 'block' : style);
  };

  return (
    <div className="scrim palette-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="palette" role="dialog" aria-modal aria-label="Ask scratchpad">
        {!busy ? (
          <>
            {q && (
              <div className="palette-quote">
                <span>{q}</span>
                <button className="icon-btn" onClick={() => setQ(null)} aria-label="Remove quoted text"><I.x size={13} /></button>
              </div>
            )}
            <div className="palette-input">
              <I.sparkle size={18} />
              <textarea ref={inputRef} rows={1} value={prompt}
                placeholder={q ? 'What do you want to know about this?' : riddler ? `Ask ${riddler.name}…` : 'Ask scratchpad about this note…'}
                onChange={(e) => { setPrompt(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(180, e.target.scrollHeight)}px`; }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
              <button className="send" disabled={!prompt.trim() && !q} onClick={submit} aria-label="Send"><I.send /></button>
            </div>
            <div className="palette-actions">
              {ACTIONS.map((a) => {
                const Ic = ICONS[a.icon];
                return (
                  <button key={a.id} className={`p-action ${action === a.id ? 'on' : ''}`} onClick={() => setAction(a.id)} title={a.hint}>
                    <Ic size={14} /> {a.label}
                  </button>
                );
              })}
            </div>
            <div className="palette-foot">
              <label className="p-as">
                <span className="dot" style={{ background: riddler?.color ?? inkColor }} />
                <select value={as ?? ''} onChange={(e) => setAs(e.target.value || null)} aria-label="Who answers">
                  <option value="">scratchpad</option>
                  {riddlers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <div className="seg mini" role="radiogroup" aria-label="Reply as" title="Where the answer goes">
                <button role="radio" aria-checked={style === 'comment'} className={style === 'comment' ? 'on' : ''} onClick={() => setStyle('comment')}><I.chat size={12} /> Comment</button>
                <button role="radio" aria-checked={style === 'block'} className={style === 'block' ? 'on' : ''} onClick={() => setStyle('block')}><I.doc size={12} /> Into note</button>
              </div>
              {ai && (
                <button className="chip model-chip" onClick={onOpenSettings} title="Model & thinking">
                  <I.sliders size={13} /> {ai.model?.name ?? ai.settings.model} · {ai.settings.effort}
                </button>
              )}
              <span className="kbd-hint"><kbd>↵</kbd> send <kbd>esc</kbd> close</span>
            </div>
          </>
        ) : (
          <div className="palette-answer">
            {result
              ? <AnnotationView a={result} riddler={riddler} inkColor={inkColor} onUpdate={onUpdate} onRemove={(id) => { onRemove(id); onClose(); }} />
              : run && <AnnotationView a={{ id: run.key, noteId: '', kind: run.kind, anchor: run.anchor, body: '', drawing: null, riddlerId: run.riddlerId, thinking: null, status: 'open', replies: [], createdAt: run.startedAt }}
                  run={run} riddler={riddler} inkColor={inkColor} onUpdate={onUpdate} onRemove={onRemove} />}
            <div className="palette-foot">
              <span className="kbd-hint">{result ? 'Saved as a comment on this note.' : (runStyle ?? style) === 'block' ? 'You can close this. The answer will be written into your note.' : 'You can close this. The answer will be saved as a comment.'}</span>
              <button className="btn sm" onClick={onClose}>{result ? 'Done' : 'Run in background'}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
