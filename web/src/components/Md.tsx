import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { I } from '../ui';

let mermaidLoad: Promise<typeof import('mermaid').default> | null = null;
let mermaidSeq = 0;

/** Renders a ```mermaid block. Lazy-loads mermaid; falls back to the source on error. */
export function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    mermaidLoad ??= import('mermaid').then((m) => m.default);
    mermaidLoad
      .then(async (m) => {
        const dark = document.documentElement.dataset.theme === 'dark';
        m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'Inter, sans-serif' });
        const { svg: out } = await m.render(`mmd-${++mermaidSeq}`, code);
        if (alive) setSvg(out);
      })
      .catch((e) => alive && setErr(String(e?.message ?? e).split('\n')[0]));
    return () => { alive = false; };
  }, [code]);
  if (err) return <div className="code-block"><div className="code-head"><span>mermaid · could not render</span></div><pre><code>{code}</code></pre></div>;
  if (!svg) return <div className="mermaid-box loading"><span className="spinner" /> Rendering diagram…</div>;
  // mermaid output with securityLevel 'strict' is sanitized.
  return <div className="mermaid-box" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return '';
}

function CodeBlock({ lang, children, streaming }: { lang: string; children: ReactNode; streaming?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  if (lang === 'mermaid' && !streaming) return <Mermaid code={textOf(children).trim()} />;
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang === 'mermaid' ? 'diagram · drawing…' : lang || 'code'}</span>
        <button onClick={() => { navigator.clipboard?.writeText(ref.current?.innerText ?? ''); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
          {copied ? <><I.check size={12} /> Copied</> : <><I.copy size={12} /> Copy</>}
        </button>
      </div>
      <pre ref={ref}>{children}</pre>
    </div>
  );
}

/** GitHub-flavoured markdown with highlighted code, copy buttons and mermaid diagrams. */
export function Md({ text, streaming, className }: { text: string; streaming?: boolean; className?: string }) {
  return (
    <div className={`md ${streaming ? 'streaming' : ''} ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, plainText: ['mermaid', 'text', 'txt'] }]]}
        components={{
          pre: ({ children }) => {
            const code = Array.isArray(children) ? children[0] : children;
            const cls = (code && typeof code === 'object' && 'props' in code ? (code as { props: { className?: string } }).props.className : '') ?? '';
            const lang = /language-([\w+-]+)/.exec(cls)?.[1] ?? '';
            return <CodeBlock lang={lang} streaming={streaming}>{children}</CodeBlock>;
          },
          a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
