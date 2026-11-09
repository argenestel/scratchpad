import { useMemo, useState } from 'react';
import type { NoteSummary, User } from '../api';
import { I, Popover, timeAgo } from '../ui';

export function Sidebar({ notes, activeId, user, onOpen, onNew, onRiddlers, onSettings, onLogout, theme, onTheme, onCollapse }: {
  notes: NoteSummary[]; activeId: string | null; user: User; onOpen: (id: string) => void; onNew: () => void;
  onRiddlers: () => void; onSettings: () => void; onLogout: () => void; theme: 'light' | 'dark'; onTheme: () => void; onCollapse: () => void;
}) {
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? notes.filter((n) => n.title.toLowerCase().includes(s) || n.snippet.toLowerCase().includes(s)) : notes;
  }, [notes, q]);
  const name = user.name || user.email || 'You';

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <span className="wordmark">doddled<i>.</i></span>
        <div style={{ display: 'flex' }}>
          <button className="icon-btn" onClick={onNew} aria-label="New note" title="New note (⌘⇧O)"><I.pen /></button>
          <button className="icon-btn" onClick={onCollapse} aria-label="Hide sidebar"><I.sidebar /></button>
        </div>
      </div>
      <div className="search"><I.search /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" /></div>
      <nav className="note-list">
        <button className="note-item" onClick={onRiddlers}><div className="t"><I.users /> Riddlers</div></button>
        <button className="note-item" onClick={onSettings}><div className="t"><I.sliders /> Models &amp; thinking</div></button>
        <div className="list-label">Notes</div>
        {filtered.length === 0 && <div style={{ padding: '6px 10px', color: 'var(--text-3)', fontSize: 13 }}>{q ? 'No matches' : 'No notes yet'}</div>}
        {filtered.map((n) => (
          <button key={n.id} className={`note-item ${n.id === activeId ? 'active' : ''}`} onClick={() => onOpen(n.id)}>
            <div className="t">
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{n.title || 'Untitled'}</span>
              {n.annotationCount > 0 && <span className="count" style={{ color: n.inkColor }}>{n.annotationCount}</span>}
            </div>
            <div className="s">{timeAgo(n.updatedAt)}{n.snippet ? ` · ${n.snippet}` : ''}</div>
          </button>
        ))}
      </nav>
      <div className="sidebar-foot">
        <div className="avatar">{name[0]?.toUpperCase()}</div>
        <div className="who"><b>{name}</b><span>{user.authMethod === 'chatgpt' ? `ChatGPT${user.plan ? ` · ${user.plan}` : ''}` : 'API key'}</span></div>
        <Popover align="right" up trigger={(t) => <button className="icon-btn" onClick={t} aria-label="Account"><I.more /></button>}>
          {(close) => (
            <div>
              <button className="menu-item" onClick={() => { onSettings(); close(); }}><I.sliders /> Settings</button>
              <button className="menu-item" onClick={() => { onTheme(); close(); }}>{theme === 'dark' ? <I.sun /> : <I.moon />} {theme === 'dark' ? 'Light' : 'Dark'} paper</button>
              <div className="menu-sep" />
              <button className="menu-item danger" onClick={onLogout}><I.logout /> Sign out</button>
            </div>
          )}
        </Popover>
      </div>
    </aside>
  );
}
