import { useCallback, useEffect, useState } from 'react';
import { api, type AuthMethods, type Note, type NoteSummary, type Riddler, type User } from './api';
import { NoteView } from './components/NoteView';
import { RiddlersModal } from './components/RiddlersModal';
import { Sidebar } from './components/Sidebar';
import { SignIn } from './components/SignIn';
import { I, Toaster, toast } from './ui';

const noteFromPath = () => location.pathname.match(/^\/n\/([^/]+)/)?.[1] ?? null;

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { const t = localStorage.getItem('dd-theme'); if (t === 'light' || t === 'dark') return t; } catch { /* ignore */ }
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('dd-theme', theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
}

export function App() {
  const [boot, setBoot] = useState<{ user: User | null; methods: AuthMethods } | null>(null);
  const [bootErr, setBootErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setBootErr(null);
    api.me().then(setBoot).catch((e) => setBootErr(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const h = () => setBoot((b) => (b ? { ...b, user: null } : b));
    window.addEventListener('dd:unauthorized', h);
    return () => window.removeEventListener('dd:unauthorized', h);
  }, []);

  if (bootErr) return <div className="empty-state"><div><h2>Can't reach doddled</h2><p>{bootErr}</p><button className="btn" onClick={load}>Try again</button></div></div>;
  if (!boot) return <div className="center-load">…</div>;
  if (!boot.user) return <><SignIn methods={boot.methods} onSignedIn={(user) => { history.replaceState(null, '', '/'); setBoot({ ...boot, user }); }} /><Toaster /></>;
  return <><Workspace user={boot.user} onSignedOut={() => setBoot({ ...boot, user: null })} /><Toaster /></>;
}

function Workspace({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [riddlers, setRiddlers] = useState<Riddler[]>([]);
  const [active, setActive] = useState<string | null>(noteFromPath);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [riddlersOpen, setRiddlersOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    api.notes().then((r) => setNotes(r.notes)).catch((e) => toast(e.message, 'error'));
    api.riddlers().then((r) => setRiddlers(r.riddlers)).catch(() => {});
  }, []);

  const open = useCallback((id: string | null, replace = false) => {
    setActive(id); setMobileOpen(false);
    const url = id ? `/n/${id}` : '/';
    if (location.pathname !== url) (replace ? history.replaceState : history.pushState).call(history, null, '', url);
  }, []);
  useEffect(() => {
    const h = () => setActive(noteFromPath());
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  }, []);
  // Default to most recent note.
  useEffect(() => { if (notes && !active && notes[0] && innerWidth > 760) open(notes[0].id, true); }, [notes, active, open]);

  const create = useCallback(async () => {
    try {
      const { note } = await api.createNote({ title: '', content: '', mode: 'thinks' });
      setNotes((ns) => [toSummary(note, 0), ...(ns ?? [])]);
      open(note.id);
    } catch (e) { toast((e as Error).message, 'error'); }
  }, [open]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); void create(); }
      if (mod && e.key === '\\') { e.preventDefault(); setCollapsed((c) => !c); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [create]);

  const logout = async () => { try { await api.logout(); } catch { /* ignore */ } history.replaceState(null, '', '/'); onSignedOut(); };

  const toggle = (
    <>
      <button className="icon-btn only-mobile" onClick={() => setMobileOpen(true)} aria-label="Open notes"><I.menu /></button>
      {collapsed && <button className="icon-btn hide-sm" onClick={() => setCollapsed(false)} aria-label="Show sidebar"><I.sidebar /></button>}
    </>
  );

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''} ${mobileOpen ? 'mobile-open' : ''}`}>
      {mobileOpen && <div className="scrim only-mobile" style={{ zIndex: 39, display: 'block' }} onClick={() => setMobileOpen(false)} />}
      <Sidebar notes={notes ?? []} activeId={active} user={user} onOpen={(id) => open(id)} onNew={create}
        onRiddlers={() => setRiddlersOpen(true)} onLogout={logout} theme={theme} onTheme={toggleTheme} onCollapse={() => { setCollapsed(true); setMobileOpen(false); }} />
      {active ? (
        <NoteView key={active} noteId={active} riddlers={riddlers} sidebarToggle={toggle}
          onOpenRiddlers={() => setRiddlersOpen(true)}
          onChanged={(n, count) => setNotes((ns) => {
            const list = ns ?? []; const s = toSummary(n, count);
            const i = list.findIndex((x) => x.id === n.id);
            const next = i === -1 ? [s, ...list] : list.map((x) => (x.id === n.id ? s : x));
            return next.sort((a, b) => b.updatedAt - a.updatedAt);
          })}
          onDeleted={() => { const rest = (notes ?? []).filter((n) => n.id !== active); setNotes(rest); open(rest[0]?.id ?? null, true); toast('Note deleted'); }} />
      ) : (
        <div className="main">
          <div className="topbar">{toggle}</div>
          <div className="empty-state">
            <div>
              <h2>{notes === null ? '…' : notes.length ? 'Pick a note' : 'Your first page'}</h2>
              <p>Write freely. doddled reads along and leaves its thoughts in the margin.</p>
              <button className="btn primary lg" onClick={create}><I.pen /> Start writing</button>
            </div>
          </div>
        </div>
      )}
      {riddlersOpen && <RiddlersModal riddlers={riddlers} onChange={setRiddlers} onClose={() => setRiddlersOpen(false)} />}
    </div>
  );
}

function toSummary(n: Note, annotationCount: number): NoteSummary {
  return { id: n.id, title: n.title, snippet: n.content.replace(/\s+/g, ' ').trim().slice(0, 90), mode: n.mode, inkColor: n.inkColor, updatedAt: n.updatedAt, annotationCount };
}
