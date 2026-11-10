import { useEffect, useRef, useState, type ReactNode } from 'react';

const P = (d: ReactNode) => (p: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={p.size ?? 16} height={p.size ?? 16} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{d}</svg>
);
export const I = {
  plus: P(<path d="M12 5v14M5 12h14" />),
  search: P(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  send: P(<path d="M5 12h13M13 6l6 6-6 6" />),
  sidebar: P(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></>),
  menu: P(<path d="M4 7h16M4 12h16M4 17h16" />),
  more: P(<><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>),
  check: P(<path d="m5 12 5 5 9-10" />),
  x: P(<path d="M6 6l12 12M18 6 6 18" />),
  trash: P(<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />),
  chevron: P(<path d="m9 6 6 6-6 6" />),
  pen: P(<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4" />),
  draw: P(<path d="M3 17c3-6 5-9 7-9s2 3 0 6-3 5 0 5 6-4 8-9" />),
  question: P(<><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5v.4M12 17h.01" /></>),
  bulb: P(<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.4 1 1.1 1 1.8V16h5v-.3c0-.7.4-1.4 1-1.8A6 6 0 0 0 12 3z" />),
  chat: P(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />),
  users: P(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" /></>),
  target: P(<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="5" /><circle cx="12" cy="12" r="1" /></>),
  logout: P(<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" />),
  sun: P(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  moon: P(<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />),
  expand: P(<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />),
  replay: P(<path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4" />),
  key: P(<><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M15 8l2 2" /></>),
  terminal: P(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" /></>),
  device: P(<><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18h2" /></>),
  sliders: P(<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4" />),
  list: P(<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />),
  listOrdered: P(<path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.5 14.5c.5-1 2.5-1 2.5.4 0 1.1-2.5 2.1-2.5 3.1H6" />),
  checkSquare: P(<><rect x="3.5" y="3.5" width="17" height="17" rx="4" /><path d="m8 12 3 3 5-6" /></>),
  code: P(<path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />),
  quote: P(<path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6" />),
  minus: P(<path d="M5 12h14" />),
  panel: P(<><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /></>),
  copy: P(<><rect x="8" y="8" width="12" height="12" rx="3" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>),
  sparkle: P(<path d="M12 3c.6 4.2 2.8 6.4 7 7-4.2.6-6.4 2.8-7 7-.6-4.2-2.8-6.4-7-7 4.2-.6 6.4-2.8 7-7zM19 16c.2 1.5 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-1 2.5-2.5z" />),
  mindmap: P(<><circle cx="12" cy="12" r="2.5" /><circle cx="4.5" cy="6" r="2" /><circle cx="19.5" cy="6" r="2" /><circle cx="4.5" cy="18" r="2" /><circle cx="19.5" cy="18" r="2" /><path d="M10 11 6.3 7.2M14 11l3.7-3.8M10 13l-3.7 3.8M14 13l3.7 3.8" /></>),
  doc: P(<><path d="M7 3h7l5 5v13H7z" /><path d="M14 3v5h5M10 13h6M10 17h6" /></>),
  stop: P(<rect x="7" y="7" width="10" height="10" rx="2" />),
};

/** scratchpad mark: a pad with a pen scribble. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden className="logo">
      <rect x="3" y="3" width="26" height="26" rx="7" fill="var(--text)" />
      <path d="M9 11h9M9 15.5h14M9 20h6" stroke="var(--paper)" strokeWidth="2" strokeLinecap="round" opacity=".55" />
      <path d="M17.5 22.5c2-3.2 3.6-5 5-5 1 0 .8 1.6-.4 2.8" fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export function Wordmark({ size = 22 }: { size?: number }) {
  return <span className="wordmark" style={{ fontSize: size * 0.82 }}><Logo size={size} />scratchpad</span>;
}

export function OpenAIMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden>
      <path d="M21.6 9.8a5.4 5.4 0 0 0-.5-4.5 5.5 5.5 0 0 0-5.9-2.6A5.5 5.5 0 0 0 5.9 4.6a5.4 5.4 0 0 0-3.6 2.6 5.5 5.5 0 0 0 .7 6.4 5.4 5.4 0 0 0 .5 4.5 5.5 5.5 0 0 0 5.9 2.6 5.4 5.4 0 0 0 4.1 1.8 5.5 5.5 0 0 0 5.2-3.8 5.4 5.4 0 0 0 3.6-2.6 5.5 5.5 0 0 0-.7-6.3zm-8.2 11.4a4 4 0 0 1-2.6-.9l.1-.1 4.3-2.5a.7.7 0 0 0 .4-.6v-6.1l1.8 1v5.1a4 4 0 0 1-4 4.1zm-8.7-3.7a4 4 0 0 1-.5-2.7l.1.1 4.3 2.5a.7.7 0 0 0 .7 0l5.3-3v2.1l-4.4 2.5a4 4 0 0 1-5.5-1.5zM3.6 8.1a4 4 0 0 1 2.1-1.8v5.1a.7.7 0 0 0 .4.6l5.2 3-1.8 1.1-4.4-2.5a4 4 0 0 1-1.5-5.5zm14.9 3.5-5.3-3 1.8-1.1 4.4 2.5a4 4 0 0 1-.6 7.3v-5.1a.7.7 0 0 0-.3-.6zm1.8-2.7-.1-.1-4.3-2.5a.7.7 0 0 0-.7 0l-5.3 3V7.2l4.4-2.5a4 4 0 0 1 6 4.2zM9.2 12.6l-1.8-1V6.5a4 4 0 0 1 6.6-3.1l-.1.1-4.3 2.5a.7.7 0 0 0-.4.6zm1-2.1 2.4-1.4 2.4 1.4v2.8L12.6 15l-2.4-1.4z" />
    </svg>
  );
}

/** Popover that closes on outside click / Escape. */
export function Popover({ trigger, children, align = 'left', up = false, open: ctlOpen, onOpenChange }: {
  trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode;
  align?: 'left' | 'right'; up?: boolean; open?: boolean; onOpenChange?: (o: boolean) => void;
}) {
  const [own, setOwn] = useState(false);
  const open = ctlOpen ?? own;
  const set = (o: boolean) => { setOwn(o); onOpenChange?.(o); };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) set(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') set(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className="pop-anchor" ref={ref}>
      {trigger(() => set(!open), open)}
      {open && <div className={`popover ${align === 'right' ? 'right' : ''} ${up ? 'up' : ''}`}>{children(() => set(false))}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal>
        <div className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close"><I.x /></button></div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** Minimal, safe markdown: paragraphs, lists, **bold**, *italic*, `code`. */
export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  const out: ReactNode[] = [];
  blocks.forEach((b, bi) => {
    const lines = b.split('\n');
    const last = bi === blocks.length - 1;
    if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l) || !l.trim())) {
      const ordered = /^\s*\d/.test(lines[0] ?? '');
      const items = lines.filter((l) => l.trim()).map((l, i) => <li key={i}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>);
      out.push(ordered ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>);
    } else {
      out.push(<p key={bi} className={last && caret ? 'caret' : undefined}>{lines.map((l, i) => <span key={i}>{i > 0 && <br />}{inline(l)}</span>)}</p>);
    }
  });
  if (!out.length && caret) out.push(<p key="c" className="caret" />);
  return <>{out}</>;
}
function inline(s: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('**')) parts.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) parts.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else parts.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) parts.push(s.slice(last));
  return parts;
}

export function timeAgo(ts: number) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const INKS = ['#2b4acb', '#c2410c', '#0f766e', '#7c3aed', '#be123c', '#1f1c17'];

type ToastAction = { label: string; run: () => void };
type ToastData = { msg: string; kind: 'info' | 'error'; action?: ToastAction };
let toastTimer: number | undefined;
export function toast(msg: string, kind: 'info' | 'error' = 'info', action?: ToastAction) {
  window.dispatchEvent(new CustomEvent<ToastData>('dd:toast', { detail: { msg, kind, action } }));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => window.dispatchEvent(new CustomEvent('dd:toast', { detail: null })), action ? 6000 : 3600);
}
export function Toaster() {
  const [t, setT] = useState<ToastData | null>(null);
  useEffect(() => {
    const h = (e: Event) => setT((e as CustomEvent<ToastData | null>).detail);
    window.addEventListener('dd:toast', h);
    return () => window.removeEventListener('dd:toast', h);
  }, []);
  if (!t) return null;
  return (
    <div className={`toast ${t.kind === 'error' ? 'error' : ''}`} role="status">
      {t.msg}
      {t.action && <button className="toast-action" onClick={() => { t.action!.run(); setT(null); }}>{t.action.label}</button>}
    </div>
  );
}
