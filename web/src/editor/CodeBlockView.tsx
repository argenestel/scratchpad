import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { useState } from 'react';
import { Mermaid } from '../components/Md';
import { I } from '../ui';

const LANGS = ['', 'ts', 'js', 'tsx', 'python', 'go', 'rust', 'java', 'sql', 'bash', 'json', 'yaml', 'html', 'css', 'mermaid'];

/** Code block with a language picker; ```mermaid blocks show the rendered diagram with an Edit toggle. */
export function CodeBlockView({ node, updateAttributes, selected }: NodeViewProps) {
  const lang: string = node.attrs.language ?? '';
  const isMermaid = lang === 'mermaid';
  const [editing, setEditing] = useState(false);
  const source = node.textContent;
  const showSource = !isMermaid || editing || !source.trim();

  return (
    <NodeViewWrapper className={`cb ${isMermaid ? 'cb-mermaid' : ''} ${selected ? 'cb-selected' : ''}`}>
      <div className="cb-head" contentEditable={false}>
        <select value={LANGS.includes(lang) ? lang : ''} onChange={(e) => updateAttributes({ language: e.target.value || null })} aria-label="Code language">
          {LANGS.map((l) => <option key={l} value={l}>{l || 'plain text'}</option>)}
          {!LANGS.includes(lang) && lang && <option value={lang}>{lang}</option>}
        </select>
        {isMermaid && source.trim() && (
          <button onClick={() => setEditing((x) => !x)}>{editing ? <><I.check size={12} /> Done editing</> : <><I.pen size={12} /> Edit source</>}</button>
        )}
        <button onClick={() => navigator.clipboard?.writeText(source)}><I.copy size={12} /> Copy</button>
      </div>
      {isMermaid && !editing && source.trim() && (
        <div className="cb-diagram" contentEditable={false} onDoubleClick={() => setEditing(true)}>
          <Mermaid code={source} />
        </div>
      )}
      <pre className={showSource ? '' : 'cb-hidden'}><NodeViewContent as="code" /></pre>
    </NodeViewWrapper>
  );
}
