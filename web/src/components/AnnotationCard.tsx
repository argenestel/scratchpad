import { useEffect, useRef, useState } from 'react';
import { api, type Annotation, type Riddler } from '../api';
import { I, Markdown, timeAgo, toast } from '../ui';
import { DrawingView } from './DrawingView';

export type Live = { state: 'thinking' | 'writing' | 'drawing' | 'idle'; thinking: string; text: string; label?: string; startedAt: number; silent?: boolean };

function useElapsed(since: number | undefined, running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return since ? Math.max(0, Math.round((now - since) / 1000)) : 0;
}

const KIND: Record<Annotation['kind'], string> = { question: 'Question', explain: 'Explains', drawing: 'Sketch', comment: 'Note' };

export function Thinking({ text, live, label }: { text: string | null | undefined; live?: boolean; label?: string }) {
  if (!text && !live) return null;
  return (
    <details key={live ? 'live' : 'done'} className={`thinking ${live ? 'live' : ''}`} open={live && !!text ? true : undefined}>
      <summary>
        <I.chevron />
        {live ? <span className="shimmer">{label || 'Thinking'}…</span> : <span>Thought for a moment</span>}
      </summary>
      {text && <div className="body"><Markdown text={text.replace(/\*\*\*\*/g, '**\n\n**')} /></div>}
    </details>
  );
}

/** Collapse long margin notes so they don't push later notes far away from their anchors. */
function Clamp({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const check = () => setOverflows(el.scrollHeight > el.clientHeight + 4);
    check();
    const ro = new ResizeObserver(check); ro.observe(el);
    return () => ro.disconnect();
  }, [children, open]);
  if (!enabled) return <>{children}</>;
  return (
    <>
      <div ref={ref} className={`clamp ${open ? 'open' : ''} ${overflows && !open ? 'faded' : ''}`}>{children}</div>
      {(overflows || open) && <button className="more-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Show less' : 'Show more'}</button>}
    </>
  );
}

export function AnnotationCard({ a, live, riddler, inkColor, onHover, onUpdate, onRemove }: {
  a: Annotation; live?: Live; riddler?: Riddler; inkColor: string;
  onHover: (id: string | null) => void; onUpdate: (a: Annotation) => void; onRemove: (id: string) => void;
}) {
  const color = riddler?.color ?? inkColor;
  const [reply, setReply] = useState('');
  const [replyLive, setReplyLive] = useState<{ user: string; thinking: string; text: string } | null>(null);
  const [showReply, setShowReply] = useState(false);
  const abortRef = useRef<AbortController>();
  const streaming = !!live && live.state !== 'idle';
  const elapsed = useElapsed(live?.startedAt, streaming);
  const body = streaming ? live.text : a.body;

  const send = async () => {
    const text = reply.trim();
    if (!text || replyLive) return;
    setReply(''); setReplyLive({ user: text, thinking: '', text: '' });
    const ac = new AbortController(); abortRef.current = ac;
    try {
      await api.reply(a.id, text, (e) => {
        if (e.type === 'thinking') setReplyLive((r) => r && { ...r, thinking: r.thinking + e.delta });
        else if (e.type === 'text') setReplyLive((r) => r && { ...r, text: r.text + e.delta });
        else if (e.type === 'annotation') onUpdate(e.annotation);
        else if (e.type === 'error') toast(e.error, 'error');
      }, ac.signal);
    } catch (e) { if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'error'); }
    finally { setReplyLive(null); }
  };

  const setStatus = async (status: Annotation['status']) => {
    try { const r = await api.patchAnnotation(a.id, { status }); onUpdate(r.annotation); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const remove = async () => {
    try { await api.deleteAnnotation(a.id); onRemove(a.id); } catch (e) { toast((e as Error).message, 'error'); }
  };

  return (
    <div className="ann-card" style={{ ['--c' as string]: color }}
      onMouseEnter={() => onHover(a.id)} onMouseLeave={() => onHover(null)}>
      <div className="ann-head">
        <span className="kind">{streaming ? (live.state === 'drawing' ? 'Sketching' : live.state === 'writing' ? 'Writing' : 'Thinking') : live?.silent ? 'Read along' : KIND[a.kind]}</span>
        {riddler && <span className="who">{riddler.name}</span>}
        {streaming ? <span>{elapsed}s</span> : !live && <span>{timeAgo(a.createdAt)}</span>}
        {!live && (
          <span className="acts">
            {a.status === 'open'
              ? <button className="icon-btn" title="Resolve" aria-label="Resolve" onClick={() => setStatus('resolved')}><I.check /></button>
              : <button className="icon-btn" title="Reopen" aria-label="Reopen" onClick={() => setStatus('open')}><I.replay /></button>}
            <button className="icon-btn" title="Delete" aria-label="Delete" onClick={remove}><I.trash /></button>
          </span>
        )}
      </div>
      {a.anchor && <p className="ann-anchor">“{a.anchor}”</p>}

      {live?.silent && <div className="ink" style={{ opacity: 0.7 }}>Nothing worth adding yet. Keep going.</div>}
      <Thinking text={live ? live.thinking : a.thinking} live={streaming && !body} label={live?.label} />

      {a.drawing && !streaming && <DrawingView drawing={a.drawing} color={color} />}
      {(body || streaming) && (
        <Clamp enabled={!streaming}>
          <div className="ink"><Markdown text={body} caret={streaming && live.state === 'writing'} /></div>
        </Clamp>
      )}

      {(a.replies.length > 0 || replyLive) && (
        <div className="replies">
          {a.replies.map((r) => r.role === 'user'
            ? <div key={r.id} className="reply user">{r.body}</div>
            : <div key={r.id} className="reply ai"><Thinking text={r.thinking} /><div className="ink"><Markdown text={r.body} /></div></div>)}
          {replyLive && <>
            <div className="reply user">{replyLive.user}</div>
            <div className="reply ai">
              <Thinking text={replyLive.thinking} live={!replyLive.text} />
              {replyLive.text && <div className="ink"><Markdown text={replyLive.text} caret /></div>}
            </div>
          </>}
        </div>
      )}

      {!live && (showReply || a.replies.length > 0 ? (
        <div className="reply-box">
          <textarea rows={1} value={reply} placeholder="Reply…" autoFocus={showReply && a.replies.length === 0}
            onChange={(e) => { setReply(e.target.value); e.target.style.height = 'auto'; e.target.style.height = e.target.scrollHeight + 'px'; }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
          {replyLive
            ? <button className="icon-btn" aria-label="Stop" onClick={() => abortRef.current?.abort()}><I.stop /></button>
            : <button className="icon-btn" aria-label="Send reply" disabled={!reply.trim()} onClick={send}><I.send /></button>}
        </div>
      ) : (
        <button className="btn ghost sm" style={{ marginTop: 6, marginLeft: -8, color: 'var(--text-3)' }} onClick={() => setShowReply(true)}>
          <I.chat /> Reply
        </button>
      ))}
    </div>
  );
}
