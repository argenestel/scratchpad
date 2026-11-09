import { Extension, type Editor, type Range } from '@tiptap/core';
import { ReactRenderer } from '@tiptap/react';
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from '@tiptap/suggestion';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';

export type SlashItem = {
  id: string; title: string; hint: string; group: 'Blocks' | 'doddled'; icon: ReactNode; keywords?: string;
  run: (editor: Editor, range: Range) => void;
};
type MenuProps = SuggestionProps<SlashItem>;
type MenuHandle = { onKeyDown: (e: KeyboardEvent) => boolean };

const SlashMenu = forwardRef<MenuHandle, MenuProps>(function SlashMenu({ items, command }, ref) {
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => setActive(0), [items]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  useImperativeHandle(ref, () => ({
    onKeyDown(e) {
      if (!items.length) return false;
      if (e.key === 'ArrowDown') { setActive((a) => (a + 1) % items.length); return true; }
      if (e.key === 'ArrowUp') { setActive((a) => (a - 1 + items.length) % items.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { command(items[active]); return true; }
      return false;
    },
  }));
  if (!items.length) return <div className="slash-menu"><div className="slash-empty">No matches</div></div>;
  let lastGroup = '';
  return (
    <div className="slash-menu" ref={listRef} role="listbox">
      {items.map((it, i) => {
        const head = it.group !== lastGroup ? <div className="slash-group" key={`g-${it.group}`}>{it.group}</div> : null;
        lastGroup = it.group;
        return (
          <div key={it.id} style={{ display: 'contents' }}>
            {head}
            <button data-i={i} role="option" aria-selected={i === active} className={`slash-item ${i === active ? 'on' : ''}`}
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); command(it); }}>
              <span className="slash-icon">{it.icon}</span>
              <span><b>{it.title}</b><small>{it.hint}</small></span>
            </button>
          </div>
        );
      })}
    </div>
  );
});

function place(el: HTMLElement, rect: DOMRect | null | undefined) {
  if (!rect) return;
  const h = Math.min(340, el.offsetHeight || 340);
  const below = rect.bottom + 6 + h < window.innerHeight;
  el.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
  el.style.top = below ? `${rect.bottom + 6}px` : `${rect.top - 6 - h}px`;
}

export function slashCommand(getItems: () => SlashItem[]) {
  return Extension.create({
    name: 'slashCommand',
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashItem>({
          editor: this.editor,
          char: '/',
          allowSpaces: false,
          startOfLine: false,
          allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
          items: ({ query }) => {
            const q = query.toLowerCase();
            return getItems().filter((i) => !q || `${i.title} ${i.keywords ?? ''}`.toLowerCase().includes(q)).slice(0, 14);
          },
          command: ({ editor, range, props }) => props.run(editor, range),
          render: () => {
            let r: ReactRenderer<MenuHandle, MenuProps> | null = null;
            let host: HTMLDivElement | null = null;
            return {
              onStart: (props) => {
                host = document.createElement('div');
                host.className = 'slash-host';
                document.body.appendChild(host);
                r = new ReactRenderer(SlashMenu, { props, editor: props.editor });
                host.appendChild(r.element);
                requestAnimationFrame(() => host && place(host, props.clientRect?.()));
              },
              onUpdate: (props) => {
                r?.updateProps(props);
                if (host) place(host, props.clientRect?.());
              },
              onKeyDown: (props: SuggestionKeyDownProps) => {
                if (props.event.key === 'Escape') { host?.remove(); r?.destroy(); r = null; host = null; return true; }
                return r?.ref?.onKeyDown(props.event) ?? false;
              },
              onExit: () => { host?.remove(); r?.destroy(); r = null; host = null; },
            };
          },
        }),
      ];
    },
  });
}
