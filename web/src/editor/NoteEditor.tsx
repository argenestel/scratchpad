import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { BubbleMenu, EditorContent, ReactNodeViewRenderer, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { common, createLowlight } from 'lowlight';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { Markdown } from 'tiptap-markdown';
import type { AskAction } from '../api';
import { I } from '../ui';
import { AnchorHighlights, anchorKey, findText, type AnchorSpec } from './anchors';
import { aiBlocks } from './aiblocks';
import { CodeBlockView } from './CodeBlockView';
import { slashCommand, type SlashItem } from './slash';

const lowlight = createLowlight(common);

export type EditorHandle = {
  /** Current selection text + screen rect (null when empty). */
  selection(): { text: string; rect: DOMRect } | null;
  /** Text of the block containing the cursor. */
  currentBlock(): { text: string; rect: DOMRect } | null;
  /** Screen rect of a piece of note text, if present. */
  rectOf(text: string): DOMRect | null;
  scrollTo(text: string): void;
  focus(): void;
  dom(): HTMLElement | null;
  /** Document as TipTap JSON (for the mind map view). */
  json(): JSONContent | null;
  /** Insert an AI block after the block containing `afterText` (or at the end). Returns false if not inserted. */
  insertBlock(markdown: string, afterText: string | null): boolean;
};

type Props = {
  markdown: string;
  placeholder: string;
  anchors: AnchorSpec[];
  onChange: (md: string) => void;
  onAnchorClick: (id: string, el: HTMLElement) => void;
  /** AI action on selected text or the current block. */
  onAI: (action: AskAction, text: string, rect: DOMRect | null) => void;
  /** Open the ask palette, optionally quoting text. */
  onAsk: (quote: string | null) => void;
};

const H = (n: number) => <span className="slash-glyph">H{n}</span>;

export const NoteEditor = forwardRef<EditorHandle, Props>(function NoteEditor(props, ref) {
  const cb = useRef(props);
  cb.current = props;

  const items = useMemo<SlashItem[]>(() => {
    const block = (editor: Editor) => {
      const { $from } = editor.state.selection;
      const text = $from.parent.textContent.trim();
      const coords = editor.view.coordsAtPos($from.pos);
      return { text, rect: new DOMRect(coords.left, coords.top, 1, coords.bottom - coords.top) };
    };
    const ai = (action: AskAction) => (editor: Editor, range: { from: number; to: number }) => {
      editor.chain().focus().deleteRange(range).run();
      const b = block(editor);
      if (!b.text) return cb.current.onAsk(null);
      cb.current.onAI(action, b.text, b.rect);
    };
    return [
      { id: 'p', group: 'Blocks', title: 'Text', hint: 'Plain paragraph', icon: <I.pen />, keywords: 'paragraph', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
      { id: 'h1', group: 'Blocks', title: 'Heading 1', hint: 'Big section title', icon: H(1), keywords: 'title', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 1 }).run() },
      { id: 'h2', group: 'Blocks', title: 'Heading 2', hint: 'Medium section title', icon: H(2), run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
      { id: 'h3', group: 'Blocks', title: 'Heading 3', hint: 'Small section title', icon: H(3), run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
      { id: 'ul', group: 'Blocks', title: 'Bulleted list', hint: 'Simple list', icon: <I.list />, keywords: 'bullet', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
      { id: 'ol', group: 'Blocks', title: 'Numbered list', hint: 'Ordered steps', icon: <I.listOrdered />, keywords: 'ordered', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
      { id: 'todo', group: 'Blocks', title: 'To-do list', hint: 'Track tasks', icon: <I.checkSquare />, keywords: 'task checkbox', run: (e, r) => e.chain().focus().deleteRange(r).toggleTaskList().run() },
      { id: 'code', group: 'Blocks', title: 'Code block', hint: 'Syntax highlighted', icon: <I.code />, keywords: 'snippet', run: (e, r) => e.chain().focus().deleteRange(r).setCodeBlock().run() },
      { id: 'quote', group: 'Blocks', title: 'Quote', hint: 'Callout a passage', icon: <I.quote />, run: (e, r) => e.chain().focus().deleteRange(r).setBlockquote().run() },
      { id: 'hr', group: 'Blocks', title: 'Divider', hint: 'Separate sections', icon: <I.minus />, keywords: 'rule line', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
      { id: 'ask', group: 'scratchpad', title: 'Ask scratchpad', hint: 'Ask anything about this note', icon: <I.chat />, keywords: 'ai', run: (e, r) => { e.chain().focus().deleteRange(r).run(); cb.current.onAsk(null); } },
      { id: 'explain', group: 'scratchpad', title: 'Explain this block', hint: 'Plain-language walkthrough', icon: <I.bulb />, keywords: 'ai', run: ai('explain') },
      { id: 'diagram', group: 'scratchpad', title: 'Diagram this', hint: 'Sketch or flow diagram', icon: <I.draw />, keywords: 'ai draw mermaid', run: ai('draw') },
      { id: 'quiz', group: 'scratchpad', title: 'Quiz me', hint: 'Test your understanding', icon: <I.question />, keywords: 'ai question', run: ai('question') },
    ];
  }, []);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      CodeBlockLowlight.extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) }).configure({ lowlight, defaultLanguage: null }),
      aiBlocks,
      Placeholder.configure({
        includeChildren: false,
        placeholder: ({ node, editor: ed }) =>
          node.type.name === 'heading' ? `Heading ${node.attrs.level}` : ed.isEmpty ? cb.current.placeholder : "Type '/' for blocks and AI",
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({ openOnClick: false, autolink: true }),
      Markdown.configure({ html: false, tightLists: true, transformPastedText: true, linkify: true, breaks: false }),
      AnchorHighlights.configure({ onClick: (id, el) => cb.current.onAnchorClick(id, el) }),
      slashCommand(() => items),
    ],
    content: props.markdown,
    editorProps: { attributes: { class: 'doc', spellcheck: 'true' } },
    onUpdate: ({ editor: ed }) => cb.current.onChange((ed.storage as { markdown: { getMarkdown(): string } }).markdown.getMarkdown()),
  });

  // Push anchor highlights into the editor whenever they change.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.dispatch(editor.state.tr.setMeta(anchorKey, props.anchors).setMeta('addToHistory', false));
  }, [editor, props.anchors]);

  useImperativeHandle(ref, () => ({
    selection() {
      if (!editor) return null;
      const { from, to, empty } = editor.state.selection;
      if (empty) return null;
      const text = editor.state.doc.textBetween(from, to, '\n').trim();
      if (!text) return null;
      const a = editor.view.coordsAtPos(from);
      const b = editor.view.coordsAtPos(to);
      return { text, rect: new DOMRect(Math.min(a.left, b.left), a.top, Math.abs(b.right - a.left) || 1, b.bottom - a.top) };
    },
    currentBlock() {
      if (!editor) return null;
      const { $from } = editor.state.selection;
      const text = $from.parent.textContent.trim();
      if (!text) return null;
      const c = editor.view.coordsAtPos($from.pos);
      return { text, rect: new DOMRect(c.left, c.top, 1, c.bottom - c.top) };
    },
    rectOf(text) {
      if (!editor) return null;
      const r = findText(editor.state.doc, text);
      if (!r) return null;
      const a = editor.view.coordsAtPos(r.from);
      const b = editor.view.coordsAtPos(r.to);
      return new DOMRect(a.left, a.top, Math.max(1, b.right - a.left), b.bottom - a.top);
    },
    scrollTo(text) {
      if (!editor) return;
      const r = findText(editor.state.doc, text);
      if (!r) return;
      const dom = editor.view.domAtPos(r.from).node as HTMLElement;
      (dom.nodeType === 1 ? dom : dom.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
    focus: () => editor?.commands.focus(),
    dom: () => (editor ? (editor.view.dom as HTMLElement) : null),
    json: () => editor?.getJSON() ?? null,
    insertBlock(markdown, afterText) {
      if (!editor || editor.isDestroyed) return false;
      const { doc } = editor.state;
      let pos = doc.content.size;
      const hit = afterText ? findText(doc, afterText) : null;
      if (hit) pos = doc.resolve(hit.from).after(1); // end of the top-level block holding the anchor
      // tiptap-markdown parses Markdown strings passed to insertContentAt.
      return editor.chain().insertContentAt(pos, markdown).run();
    },
  }), [editor]);

  if (!editor) return null;

  const sel = () => {
    const { from, to } = editor.state.selection;
    const text = editor.state.doc.textBetween(from, to, '\n').trim();
    const a = editor.view.coordsAtPos(from);
    const b = editor.view.coordsAtPos(to);
    return { text, rect: new DOMRect(Math.min(a.left, b.left), a.top, Math.abs(b.right - a.left) || 1, b.bottom - a.top) };
  };
  // Collapse the selection so the floating menu gets out of the way once an AI action starts.
  const collapse = () => editor.chain().setTextSelection(editor.state.selection.to).run();
  const run = (action: AskAction) => { const s = sel(); if (!s.text) return; collapse(); props.onAI(action, s.text, s.rect); };

  return (
    <>
      <BubbleMenu editor={editor} tippyOptions={{ duration: 120, placement: 'top-start', maxWidth: 'none' }} className="bubble">
        {!editor.isActive('codeBlock') && <>
          <button className={editor.isActive('bold') ? 'on' : ''} onClick={() => editor.chain().focus().toggleBold().run()} aria-label="Bold"><b>B</b></button>
          <button className={editor.isActive('italic') ? 'on' : ''} onClick={() => editor.chain().focus().toggleItalic().run()} aria-label="Italic"><i>I</i></button>
          <button className={editor.isActive('strike') ? 'on' : ''} onClick={() => editor.chain().focus().toggleStrike().run()} aria-label="Strikethrough"><s>S</s></button>
          <button className={editor.isActive('code') ? 'on' : ''} onClick={() => editor.chain().focus().toggleCode().run()} aria-label="Inline code"><I.code /></button>
          <span className="bubble-sep" />
        </>}
        <button className="ai" onClick={() => { const s = sel(); collapse(); props.onAsk(s.text || null); }}><I.chat /> Ask</button>
        <button className="ai" onClick={() => run('explain')}><I.bulb /> Explain</button>
        <button className="ai" onClick={() => run('draw')}><I.draw /> Diagram</button>
        <button className="ai" onClick={() => run('question')}><I.question /> Quiz</button>
      </BubbleMenu>
      <EditorContent editor={editor} />
    </>
  );
});
