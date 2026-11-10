import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * AI blocks are ordinary Markdown blockquotes whose first line is "✦ scratchpad · <label>".
 * Storing them as plain Markdown keeps notes portable; this plugin only styles them.
 */
export const AI_MARK = '✦ scratchpad';

function decorate(doc: PMNode) {
  const decos: Decoration[] = [];
  doc.forEach((node, offset) => {
    if (node.type.name === 'blockquote' && node.textContent.trimStart().startsWith(AI_MARK)) {
      decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'ai-block' }));
    }
  });
  return DecorationSet.create(doc, decos);
}

const key = new PluginKey<DecorationSet>('dd-ai-blocks');
export const aiBlocks = Extension.create({
  name: 'aiBlocks',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key,
        state: {
          init: (_, state) => decorate(state.doc),
          apply: (tr, old) => (tr.docChanged ? decorate(tr.doc) : old),
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});

/** Markdown for an AI block: a quoted header line followed by the answer, every line quoted. */
export function toBlockMarkdown(label: string, body: string) {
  const lines = [`**${AI_MARK} · ${label}**`, '', ...body.trim().split('\n')];
  return `\n${lines.map((l) => (l ? `> ${l}` : '>')).join('\n')}\n`;
}
