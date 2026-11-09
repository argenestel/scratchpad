import { useEffect, useId, useState } from 'react';
import type { Drawing } from '../api';
import { I, Modal } from '../ui';

/** Ink sketch that draws itself step by step, like someone drawing under your text. */
export function DrawingView({ drawing, color, large }: { drawing: Drawing; color: string; large?: boolean }) {
  const steps = drawing.steps ?? [];
  const [shown, setShown] = useState(1);
  const [run, setRun] = useState(0);
  const [big, setBig] = useState(false);
  const fid = useId().replace(/:/g, '');

  // Reveal steps one at a time, timed to the number of strokes in each.
  useEffect(() => {
    setShown(1);
    let i = 1; let t: number;
    const next = () => {
      if (i >= steps.length) return;
      const strokes = steps[i - 1]?.strokes.length ?? 1;
      t = window.setTimeout(() => { i += 1; setShown(i); next(); }, 500 + strokes * 380);
    };
    next();
    return () => window.clearTimeout(t);
  }, [steps, run]);

  const caption = steps[Math.min(shown, steps.length) - 1]?.caption;

  return (
    <>
      <div className="drawing" style={{ ['--c' as string]: color }}>
        <svg viewBox={drawing.viewBox || '0 0 400 240'} key={run} role="img" aria-label={steps.map((s) => s.caption).filter(Boolean).join('. ') || 'Drawing'}>
          <defs>
            <filter id={`ink-${fid}`}>
              <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" />
              <feDisplacementMap in="SourceGraphic" scale="1.6" />
            </filter>
          </defs>
          <g filter={`url(#ink-${fid})`}>
            {steps.slice(0, shown).map((s, si) => (
              <g key={si}>
                {s.strokes.map((st, k) => (
                  <path key={k} d={st.d} pathLength={1} className="draw-in"
                    style={{ strokeWidth: st.width ?? 2.2, strokeDasharray: 1, strokeDashoffset: 1, animationDelay: `${k * 0.38}s`, ['--dur' as string]: '.8s' }} />
                ))}
                {s.labels?.map((l, k) => (
                  <text key={`l${k}`} x={l.x} y={l.y} className="fade-in" style={{ animationDelay: `${s.strokes.length * 0.38 + k * 0.15}s` }}>{l.text}</text>
                ))}
              </g>
            ))}
          </g>
        </svg>
        <div className="drawing-foot">
          <span className="cap">{caption ?? ''}</span>
          {steps.length > 1 && <span>{Math.min(shown, steps.length)}/{steps.length}</span>}
          <button onClick={() => setRun((r) => r + 1)} title="Draw again" aria-label="Draw again"><I.replay size={13} /></button>
          {!large && <button onClick={() => setBig(true)}>See it larger</button>}
        </div>
      </div>
      {big && (
        <Modal title="Sketch" wide onClose={() => setBig(false)}>
          <DrawingView drawing={drawing} color={color} large />
        </Modal>
      )}
    </>
  );
}
