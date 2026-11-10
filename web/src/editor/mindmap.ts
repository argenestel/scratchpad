import type { JSONContent } from '@tiptap/react';

/** Mermaid mindmap labels break on brackets, quotes and colons; keep them short and plain. */
export function cleanLabel(text: string, max = 48) {
  const t = text.replace(/[()[\]{}"'`:;<>#|]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trim()}…` : t;
}

const textOf = (n: JSONContent): string => (n.text ?? '') + (n.content ?? []).map(textOf).join(n.type === 'paragraph' ? '' : ' ');

type Branch = { label: string; children: Branch[] };

/**
 * Builds a mind map from the note's structure: headings nest by level, list items keep their
 * nesting, and a heading's first paragraphs become short leaves. Pure and instant (no AI).
 */
export function noteToMindmap(title: string, doc: JSONContent): string {
  const root: Branch = { label: cleanLabel(title || 'Untitled', 40) || 'Untitled', children: [] };
  const stack: { level: number; node: Branch }[] = [{ level: 0, node: root }];
  const parent = () => stack[stack.length - 1].node;

  const addList = (list: JSONContent, into: Branch, depth = 0) => {
    for (const item of list.content ?? []) {
      const para = item.content?.find((c) => c.type === 'paragraph');
      const label = cleanLabel(para ? textOf(para) : textOf(item));
      if (!label) continue;
      const b: Branch = { label: item.attrs?.checked ? `✓ ${label}` : label, children: [] };
      into.children.push(b);
      if (depth < 2) for (const sub of item.content ?? []) if (/List$/.test(sub.type ?? '')) addList(sub, b, depth + 1);
    }
  };

  for (const block of doc.content ?? []) {
    if (block.type === 'heading') {
      const level = block.attrs?.level ?? 1;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) stack.pop();
      const b: Branch = { label: cleanLabel(textOf(block)), children: [] };
      if (!b.label) continue;
      parent().children.push(b);
      stack.push({ level, node: b });
    } else if (/List$/.test(block.type ?? '')) {
      addList(block, parent());
    } else if (block.type === 'paragraph' && parent().children.length < 6) {
      const label = cleanLabel(textOf(block), 40);
      if (label) parent().children.push({ label, children: [] });
    } else if (block.type === 'codeBlock' && block.attrs?.language !== 'mermaid') {
      parent().children.push({ label: `code ${block.attrs?.language ?? ''}`.trim(), children: [] });
    }
  }

  const out = ['mindmap', `  root((${root.label}))`];
  const walk = (b: Branch, depth: number) => {
    for (const c of b.children.slice(0, 12)) {
      out.push(`${'  '.repeat(depth + 2)}${c.label}`);
      if (depth < 3) walk(c, depth + 1);
    }
  };
  walk(root, 0);
  return out.join('\n');
}
