import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Annotation, type AskAction, type Mode, type Note, type Riddler, type StreamEvent } from '../api';
import { I, INKS, Popover, toast } from '../ui';
import { AnnotationCard, type Live } from './AnnotationCard';
import { PurposeModal } from './PurposeModal';

type LiveEntry = Live & { anchor: string | null; riddlerId: string | null; kind: Annotation['kind'] };

const ACTIONS: { id: AskAction; label: string; icon: keyof typeof ICONS }[] = [
  { id: 'ask', label: 'Ask', icon: 'chat' },
  { id: 'explain', label: 'Explain', icon: 'bulb' },
  { id: 'draw', label: 'Draw', icon: 'draw' },
  { id: 'question', label: 'Quiz me', icon: 'question' },
];
const ICONS = { chat: I.chat, bulb: I.bulb, draw: I.draw, question: I.question };
const KIND_FOR: Record<AskAction, Annotation['kind']> = { ask: 'comment', explain: 'explain', draw: 'drawing', question: 'question' };

export function NoteView({ noteId, riddlers, onChanged, onDeleted, onOpenRiddlers, sidebarToggle }: {
  noteId: string; riddlers: Riddler[]; onChanged: (n: Note, annotationCount: number) => void; onDeleted: () => void;
  onOpenRiddlers: () => void; sidebarToggle: React.ReactNode;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [anns, setAnns] = useState<Annotation[]>([]);
  const [live, setLive] = useState<Record<string, LiveEntry>>({});
  const [caretY, setCaretY] = useState(0);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [hot, setHot] = useState<string | null>(null);
  const [selection, setSelection] = useState<{ text: string; start: number; end: number; x: number; y: number } | null>(null);
  const [quote, setQuote] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [action, setAction] = useState<AskAction>('ask');
  const [askAs, setAskAs] = useState<string | null>(null);
  const [purposeOpen, setPurposeOpen] = useState(false);
  const [showResolved, setShowResolved] = useState(true);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const marginRef = useRef<HTMLElement>(null);
  const saveTimer = useRef<number>();
  const nudgeTimer = useRef<number>();
  const pendingSave = useRef<Partial<Note>>({});
  const noteRef = useRef<Note | null>(null);
  const askAbort = useRef<AbortController>();
  const pendingN = useRef(0);
  noteRef.current = note;

  const riddlerById = useMemo(() => Object.fromEntries(riddlers.map((r) => [r.id, r])), [riddlers]);

  // ---------- load ----------
  useEffect(() => {
    let alive = true;
    setNote(null); setAnns([]); setLive({});
    api.note(noteId).then((r) => { if (alive) { setNote(r.note); setAnns(r.annotations); } })
      .catch((e) => toast(e.message, 'error'));
    return () => { alive = false; };
  }, [noteId]);

  // ---------- stream event reducer (shared by ask + background) ----------
  // Live cards are keyed per run: an explicit ask uses its pending key; background jobs use
  // runId (v2 server), else annotationId, else one slot per riddler/read-along agent.
  const handle = useCallback((e: StreamEvent, pendingKey?: string) => {
    if (e.type === 'done' || e.type === 'ping') return;
    const rid = e.riddlerId ?? (e.type === 'annotation' ? e.annotation.riddlerId : null) ?? null;
    const key = pendingKey ?? e.runId ?? e.annotationId ?? `bg:${rid ?? 'doddled'}`;
    const blank = (state: Live['state']): LiveEntry => ({ state, thinking: '', text: '', anchor: null, riddlerId: rid, kind: 'comment', startedAt: Date.now() });
    const drop = (keys: (string | undefined)[]) => setLive((l) => {
      const c = { ...l }; let changed = false;
      for (const k of keys) if (k && c[k]) { delete c[k]; changed = true; }
      return changed ? c : l;
    });
    switch (e.type) {
      case 'status':
        if (e.state === 'idle') {
          if (e.silent) {
            setLive((l) => (l[key] ? { ...l, [key]: { ...l[key], state: 'idle', silent: true } } : l));
            window.setTimeout(() => drop([key]), 2600);
          } else drop([key]);
          break;
        }
        setLive((l) => {
          const cur = l[key] ?? blank(e.state);
          return { ...l, [key]: { ...cur, state: e.state, label: e.label ?? cur.label, riddlerId: cur.riddlerId ?? rid } };
        });
        break;
      case 'thinking':
        setLive((l) => { const cur = l[key] ?? blank('thinking'); return { ...l, [key]: { ...cur, thinking: cur.thinking + e.delta } }; });
        break;
      case 'text':
        setLive((l) => { const cur = l[key] ?? blank('writing'); return { ...l, [key]: { ...cur, state: 'writing', text: cur.text + e.delta } }; });
        break;
      case 'annotation':
        setAnns((xs) => {
          const i = xs.findIndex((x) => x.id === e.annotation.id);
          if (i === -1) return [...xs, e.annotation];
          const c = xs.slice(); c[i] = e.annotation; return c;
        });
        drop([e.annotation.id, key, pendingKey, `bg:${e.annotation.riddlerId ?? 'doddled'}`]);
        break;
      case 'error':
        toast(e.error, 'error');
        drop([key]);
        break;
    }
  }, []);

  // ---------- background agents for this note ----------
  useEffect(() => api.events(noteId, (e) => handle(e)), [noteId, handle]);

  // keep sidebar summary in sync
  useEffect(() => { if (note) onChanged(note, anns.filter((a) => a.status === 'open').length); /* eslint-disable-next-line */ }, [note?.updatedAt, note?.title, note?.mode, note?.inkColor, anns.length]);

  // ---------- saving ----------
  const flush = useCallback(async () => {
    const n = noteRef.current; const patch = pendingSave.current;
    if (!n || !Object.keys(patch).length) return;
    pendingSave.current = {};
    setSaving('saving');
    try { const r = await api.patchNote(n.id, patch); setNote((cur) => cur && { ...cur, updatedAt: r.note.updatedAt }); setSaving('saved'); }
    catch (e) { setSaving('idle'); toast((e as Error).message, 'error'); pendingSave.current = { ...patch, ...pendingSave.current }; }
  }, []);
  useEffect(() => () => { window.clearTimeout(saveTimer.current); window.clearTimeout(nudgeTimer.current); void flush(); askAbort.current?.abort(); }, [flush]);

  const update = (patch: Partial<Note>, opts: { immediate?: boolean; nudge?: boolean } = {}) => {
    setNote((n) => n && { ...n, ...patch });
    pendingSave.current = { ...pendingSave.current, ...patch };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flush, opts.immediate ? 0 : 700);
    if (opts.nudge && noteRef.current?.mode === 'thinks') {
      window.clearTimeout(nudgeTimer.current);
      nudgeTimer.current = window.setTimeout(async () => {
        await flush();
        const n = noteRef.current;
        if (n && n.mode === 'thinks' && n.content.trim().length > 40) api.nudge(n.id).catch(() => {});
      }, 4000);
    }
  };

  // ---------- auto-size ----------
  const autosize = () => {
    for (const el of [taRef.current, titleRef.current]) if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }
  };
  useLayoutEffect(autosize, [note?.content, note?.title]);
  useEffect(() => { const h = () => autosize(); window.addEventListener('resize', h); return () => window.removeEventListener('resize', h); }, []);

  // ---------- anchors -> mirror marks ----------
  const visible = useMemo(() => anns.filter((a) => a.status !== 'dismissed' && (showResolved || a.status === 'open')), [anns, showResolved]);
  const ranges = useMemo(() => {
    const content = note?.content ?? '';
    const rs: { id: string; start: number; end: number; color: string }[] = [];
    const items: { id: string; anchor: string | null; riddlerId: string | null }[] = [
      ...visible.map((a) => ({ id: a.id, anchor: a.anchor, riddlerId: a.riddlerId })),
      ...Object.entries(live).filter(([id]) => !visible.some((a) => a.id === id)).map(([id, l]) => ({ id, anchor: l.anchor, riddlerId: l.riddlerId })),
    ];
    for (const it of items) {
      if (!it.anchor) continue;
      const start = content.indexOf(it.anchor);
      if (start < 0) continue;
      const end = start + it.anchor.length;
      if (rs.some((r) => start < r.end && end > r.start)) { rs.push({ id: it.id, start, end: start, color: '' }); continue; } // overlap: position only
      rs.push({ id: it.id, start, end, color: riddlerById[it.riddlerId ?? '']?.color ?? note?.inkColor ?? '#2b4acb' });
    }
    return rs.sort((a, b) => a.start - b.start);
  }, [note?.content, note?.inkColor, visible, live, riddlerById]);

  const mirror = useMemo(() => {
    const content = note?.content ?? '';
    const out: React.ReactNode[] = []; let pos = 0;
    for (const r of ranges) {
      if (r.start < pos) continue;
      out.push(content.slice(pos, r.start));
      out.push(<mark key={r.id} data-id={r.id} className={hot === r.id ? 'hot' : ''}
        style={r.color ? { ['--ul-c' as string]: r.color, ['--mark-c' as string]: `color-mix(in srgb, ${r.color} 13%, transparent)` } : { background: 'none', boxShadow: 'none' }}>
        {content.slice(r.start, r.end)}</mark>);
      pos = r.end;
    }
    out.push(content.slice(pos) + '\n');
    return out;
  }, [note?.content, ranges, hot]);

  // ---------- margin layout ----------
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [tops, setTops] = useState<Record<string, number>>({});
  const [marginH, setMarginH] = useState(0);
  const [, force] = useState(0);
  useEffect(() => {
    const ro = new ResizeObserver(() => force((x) => x + 1));
    Object.values(cardRefs.current).forEach((el) => el && ro.observe(el));
    if (editorRef.current) ro.observe(editorRef.current);
    return () => ro.disconnect();
  });

  const cards = useMemo(() => {
    const list: { a: Annotation; live?: LiveEntry }[] = visible.map((a) => ({ a, live: live[a.id] }));
    for (const [id, l] of Object.entries(live)) {
      if (visible.some((a) => a.id === id)) continue;
      list.push({ live: l, a: { id, noteId, kind: l.kind, anchor: l.anchor, body: '', drawing: null, riddlerId: l.riddlerId, thinking: null, status: 'open', replies: [], createdAt: Date.now() } });
    }
    return list;
  }, [visible, live, noteId]);

  useLayoutEffect(() => {
    const ed = editorRef.current; const mir = mirrorRef.current; const mg = marginRef.current;
    if (!ed || !mir || !mg) return;
    // Editor top relative to the margin column (both scroll together inside .canvas).
    const base = ed.getBoundingClientRect().top - mg.getBoundingClientRect().top;
    const want: { id: string; y: number; order: number }[] = cards.map(({ a }, i) => {
      const m = mir.querySelector<HTMLElement>(`mark[data-id="${CSS.escape(a.id)}"]`);
      const r = ranges.find((x) => x.id === a.id);
      let y = Number.POSITIVE_INFINITY;
      if (m) y = base + m.offsetTop - 6;
      else if (r) y = base + measure(r.start).top - 6;
      else if (live[a.id] && !a.anchor) y = base + caretY - 6; // read-along run: beside where you're writing
      return { id: a.id, y, order: i };
    });
    // Unanchored notes go at the top, in arrival order.
    want.sort((p, q) => (p.y === q.y ? p.order - q.order : p.y === Infinity ? -1 : q.y === Infinity ? 1 : p.y - q.y));
    const next: Record<string, number> = {}; let cursor = 0;
    for (const w of want) {
      const y = w.y === Infinity ? cursor : Math.max(w.y, cursor);
      next[w.id] = y;
      cursor = y + (cardRefs.current[w.id]?.offsetHeight ?? 120) + 12;
    }
    setMarginH(cursor);
    setTops((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  });

  /** Measure the position of a character index inside the editor using a hidden mirror. */
  const measure = (index: number): { top: number; left: number } => {
    const el = measureRef.current; const content = noteRef.current?.content ?? '';
    if (!el) return { top: 0, left: 0 };
    el.textContent = content.slice(0, index);
    const span = document.createElement('span'); span.textContent = content.slice(index, index + 1) || '\u200b';
    el.appendChild(span);
    return { top: span.offsetTop, left: span.offsetLeft };
  };

  // ---------- selection ----------
  const onSelect = () => {
    const ta = taRef.current; if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const text = ta.value.slice(s, e);
    setCaretY(measure(s).top);
    if (e - s < 2 || !text.trim()) { setSelection(null); return; }
    const a = measure(s); const b = measure(e);
    const y = a.top;
    const x = b.top === a.top ? (a.left + b.left) / 2 : Math.min(280, ta.clientWidth / 2);
    setSelection({ text: text.trim(), start: s, end: e, x: Math.max(120, Math.min(ta.clientWidth - 120, x)), y: y - 8 });
  };

  // ---------- ask ----------
  const ask = async (act: AskAction, text: string, sel: string | null, riddlerId: string | null) => {
    const n = noteRef.current; if (!n) return;
    await flush();
    const key = `pending:${++pendingN.current}`;
    setLive((l) => ({ ...l, [key]: { state: 'thinking', thinking: '', text: '', anchor: sel && n.content.includes(sel) ? sel : null, riddlerId, kind: KIND_FOR[act], label: act === 'draw' ? 'Sketching' : 'Thinking', startedAt: Date.now() } }));
    askAbort.current?.abort();
    const ac = new AbortController(); askAbort.current = ac;
    const defaults: Record<AskAction, string> = { ask: 'What do you think?', explain: 'Explain this.', draw: 'Draw this.', question: 'Ask me a question that tests whether I understand this.' };
    try {
      await api.ask(n.id, { prompt: text || defaults[act], selection: sel ?? undefined, action: act, riddlerId: riddlerId ?? undefined }, (e) => handle(e, key), ac.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast((e as Error).message, 'error');
    } finally {
      setLive((l) => { if (!l[key]) return l; const c = { ...l }; delete c[key]; return c; });
    }
  };

  const submit = () => {
    if (!prompt.trim() && !quote) return;
    void ask(action, prompt.trim(), quote, askAs);
    setPrompt(''); setQuote(null); setAction('ask');
    if (composerRef.current) composerRef.current.style.height = 'auto';
  };

  const quick = (act: AskAction) => {
    if (!selection) return;
    if (act === 'ask') { setQuote(selection.text); setAction('ask'); setSelection(null); composerRef.current?.focus(); return; }
    void ask(act, '', selection.text, askAs);
    setSelection(null);
  };

  const riddle = async (ids: string[]) => {
    if (!note || !ids.length) return;
    await flush();
    try { const r = await api.riddle(note.id, ids); toast(`${r.queued} riddler${r.queued === 1 ? ' is' : 's are'} reading your note`); }
    catch (e) { toast((e as Error).message, 'error'); }
  };

  const setMode = (mode: Mode) => { update({ mode }, { immediate: true }); if (mode === 'thinks') toast('doddled will read along and speak up when it has something worth saying'); };

  const del = async () => {
    if (!note) return;
    try { await api.deleteNote(note.id); onDeleted(); } catch (e) { toast((e as Error).message, 'error'); }
  };

  if (!note) return <div className="main"><div className="topbar">{sidebarToggle}</div><div className="center-load">Opening…</div></div>;

  const working = Object.entries(live)
    .filter(([k, l]) => !k.startsWith('pending:') && l.state !== 'idle')
    .map(([, l]) => ({ who: l.riddlerId ? riddlerById[l.riddlerId]?.name ?? 'Riddler' : 'doddled', color: riddlerById[l.riddlerId ?? '']?.color ?? note.inkColor, state: l.state }));
  const selRiddlers = new Set(note.riddlerIds);
  const askAsRiddler = askAs ? riddlerById[askAs] : undefined;

  return (
    <div className="main">
      <header className="topbar">
        {sidebarToggle}
        <div className="seg" role="radiogroup" aria-label="Mode">
          <button role="radio" aria-checked={note.mode === 'thinks'} className={note.mode === 'thinks' ? 'on' : ''} onClick={() => setMode('thinks')}>Thinks with you</button>
          <button role="radio" aria-checked={note.mode === 'ask'} className={note.mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')}>When you ask</button>
        </div>
        {working.length > 0 && (
          <span className="status-pill" title={working.map((w) => w.who).join(', ')}>
            <span className="pulse" style={{ background: working[0].color }} />
            <span className="txt shimmer">
              {working.length === 1 ? `${working[0].who} is ${working[0].state === 'writing' ? 'writing' : working[0].state === 'drawing' ? 'sketching' : 'thinking'}` : `${working.length} agents working`}
            </span>
          </span>
        )}
        <span className="spacer" />
        <span className="saved hide-sm">{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : ''}</span>

        <Popover align="right" trigger={(t) => <button className="btn sm" onClick={t}><I.users /> <span className="hide-sm">Riddlers</span>{selRiddlers.size > 0 && <b style={{ fontWeight: 600 }}>{selRiddlers.size}</b>}</button>}>
          {(close) => (
            <div style={{ width: 280 }}>
              <div className="list-label" style={{ padding: '6px 10px' }}>Who should read this note?</div>
              {riddlers.map((r) => (
                <button key={r.id} className="menu-item" onClick={() => {
                  const next = selRiddlers.has(r.id) ? note.riddlerIds.filter((x) => x !== r.id) : [...note.riddlerIds, r.id];
                  update({ riddlerIds: next }, { immediate: true });
                }}>
                  <span className="dot" style={{ background: r.color }} />
                  <span style={{ minWidth: 0 }}><div>{r.name}</div><div className="sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}>{r.persona}</div></span>
                  {selRiddlers.has(r.id) && <span className="check"><I.check /></span>}
                </button>
              ))}
              <div className="menu-sep" />
              <div style={{ display: 'flex', gap: 6, padding: 6 }}>
                <button className="btn sm" onClick={() => { close(); onOpenRiddlers(); }}><I.plus /> New riddler</button>
                <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!selRiddlers.size} onClick={() => { close(); void riddle(note.riddlerIds); }}>Riddle it</button>
              </div>
            </div>
          )}
        </Popover>

        <Popover align="right" trigger={(t) => <button className="icon-btn" onClick={t} aria-label="Ink color" title="Ink color"><span className="dot" style={{ width: 14, height: 14, background: note.inkColor }} /></button>}>
          {() => (
            <div>
              <div className="list-label" style={{ padding: '6px 10px 0' }}>doddled writes in</div>
              <div className="swatches">
                {INKS.map((c) => <button key={c} className={`swatch ${note.inkColor === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => update({ inkColor: c }, { immediate: true })} />)}
              </div>
            </div>
          )}
        </Popover>

        <Popover align="right" trigger={(t) => <button className="icon-btn" onClick={t} aria-label="More"><I.more /></button>}>
          {(close) => (
            <div>
              <button className="menu-item" onClick={() => { close(); setPurposeOpen(true); }}><I.target /> Tell doddled what this is for</button>
              <button className="menu-item" onClick={() => { close(); setShowResolved((s) => !s); }}><I.check /> {showResolved ? 'Hide' : 'Show'} resolved notes</button>
              <div className="menu-sep" />
              <button className="menu-item danger" onClick={() => { close(); void del(); }}><I.trash /> Delete note</button>
            </div>
          )}
        </Popover>
      </header>

      <div className="canvas" onScroll={() => setSelection(null)}>
        <div className="page">
          <div className="page-col">
            <textarea ref={titleRef} className="title-input" rows={1} placeholder="Untitled" value={note.title}
              onChange={(e) => update({ title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); taRef.current?.focus(); } }} />
            <div className="note-meta">
              <button className="chip purpose-chip" onClick={() => setPurposeOpen(true)} title={note.purpose || undefined}>
                <I.target size={13} /> <span>{note.purpose ? note.purpose : 'Tell doddled what this note is for'}</span>
              </button>
              {note.riddlerIds.map((id) => riddlerById[id] && (
                <span key={id} className="chip"><span className="dot" style={{ background: riddlerById[id].color }} />{riddlerById[id].name}</span>
              ))}
            </div>

            <div className="editor" ref={editorRef}>
              <div className="mirror" ref={mirrorRef} aria-hidden>{mirror}</div>
              <div className="mirror" ref={measureRef} aria-hidden style={{ visibility: 'hidden' }} />
              <textarea ref={taRef} value={note.content} spellCheck
                placeholder={note.mode === 'thinks' ? 'Start writing. doddled will read along…' : 'Start writing. Select text or use the box below to ask doddled.'}
                onChange={(e) => { update({ content: e.target.value }, { nudge: true }); setSelection(null); setCaretY(measure(e.target.selectionStart).top); }}
                onSelect={onSelect} onBlur={() => window.setTimeout(() => setSelection((s) => (document.activeElement === taRef.current ? s : null)), 150)} />
              {selection && (
                <div className="sel-bar" style={{ left: selection.x, top: selection.y }} onMouseDown={(e) => e.preventDefault()}>
                  {ACTIONS.map((a) => { const Ic = ICONS[a.icon]; return <button key={a.id} onClick={() => quick(a.id)}><Ic size={14} /> {a.label}</button>; })}
                </div>
              )}
            </div>
          </div>

          <aside ref={marginRef} className="margin" style={{ minHeight: marginH }} aria-label="doddled's notes">
            <div className="margin-label">doddled's notes</div>
            {cards.length === 0 && (
              <div className="margin-empty">
                {note.mode === 'thinks'
                  ? <><b>Reading along.</b> Keep writing. doddled speaks up when something deserves a question, an explanation, or a sketch.</>
                  : <><b>Quiet until called.</b> Select text to ask, explain, draw, or quiz. Or use the box below.</>}
              </div>
            )}
            {cards.map(({ a, live: l }) => (
              <div key={a.id} ref={(el) => { cardRefs.current[a.id] = el; }}
                className={`ann ${hot === a.id ? 'hot' : ''} ${a.status === 'resolved' ? 'resolved' : ''}`} style={{ top: tops[a.id] ?? 0 }}>
                <AnnotationCard a={a} live={l} riddler={a.riddlerId ? riddlerById[a.riddlerId] : undefined} inkColor={note.inkColor}
                  onHover={setHot}
                  onUpdate={(u) => setAnns((xs) => xs.map((x) => (x.id === u.id ? u : x)))}
                  onRemove={(id) => setAnns((xs) => xs.filter((x) => x.id !== id))} />
              </div>
            ))}
          </aside>
        </div>

        <div className="composer-wrap">
          <div className="composer">
            {quote && <div className="sel-quote"><span>“{quote}”</span><button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setQuote(null)} aria-label="Clear selection"><I.x size={13} /></button></div>}
            <div className="composer-row">
              <textarea ref={composerRef} rows={1} value={prompt}
                placeholder={askAsRiddler ? `Ask ${askAsRiddler.name}…` : quote ? 'What do you want to know about this?' : 'Tell doddled…'}
                onChange={(e) => { setPrompt(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'; }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }} />
              <button className="send" aria-label="Send" disabled={!prompt.trim() && !quote} onClick={submit}><I.send /></button>
            </div>
            <div className="composer-tools">
              {ACTIONS.map((a) => { const Ic = ICONS[a.icon]; return (
                <button key={a.id} className={`chip ${action === a.id ? 'on' : ''}`} onClick={() => setAction(a.id)}><Ic size={13} /> {a.label}</button>
              ); })}
              <span style={{ flex: 1 }} />
              <Popover align="right" up trigger={(t) => (
                <button className="chip" onClick={t}><span className="dot" style={{ background: askAsRiddler?.color ?? note.inkColor }} />{askAsRiddler?.name ?? 'doddled'}</button>
              )}>
                {(close) => (
                  <div style={{ width: 240 }}>
                    <button className="menu-item" onClick={() => { setAskAs(null); close(); }}><span className="dot" style={{ background: note.inkColor }} /> doddled {!askAs && <span className="check"><I.check /></span>}</button>
                    {riddlers.map((r) => (
                      <button key={r.id} className="menu-item" onClick={() => { setAskAs(r.id); close(); }}>
                        <span className="dot" style={{ background: r.color }} /> {r.name} {askAs === r.id && <span className="check"><I.check /></span>}
                      </button>
                    ))}
                  </div>
                )}
              </Popover>
            </div>
          </div>
        </div>
      </div>

      {purposeOpen && <PurposeModal value={note.purpose} onClose={() => setPurposeOpen(false)} onSave={(p: string) => { update({ purpose: p }, { immediate: true }); setPurposeOpen(false); }} />}
    </div>
  );
}
