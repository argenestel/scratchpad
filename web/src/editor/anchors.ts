import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/** Text in the note that an AI note (or a live run) refers to. */
export type AnchorSpec = { id: string; text: string; color: string; live?: boolean; active?: boolean };
type State = { specs: AnchorSpec[]; deco: DecorationSet };
export const anchorKey = new PluginKey<State>('dd-anchors');

/** Find `needle` inside a single textblock; returns doc positions. Tries a markdown-stripped variant too. */
export function findText(doc: PMNode, raw: string): { from: number; to: number } | null {
  const candidates = [raw, raw.replace(/[*_`]/g, ''), raw.split(/\n\s*\n/)[0]]
    .map((s) => s.trim())
    .filter((s, i, a) => s.length > 1 && a.indexOf(s) === i);
  for (const needle of candidates) {
    let hit: { from: number; to: number } | null = null;
    doc.descendants((node, pos) => {
      if (hit) return false;
      if (!node.isTextblock) return true;
      let text = '';
      const map: number[] = [];
      node.forEach((child, offset) => {
        if (child.isText && child.text) {
          for (let i = 0; i < child.text.length; i++) map.push(pos + 1 + offset + i);
          text += child.text;
        } else {
          map.push(pos + 1 + offset);
          text += '￼';
        }
      });
      const i = text.indexOf(needle);
      if (i >= 0) hit = { from: map[i], to: map[i + needle.length - 1] + 1 };
      return false;
    });
    if (hit) return hit;
  }
  return null;
}

function build(doc: PMNode, specs: AnchorSpec[]): DecorationSet {
  const decos: Decoration[] = [];
  for (const s of specs) {
    const r = findText(doc, s.text);
    if (!r) continue;
    decos.push(
      Decoration.inline(r.from, r.to, {
        class: `dd-anchor${s.live ? ' live' : ''}${s.active ? ' active' : ''}`,
        'data-ann': s.id,
        style: `--c:${s.color}`,
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

export const AnchorHighlights = Extension.create<{ onClick: (id: string, el: HTMLElement) => void }>({
  name: 'anchorHighlights',
  addOptions() {
    return { onClick: () => {} };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin<State>({
        key: anchorKey,
        state: {
          init: () => ({ specs: [], deco: DecorationSet.empty }),
          apply(tr, value, _old, next) {
            const specs = (tr.getMeta(anchorKey) as AnchorSpec[] | undefined) ?? value.specs;
            if (!tr.docChanged && specs === value.specs) return value;
            return { specs, deco: build(next.doc, specs) };
          },
        },
        props: {
          decorations: (state) => anchorKey.getState(state)?.deco,
          handleClick(_view, _pos, event) {
            const el = (event.target as HTMLElement).closest<HTMLElement>('[data-ann]');
            if (el) options.onClick(el.dataset.ann!, el);
            return false;
          },
        },
      }),
    ];
  },
});
