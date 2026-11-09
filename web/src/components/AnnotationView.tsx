import { useRef, useState } from 'react';
import { api, type Annotation, type Riddler, type StreamEvent } from '../api';
import { I, timeAgo, toast } from '../ui';
import { DrawingView } from './DrawingView';
import { Md } from './Md';
import { RunProgress, type Phase, type Run } from './RunProgress';

export const KIND_LABEL: Record<Annotation['kind'], string> = { question: 'Question', explain: 'Explanation', drawing: 'Diagram', comment: 'Note' };

/** Collapsible reasoning summary of a finished answer. */
function Thought({ text }: { text: string | null }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="thought">
      <button className="run-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <I.chevron size={12} /> {open ? 'Hide reasoning' : 'Show reasoning'}
      </button>
      {open && <div className="run-thinking-body"><Md text={text.replace(/\*\*\*\*/g, '**\n\n**')} /></div>}
    </div>
  );
}

/** One AI note: live progress while running, then the answer, reasoning, diagram and a reply thread. */
export function AnnotationView({ a, run, riddler, inkColor, compact, onUpdate, onRemove, onJump }: {
  a: Annotation; run?: Run; riddler?: Riddler; inkColor: string; compact?: boolean;
  onUpdate: (a: Annotation) => void; onRemove: (id: string) => void; onJump?: () => void;
}) {
  const color = riddler?.color ?? inkColor;
  const who = riddler?.name ?? 'scratchpad';
  const [reply, setReply] = useState('');
  const [replyRun, setReplyRun] = useState<(Run & { user: string }) | null>(null);
  const [expanded, setExpanded] = useState(!compact);
  const abortRef = useRef<AbortController>();

  const send = async () => {
    const text = reply.trim();
    if (!text || replyRun) return;
    setReply('');
    setReplyRun({ user: text, key: 'reply', phase: 'reading', thinking: '', text: '', startedAt: Date.now(), anchor: null, riddlerId: a.riddlerId, kind: 'comment', background: false });
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      await api.reply(a.id, text, (e: StreamEvent) => {
        if (e.type === 'status') setReplyRun((r) => r && { ...r, phase: (e.phase as Phase) ?? (e.state === 'writing' ? 'writing' : e.state === 'idle' ? r.phase : 'thinking'), model: e.model ?? r.model, effort: e.effort ?? r.effort });
        else if (e.type === 'thinking') setReplyRun((r) => r && { ...r, phase: r.phase === 'reading' ? 'thinking' : r.phase, thinking: r.thinking + e.delta });
        else if (e.type === 'text') setReplyRun((r) => r && { ...r, phase: 'writing', thinkingDoneAt: r.thinkingDoneAt ?? Date.now(), text: r.text + e.delta });
        else if (e.type === 'annotation') onUpdate(e.annotation);
        else if (e.type === 'error') toast(e.error, 'error');
      }, ac.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'error');
    } finally {
      setReplyRun(null);
    }
  };

  const setStatus = async (status: Annotation['status'], undoable = false) => {
    try {
      onUpdate((await api.patchAnnotation(a.id, { status })).annotation);
      if (undoable) toast('Marked done. It is hidden from your text.', 'info', { label: 'Undo', run: () => void setStatus('open') });
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const remove = async () => {
    try { await api.deleteAnnotation(a.id); onRemove(a.id); } catch (e) { toast((e as Error).message, 'error'); }
  };

  const live = !!run && !run.silent && run.phase !== 'done';

  return (
    <article className={`note-ai ${a.status === 'resolved' ? 'resolved' : ''}`} style={{ ['--c' as string]: color }}>
      <header className="note-ai-head">
        <span className="who-dot" />
        <b>{who}</b>
        <span className="kind">{live ? 'working' : KIND_LABEL[a.kind]}</span>
        {!run && <span className="when">{timeAgo(a.createdAt)}</span>}
        {a.status === 'resolved' && <span className="done-tag"><I.check size={11} /> Done</span>}
        {!run && (
          <span className="acts">
            {a.status === 'open'
              ? <button className="icon-btn" title="Done: hide it from the text (kept under Done)" aria-label="Mark done" onClick={() => setStatus('resolved', true)}><I.check /></button>
              : <button className="icon-btn" title="Reopen: show it in the text again" aria-label="Reopen" onClick={() => setStatus('open')}><I.replay /></button>}
            <button className="icon-btn" title="Delete" aria-label="Delete" onClick={remove}><I.trash /></button>
          </span>
        )}
      </header>

      {a.anchor && (
        <button className="anchor-quote" onClick={onJump} disabled={!onJump} title={onJump ? 'Show in note' : undefined}>{a.anchor}</button>
      )}

      {run ? <RunProgress run={run} who={who} /> : (
        <>
          <Thought text={a.thinking} />
          {a.drawing && <DrawingView drawing={a.drawing} color={color} />}
          {a.body && (
            <div className={`clampable ${expanded ? '' : 'clamped'}`}>
              <Md text={a.body} />
            </div>
          )}
          {compact && a.body.length > 280 && (
            <button className="more-btn" onClick={() => setExpanded((x) => !x)}>{expanded ? 'Show less' : 'Show more'}</button>
          )}

          {(a.replies.length > 0 || replyRun) && (
            <div className="thread">
              {a.replies.map((r) => r.role === 'user'
                ? <div key={r.id} className="msg user">{r.body}</div>
                : <div key={r.id} className="msg ai"><Thought text={r.thinking} /><Md text={r.body} /></div>)}
              {replyRun && <>
                <div className="msg user">{replyRun.user}</div>
                <div className="msg ai"><RunProgress run={replyRun} who={who} /></div>
              </>}
            </div>
          )}

          <div className="reply-box">
            <textarea rows={1} value={reply} placeholder={`Reply to ${who}…`}
              onChange={(e) => { setReply(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
            {replyRun
              ? <button className="icon-btn" aria-label="Stop" onClick={() => abortRef.current?.abort()}><I.stop /></button>
              : <button className="icon-btn" aria-label="Send reply" disabled={!reply.trim()} onClick={() => void send()}><I.send /></button>}
          </div>
        </>
      )}
    </article>
  );
}
