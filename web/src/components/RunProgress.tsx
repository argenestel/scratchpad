import { useEffect, useRef, useState } from 'react';
import { I } from '../ui';
import { Md } from './Md';

export type Phase = 'reading' | 'thinking' | 'writing' | 'drawing' | 'done';
/** A live AI run (ask, reply, riddler, or read-along). */
export type Run = {
  key: string; phase: Phase; thinking: string; text: string; startedAt: number;
  model?: string; effort?: string; anchor: string | null; riddlerId: string | null;
  kind: 'question' | 'explain' | 'drawing' | 'comment'; background: boolean; silent?: boolean; annotationId?: string;
  thinkingDoneAt?: number;
};

export function useTicker(running: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => set((x) => x + 1), 500);
    return () => window.clearInterval(t);
  }, [running]);
}
export const secs = (from: number, to = Date.now()) => Math.max(0, (to - from) / 1000);
export const fmtSecs = (s: number) => (s < 10 ? s.toFixed(1) : Math.round(s).toString()) + 's';

/** Step-by-step view of a run: Reading → Thinking → Writing, with live reasoning and output. */
export function RunProgress({ run, who, compact }: { run: Run; who?: string; compact?: boolean }) {
  useTicker(run.phase !== 'done');
  const [showThinking, setShowThinking] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);
  const writingStep = run.phase === 'drawing' || run.kind === 'drawing' ? 'drawing' : 'writing';
  const steps: { id: Phase; label: string }[] = [
    { id: 'reading', label: 'Reading' },
    { id: 'thinking', label: 'Thinking' },
    { id: writingStep, label: writingStep === 'drawing' ? 'Drawing' : 'Writing' },
  ];
  const order: Phase[] = ['reading', 'thinking', writingStep, 'done'];
  const at = order.indexOf(run.phase === 'drawing' || run.phase === 'writing' ? writingStep : run.phase);
  const thinkingSecs = run.thinkingDoneAt ? secs(run.startedAt, run.thinkingDoneAt) : secs(run.startedAt);

  // Collapse the reasoning once output starts; keep it scrolled to the newest line while open.
  useEffect(() => { if (run.text) setShowThinking(false); }, [run.text !== '']);
  useEffect(() => { const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; }, [run.thinking, showThinking]);

  if (run.silent) {
    return <div className="run silent"><I.check size={14} /> {who ?? 'doddled'} read along. Nothing worth adding yet.</div>;
  }

  return (
    <div className={`run ${compact ? 'compact' : ''}`}>
      <div className="run-head">
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.id} className={i < at ? 'done' : i === at ? 'now' : ''}>
              {i < at ? <I.check size={12} /> : i === at ? <span className="spinner" /> : <span className="pip" />}
              {s.label}
            </li>
          ))}
        </ol>
        <span className="run-meta">
          {fmtSecs(secs(run.startedAt))}
          {run.model && <span className="model-tag">{run.model}{run.effort ? ` · ${run.effort}` : ''}</span>}
        </span>
      </div>

      {(run.thinking || at <= 1) && (
        <div className="run-thinking">
          <button className="run-toggle" onClick={() => setShowThinking((v) => !v)}>
            <I.chevron size={12} />
            {at <= 1 ? <span className="shimmer">{run.thinking ? 'Reasoning' : at === 0 ? 'Reading your note' : 'Reasoning'}</span> : <span>Thought for {fmtSecs(thinkingSecs)}</span>}
          </button>
          {showThinking && (run.thinking
            ? <div className="run-thinking-body" ref={boxRef}><Md text={run.thinking.replace(/\*\*\*\*/g, '**\n\n**')} /></div>
            : at <= 1 && <div className="skeleton"><span /><span /></div>)}
        </div>
      )}

      {!compact && at >= 2 && (run.text
        ? <Md text={run.text} streaming className="run-output" />
        : <div className="skeleton tall"><span /><span /><span /></div>)}
    </div>
  );
}
