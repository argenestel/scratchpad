import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type Annotation, type AskAction, type Mode, type ModelInfo, type Note, type Riddler, type Settings, type StreamEvent } from '../api';
import type { AnchorSpec } from '../editor/anchors';
import { NoteEditor, type EditorHandle } from '../editor/NoteEditor';
import { I, INKS, Popover, toast } from '../ui';
import { AnnotationView } from './AnnotationView';
import { AskPalette } from './AskPalette';
import { PurposeModal } from './PurposeModal';
import { RunProgress, fmtSecs, secs, useTicker, type Phase, type Run } from './RunProgress';

const KIND_FOR: Record<AskAction, Annotation['kind']> = { ask: 'comment', explain: 'explain', draw: 'drawing', question: 'question' };
const DEFAULT_PROMPT: Record<AskAction, string> = {
  ask: 'What do you think?', explain: 'Explain this.', draw: 'Diagram this.', question: 'Ask me a question that tests whether I understand this.',
};

type PopoverState = { ids?: string[]; runKey?: string; getRect: () => DOMRect | null };
type PaletteState = { quote: string | null; runKey: string | null; resultId: string | null };

function loadPref(key: string, fallback: boolean) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v === '1'; } catch { return fallback; }
}
function savePref(key: string, v: boolean) {
  try { localStorage.setItem(key, v ? '1' : '0'); } catch { /* ignore */ }
}

export function NoteView({ noteId, riddlers, onChanged, onDeleted, onOpenRiddlers, onOpenSettings, sidebarToggle }: {
  noteId: string; riddlers: Riddler[]; onChanged: (n: Note, annotationCount: number) => void; onDeleted: () => void;
  onOpenRiddlers: () => void; onOpenSettings: () => void; sidebarToggle: React.ReactNode;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [anns, setAnns] = useState<Annotation[]>([]);
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [panelOpen, setPanelOpenRaw] = useState(() => loadPref('dd-panel', false));
  const [panelTab, setPanelTab] = useState<'open' | 'resolved'>('open');
  const [palette, setPalette] = useState<PaletteState | null>(null);
  const [pop, setPop] = useState<PopoverState | null>(null);
  const [purposeOpen, setPurposeOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [ai, setAi] = useState<{ settings: Settings; model?: ModelInfo } | null>(null);
  const [bubbles, setBubbles] = useState<{ top: number; ids: string[]; color: string; fresh: boolean }[]>([]);

  const editorRef = useRef<EditorHandle>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<Note | null>(null);
  const saveTimer = useRef<number>();
  const nudgeTimer = useRef<number>();
  const pendingSave = useRef<Partial<Note>>({});
  const seq = useRef(0);
  noteRef.current = note;

  const setPanelOpen = (v: boolean | ((p: boolean) => boolean)) =>
    setPanelOpenRaw((p) => { const n = typeof v === 'function' ? v(p) : v; savePref('dd-panel', n); return n; });
  const riddlerById = useMemo(() => Object.fromEntries(riddlers.map((r) => [r.id, r])), [riddlers]);
  const annById = useMemo(() => Object.fromEntries(anns.map((a) => [a.id, a])), [anns]);

  // ---------- load ----------
  useEffect(() => {
    let alive = true;
    setNote(null); setAnns([]); setRuns({}); setPop(null);
    api.note(noteId).then((r) => { if (alive) { setNote(r.note); setAnns(r.annotations); } }).catch((e) => toast(e.message, 'error'));
    return () => { alive = false; };
  }, [noteId]);

  useEffect(() => {
    const load = () => Promise.all([api.settings(), api.models()])
      .then(([s, m]) => setAi({ settings: s.settings, model: m.models.find((x) => x.id === s.settings.model) }))
      .catch(() => {});
    void load();
    window.addEventListener('dd:settings', load);
    return () => window.removeEventListener('dd:settings', load);
  }, []);

  // ---------- stream events → runs/annotations ----------
  const handle = useCallback((e: StreamEvent, pendingKey?: string) => {
    if (e.type === 'done' || e.type === 'ping') return;
    const rid = e.riddlerId ?? (e.type === 'annotation' ? e.annotation.riddlerId : null) ?? null;
    const key = pendingKey ?? e.runId ?? e.annotationId ?? `bg:${rid ?? 'scratchpad'}`;
    const blank = (): Run => ({ key, phase: 'reading', thinking: '', text: '', startedAt: Date.now(), anchor: null, riddlerId: rid, kind: 'comment', background: !pendingKey });
    const drop = (keys: (string | undefined)[]) => setRuns((r) => {
      const c = { ...r }; let changed = false;
      for (const k of keys) if (k && c[k]) { delete c[k]; changed = true; }
      return changed ? c : r;
    });
    switch (e.type) {
      case 'status': {
        if (e.state === 'idle') {
          if (e.silent) {
            setRuns((r) => (r[key] ? { ...r, [key]: { ...r[key], silent: true, phase: 'done' } } : r));
            window.setTimeout(() => drop([key]), 3000);
          } else drop([key]);
          break;
        }
        const phase: Phase = e.phase ?? (e.state === 'writing' ? 'writing' : e.state === 'drawing' ? 'drawing' : 'thinking');
        setRuns((r) => {
          const cur = r[key] ?? blank();
          return { ...r, [key]: { ...cur, phase: phase === 'done' ? cur.phase : phase, model: e.model ?? cur.model, effort: e.effort ?? cur.effort, riddlerId: cur.riddlerId ?? rid, annotationId: e.annotationId ?? cur.annotationId } };
        });
        break;
      }
      case 'thinking':
        setRuns((r) => { const cur = r[key] ?? blank(); return { ...r, [key]: { ...cur, phase: cur.phase === 'reading' ? 'thinking' : cur.phase, thinking: cur.thinking + e.delta } }; });
        break;
      case 'text':
        setRuns((r) => {
          const cur = r[key] ?? blank();
          return { ...r, [key]: { ...cur, phase: cur.phase === 'drawing' ? 'drawing' : 'writing', thinkingDoneAt: cur.thinkingDoneAt ?? Date.now(), text: cur.text + e.delta } };
        });
        break;
      case 'annotation': {
        const a = e.annotation;
        setAnns((xs) => { const i = xs.findIndex((x) => x.id === a.id); if (i === -1) return [...xs, a]; const c = xs.slice(); c[i] = a; return c; });
        drop([a.id, key, `bg:${a.riddlerId ?? 'scratchpad'}`]);
        setPop((p) => (p?.runKey && p.runKey === key ? { ids: [a.id], getRect: p.getRect } : p));
        setPalette((p) => (p?.runKey && p.runKey === key ? { ...p, runKey: null, resultId: a.id } : p));
        if (!pendingKey) {
          setFresh((f) => new Set(f).add(a.id));
          window.setTimeout(() => setFresh((f) => { const n = new Set(f); n.delete(a.id); return n; }), 6000);
        }
        break;
      }
      case 'error':
        toast(e.error, 'error');
        drop([key]);
        setPop((p) => (p?.runKey === key ? null : p));
        setPalette((p) => (p?.runKey === key ? { ...p, runKey: null } : p));
        break;
    }
  }, []);

  useEffect(() => api.events(noteId, (e) => handle(e)), [noteId, handle]);
  useEffect(() => { if (note) onChanged(note, anns.filter((a) => a.status === 'open').length); /* eslint-disable-next-line */ }, [note?.updatedAt, note?.title, note?.mode, note?.inkColor, anns]);

  // ---------- saving ----------
  const flush = useCallback(async () => {
    const n = noteRef.current; const patch = pendingSave.current;
    if (!n || !Object.keys(patch).length) return;
    pendingSave.current = {};
    setSaving('saving');
    try { const r = await api.patchNote(n.id, patch); setNote((cur) => cur && { ...cur, updatedAt: r.note.updatedAt }); setSaving('saved'); }
    catch (e) { setSaving('idle'); toast((e as Error).message, 'error'); pendingSave.current = { ...patch, ...pendingSave.current }; }
  }, []);
  useEffect(() => () => { window.clearTimeout(saveTimer.current); window.clearTimeout(nudgeTimer.current); void flush(); }, [flush]);

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

  useLayoutEffect(() => { const el = titleRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }, [note?.title]);

  // ---------- anchors (highlights in the editor) ----------
  const anchors = useMemo<AnchorSpec[]>(() => {
    const color = (rid: string | null) => riddlerById[rid ?? '']?.color ?? note?.inkColor ?? '#2b4acb';
    const list: AnchorSpec[] = anns
      .filter((a) => a.anchor && a.status === 'open')
      .map((a) => ({ id: a.id, text: a.anchor!, color: color(a.riddlerId), active: flash === a.id || !!pop?.ids?.includes(a.id) }));
    for (const r of Object.values(runs)) if (r.anchor && !r.silent) list.push({ id: r.key, text: r.anchor, color: color(r.riddlerId), live: true });
    return list;
  }, [anns, runs, riddlerById, note?.inkColor, flash, pop]);

  // ---------- line-end bubbles: one per block that has notes ----------
  const layoutBubbles = useCallback(() => {
    const wrap = wrapRef.current; const dom = editorRef.current?.dom();
    if (!wrap || !dom) return;
    const base = wrap.getBoundingClientRect().top;
    const byBlock = new Map<Element, { top: number; ids: string[]; color: string; fresh: boolean }>();
    for (const a of anns) {
      if (a.status !== 'open' || !a.anchor) continue;
      const el = dom.querySelector(`[data-ann="${CSS.escape(a.id)}"]`);
      const block = el?.closest('.doc > *');
      if (!el || !block) continue;
      const entry = byBlock.get(block) ?? { top: block.getBoundingClientRect().top - base, ids: [], color: (el as HTMLElement).style.getPropertyValue('--c'), fresh: false };
      entry.ids.push(a.id);
      entry.fresh ||= fresh.has(a.id);
      byBlock.set(block, entry);
    }
    const next = [...byBlock.values()];
    setBubbles((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [anns, fresh]);
  useEffect(() => {
    const id = requestAnimationFrame(layoutBubbles);
    const dom = editorRef.current?.dom();
    const ro = new ResizeObserver(() => layoutBubbles());
    if (dom) ro.observe(dom);
    return () => { cancelAnimationFrame(id); ro.disconnect(); };
  });

  // ---------- popover positioning ----------
  const [, tick] = useState(0);
  useEffect(() => {
    if (!pop) return;
    const re = () => tick((x) => x + 1);
    const canvas = canvasRef.current;
    canvas?.addEventListener('scroll', re, { passive: true });
    window.addEventListener('resize', re);
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (popRef.current?.contains(t) || t.closest('[data-ann], .ann-bubble, .tippy-box, .scrim')) return;
      setPop(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPop(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      canvas?.removeEventListener('scroll', re); window.removeEventListener('resize', re);
      document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey);
    };
  }, [pop]);

  const openAnn = (ids: string[]) => {
    const first = annById[ids[0]];
    setPop({ ids, getRect: () => (first?.anchor ? editorRef.current?.rectOf(first.anchor) ?? null : null) });
  };

  // ---------- asking ----------
  const ask = async (action: AskAction, prompt: string, quote: string | null, riddlerId: string | null, via: 'inline' | 'palette', rect?: DOMRect | null) => {
    const n = noteRef.current; if (!n) return;
    await flush();
    const key = `fg:${++seq.current}`;
    setRuns((r) => ({ ...r, [key]: { key, phase: 'reading', thinking: '', text: '', startedAt: Date.now(), anchor: quote, riddlerId, kind: KIND_FOR[action], background: false, model: ai?.model?.name ?? ai?.settings.model, effort: ai?.settings.effort } }));
    if (via === 'inline') setPop({ runKey: key, getRect: () => (quote ? editorRef.current?.rectOf(quote) ?? rect ?? null : rect ?? null) });
    else setPalette((p) => ({ quote: p?.quote ?? quote, runKey: key, resultId: null }));
    try {
      await api.ask(n.id, { prompt: prompt || DEFAULT_PROMPT[action], selection: quote ?? undefined, action, riddlerId: riddlerId ?? undefined }, (e) => handle(e, key));
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setRuns((r) => { if (!r[key]) return r; const c = { ...r }; delete c[key]; return c; });
    }
  };

  const openPalette = useCallback((quote: string | null) => { setPop(null); setPalette({ quote, runKey: null, resultId: null }); }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(editorRef.current?.selection()?.text ?? null); }
      if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); setPanelOpen((o) => !o); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openPalette]);

  const riddle = async (ids: string[]) => {
    if (!note || !ids.length) return;
    await flush();
    try { const r = await api.riddle(note.id, ids); toast(`${r.queued} riddler${r.queued === 1 ? ' is' : 's are'} reading your note`); }
    catch (e) { toast((e as Error).message, 'error'); }
  };
  const setMode = (mode: Mode) => { update({ mode }, { immediate: true }); };
  const del = async () => { if (!note) return; try { await api.deleteNote(note.id); onDeleted(); } catch (e) { toast((e as Error).message, 'error'); } };
  const jump = (a: Annotation) => {
    if (!a.anchor) return;
    editorRef.current?.scrollTo(a.anchor);
    setFlash(a.id);
    window.setTimeout(() => setFlash((f) => (f === a.id ? null : f)), 1600);
  };
  const upsert = (u: Annotation) => {
    setAnns((xs) => xs.map((x) => (x.id === u.id ? u : x)));
    // A note marked done leaves the text, so drop it from an open popover instead of leaving it floating.
    if (u.status !== 'open') setPop((p) => {
      if (!p?.ids?.includes(u.id)) return p;
      const ids = p.ids.filter((i) => i !== u.id);
      return ids.length ? { ...p, ids } : null;
    });
  };
  const removeAnn = (id: string) => { setAnns((xs) => xs.filter((x) => x.id !== id)); setPop((p) => (p?.ids?.includes(id) ? null : p)); };

  const liveRuns = Object.values(runs).filter((r) => r.key !== palette?.runKey && r.key !== pop?.runKey);
  useTicker(liveRuns.some((r) => !r.silent));

  if (!note) return <div className="main"><div className="topbar">{sidebarToggle}</div><div className="center-load"><span className="spinner" /></div></div>;

  const who = (rid: string | null) => (rid ? riddlerById[rid]?.name ?? 'Riddler' : 'scratchpad');
  const colorOf = (rid: string | null) => riddlerById[rid ?? '']?.color ?? note.inkColor;
  const openAnns = anns.filter((a) => a.status === 'open');
  const resolvedAnns = anns.filter((a) => a.status === 'resolved');
  const selRiddlers = new Set(note.riddlerIds);
  const working = liveRuns.filter((r) => !r.silent);

  // Popover geometry: below the anchor if there is room, otherwise above.
  let popStyle: React.CSSProperties | undefined;
  if (pop) {
    const r = pop.getRect();
    const W = Math.min(440, window.innerWidth - 24);
    const left = Math.max(12, Math.min((r?.left ?? window.innerWidth / 2 - W / 2) - 12, window.innerWidth - W - 12));
    const below = r ? window.innerHeight - r.bottom : window.innerHeight;
    popStyle = below > 300 || !r
      ? { left, width: W, top: (r?.bottom ?? 120) + 10, maxHeight: Math.max(220, below - 24) }
      : { left, width: W, bottom: window.innerHeight - r.top + 10, maxHeight: Math.max(220, r.top - 70) };
  }
  const popRun = pop?.runKey ? runs[pop.runKey] : undefined;
  const paletteRun = palette?.runKey ? runs[palette.runKey] ?? null : null;
  const paletteResult = palette?.resultId ? annById[palette.resultId] ?? null : null;
  const listed = panelTab === 'open' ? openAnns : resolvedAnns;

  return (
    <div className="main">
      <header className="topbar">
        {sidebarToggle}
        <span className="crumb hide-sm">{note.title || 'Untitled'}</span>
        <div className="seg" role="radiogroup" aria-label="Mode">
          <button role="radio" aria-checked={note.mode === 'thinks'} className={note.mode === 'thinks' ? 'on' : ''} onClick={() => setMode('thinks')} title="Reads along and speaks up when it matters">Thinks with you</button>
          <button role="radio" aria-checked={note.mode === 'ask'} className={note.mode === 'ask' ? 'on' : ''} onClick={() => setMode('ask')} title="Quiet until you ask">When you ask</button>
        </div>
        {working.length > 0 && (
          <Popover trigger={(t) => (
            <button className="activity" onClick={t} style={{ ['--c' as string]: colorOf(working[0].riddlerId) }}>
              <span className="spinner" />
              <span className="hide-sm">{working.length === 1 ? `${who(working[0].riddlerId)} · ${working[0].phase}` : `${working.length} agents working`}</span>
              <span className="mono">{fmtSecs(secs(working[0].startedAt))}</span>
            </button>
          )}>
            {() => (
              <div className="activity-list">
                {working.map((r) => (
                  <div key={r.key} className="activity-item" style={{ ['--c' as string]: colorOf(r.riddlerId) }}>
                    <div className="activity-who"><span className="who-dot" /> {who(r.riddlerId)} {r.background && <span className="badge">read-along</span>}</div>
                    <RunProgress run={r} who={who(r.riddlerId)} compact />
                  </div>
                ))}
              </div>
            )}
          </Popover>
        )}
        <span className="spacer" />
        <span className="saved hide-sm">{saving === 'saving' ? 'Saving…' : saving === 'saved' ? 'Saved' : ''}</span>
        <button className="btn sm" onClick={() => openPalette(editorRef.current?.selection()?.text ?? null)} title="Ask scratchpad (Ctrl/⌘ K)">
          <I.sparkle /> <span className="hide-sm">Ask</span> <kbd className="hide-sm">⌘K</kbd>
        </button>
        <Popover align="right" trigger={(t) => <button className="btn sm ghost" onClick={t}><I.users /> <span className="hide-sm">Riddlers</span>{selRiddlers.size > 0 && <b>{selRiddlers.size}</b>}</button>}>
          {(close) => (
            <div style={{ width: 290 }}>
              <div className="list-label" style={{ padding: '6px 10px' }}>Who should review this note?</div>
              {riddlers.map((r) => (
                <button key={r.id} className="menu-item" onClick={() => update({ riddlerIds: selRiddlers.has(r.id) ? note.riddlerIds.filter((x) => x !== r.id) : [...note.riddlerIds, r.id] }, { immediate: true })}>
                  <span className="dot" style={{ background: r.color }} />
                  <span style={{ minWidth: 0 }}><div>{r.name}</div><div className="sub" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{r.persona}</div></span>
                  {selRiddlers.has(r.id) && <span className="check"><I.check /></span>}
                </button>
              ))}
              <div className="menu-sep" />
              <div style={{ display: 'flex', gap: 6, padding: 6 }}>
                <button className="btn sm" onClick={() => { close(); onOpenRiddlers(); }}><I.plus /> New</button>
                <button className="btn sm primary" style={{ marginLeft: 'auto' }} disabled={!selRiddlers.size} onClick={() => { close(); void riddle(note.riddlerIds); }}>Review now</button>
              </div>
            </div>
          )}
        </Popover>
        <button className={`btn sm ghost notes-toggle ${panelOpen ? 'on' : ''}`} onClick={() => setPanelOpen((o) => !o)} title="AI notes (Ctrl/⌘ J)" aria-pressed={panelOpen}>
          <I.panel /> {openAnns.length > 0 && <b>{openAnns.length}</b>}
          {fresh.size > 0 && !panelOpen && <span className="new-dot" />}
        </button>
        <Popover align="right" trigger={(t) => <button className="icon-btn" onClick={t} aria-label="More"><I.more /></button>}>
          {(close) => (
            <div>
              <button className="menu-item" onClick={() => { close(); setPurposeOpen(true); }}><I.target /> Tell scratchpad what this is for</button>
              <button className="menu-item" onClick={() => { close(); onOpenSettings(); }}><I.sliders /> Models &amp; thinking</button>
              <div className="list-label" style={{ padding: '8px 10px 0' }}>Ink</div>
              <div className="swatches">
                {INKS.map((c) => <button key={c} className={`swatch ${note.inkColor === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Ink ${c}`} onClick={() => update({ inkColor: c }, { immediate: true })} />)}
              </div>
              <div className="menu-sep" />
              <button className="menu-item danger" onClick={() => { close(); void del(); }}><I.trash /> Delete note</button>
            </div>
          )}
        </Popover>
      </header>

      <div className="workspace">
        <div className="canvas" ref={canvasRef}>
          <div className="doc-wrap" ref={wrapRef}>
            <textarea ref={titleRef} className="title-input" rows={1} placeholder="Untitled" value={note.title}
              onChange={(e) => update({ title: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); editorRef.current?.focus(); } }} />
            <div className="props">
              <button className="prop" onClick={() => setPurposeOpen(true)}>
                <I.target size={14} /><span className="k">Purpose</span><span className={`v ${note.purpose ? '' : 'empty'}`}>{note.purpose || 'Tell scratchpad what this note is for'}</span>
              </button>
              <button className="prop" onClick={onOpenSettings}>
                <I.sparkle size={14} /><span className="k">scratchpad</span>
                <span className="v">{note.mode === 'thinks' ? 'Reads along and speaks up' : 'Answers when asked'}{ai ? ` · ${ai.model?.name ?? ai.settings.model}, ${ai.settings.effort}` : ''}</span>
              </button>
              {note.riddlerIds.length > 0 && (
                <div className="prop static">
                  <I.users size={14} /><span className="k">Reviewers</span>
                  <span className="v">{note.riddlerIds.map((id) => riddlerById[id] && <span key={id} className="tag"><span className="dot" style={{ background: riddlerById[id].color }} />{riddlerById[id].name}</span>)}</span>
                </div>
              )}
            </div>

            <NoteEditor key={note.id} ref={editorRef} markdown={note.content}
              placeholder={note.mode === 'thinks' ? "Start writing. Type '/' for blocks, code and AI. scratchpad reads along." : "Start writing. Type '/' for blocks, code and AI."}
              anchors={anchors}
              onChange={(md) => update({ content: md }, { nudge: true })}
              onAnchorClick={(id) => {
                if (annById[id]) openAnn([id]);
                else if (runs[id]) setPop({ runKey: id, getRect: () => (runs[id]?.anchor ? editorRef.current?.rectOf(runs[id].anchor!) ?? null : null) });
              }}
              onAI={(action, text, rect) => void ask(action, '', text, null, 'inline', rect)}
              onAsk={openPalette} />

            <div className="bubble-rail" aria-label="AI notes in this note">
              {bubbles.map((b) => (
                <button key={b.ids.join()} className={`ann-bubble ${b.fresh ? 'fresh' : ''} ${pop?.ids?.some((i) => b.ids.includes(i)) ? 'on' : ''}`}
                  style={{ top: b.top, ['--c' as string]: b.color || note.inkColor }} onClick={() => openAnn(b.ids)}
                  aria-label={`${b.ids.length} AI note${b.ids.length > 1 ? 's' : ''}`}>
                  <I.chat size={13} />{b.ids.length > 1 && b.ids.length}
                </button>
              ))}
            </div>
          </div>
        </div>

        {panelOpen && (
          <aside className="notes-panel" aria-label="AI notes">
            <div className="panel-head">
              <div className="tabs">
                <button className={panelTab === 'open' ? 'on' : ''} onClick={() => setPanelTab('open')}>Open <span>{openAnns.length}</span></button>
                <button className={panelTab === 'resolved' ? 'on' : ''} onClick={() => setPanelTab('resolved')}>Done <span>{resolvedAnns.length}</span></button>
              </div>
              <button className="icon-btn" onClick={() => setPanelOpen(false)} aria-label="Close panel"><I.x /></button>
            </div>
            <div className="panel-body">
              {liveRuns.length > 0 && (
                <section>
                  <div className="panel-label">Working now</div>
                  {liveRuns.map((r) => (
                    <div key={r.key} className="panel-run" style={{ ['--c' as string]: colorOf(r.riddlerId) }}>
                      <div className="activity-who"><span className="who-dot" /> {who(r.riddlerId)} {r.background && <span className="badge">read-along</span>}</div>
                      <RunProgress run={r} who={who(r.riddlerId)} />
                    </div>
                  ))}
                </section>
              )}
              {listed.slice().reverse().map((a) => (
                <div key={a.id} className={`panel-item ${fresh.has(a.id) ? 'fresh' : ''}`}>
                  <AnnotationView a={a} compact riddler={a.riddlerId ? riddlerById[a.riddlerId] : undefined} inkColor={note.inkColor}
                    onUpdate={upsert} onRemove={removeAnn} onJump={a.anchor ? () => jump(a) : undefined} />
                </div>
              ))}
              {listed.length === 0 && liveRuns.length === 0 && (
                <div className="panel-empty">
                  {panelTab === 'open'
                    ? note.mode === 'thinks'
                      ? <>scratchpad is reading along. Notes show up here and as highlights in your text.</>
                      : <>Select text and choose <b>Explain</b>, <b>Diagram</b> or <b>Quiz</b>, or press <kbd>⌘K</kbd>.</>
                    : 'Notes you mark done land here. Reopen one to show it in the text again.'}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {pop && (popRun || pop.ids?.length) ? (
        <div className="ann-pop" ref={popRef} style={popStyle} role="dialog" aria-label="AI note">
          {popRun && (
            <AnnotationView a={{ id: popRun.key, noteId: note.id, kind: popRun.kind, anchor: null, body: '', drawing: null, riddlerId: popRun.riddlerId, thinking: null, status: 'open', replies: [], createdAt: popRun.startedAt }}
              run={popRun} riddler={popRun.riddlerId ? riddlerById[popRun.riddlerId] : undefined} inkColor={note.inkColor} onUpdate={upsert} onRemove={removeAnn} />
          )}
          {pop.ids?.map((id) => annById[id] && (
            <AnnotationView key={id} a={{ ...annById[id], anchor: pop.ids!.length > 1 ? annById[id].anchor : null }}
              riddler={annById[id].riddlerId ? riddlerById[annById[id].riddlerId!] : undefined}
              inkColor={note.inkColor} onUpdate={upsert} onRemove={removeAnn} />
          ))}
        </div>
      ) : null}

      {palette && (
        <AskPalette quote={palette.quote} riddlers={riddlers} inkColor={note.inkColor} ai={ai}
          run={paletteRun} result={paletteResult}
          onSubmit={(action, prompt, quote, rid) => { setPalette({ quote, runKey: null, resultId: null }); void ask(action, prompt, quote, rid, 'palette'); }}
          onClose={() => setPalette(null)} onOpenSettings={onOpenSettings} onUpdate={upsert} onRemove={removeAnn} />
      )}

      {purposeOpen && <PurposeModal value={note.purpose} onClose={() => setPurposeOpen(false)} onSave={(p: string) => { update({ purpose: p }, { immediate: true }); setPurposeOpen(false); }} />}
    </div>
  );
}
