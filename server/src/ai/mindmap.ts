// Shared by both backends. Keep structural syntax separate from untrusted labels.
function label(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\p{M}\s_.-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sanitizeMindmap(text: string): string | null {
  const fence = /(?:^|\n)```mermaid[^\S\r\n]*\r?\n([\s\S]*?)\r?\n```(?=\s|$)/g;
  for (const match of text.matchAll(fence)) {
    const lines = match[1].split(/\r?\n/).filter((line) => line.trim());
    if (lines.shift()?.trim() !== 'mindmap') continue;
    const root = /^\s*root\(\(([\s\S]*)\)\)\s*$/.exec(lines[0] ?? '');
    if (!root || lines.length < 2 || lines.length > 30 || !label(root[1])) continue;
    const output = ['mindmap', `  root((${label(root[1])}))`];
    const indents = [0];
    let valid = true;
    for (const line of lines.slice(1)) {
      const indent = line.match(/^\s*/)![0].replace(/\t/g, '  ').length;
      const rootIndent = lines[0].match(/^\s*/)![0].replace(/\t/g, '  ').length;
      const relative = indent - rootIndent;
      if (relative <= 0 || !label(line)) {
        valid = false;
        break;
      }
      while (indents.length > 1 && relative < indents.at(-1)!) indents.pop();
      if (relative > indents.at(-1)!) indents.push(relative);
      if (relative !== indents.at(-1) || indents.length > 4) {
        valid = false;
        break;
      }
      output.push(`${'  '.repeat(indents.length)}${label(line)}`);
    }
    if (valid) return '```mermaid\n' + output.join('\n') + '\n```';
  }
  return null;
}

// A deterministic outline avoids a third model call after two invalid outputs.
export function mindmapOutline(source: string): string {
  const lines = source.split(/\r?\n/).map(label).filter(Boolean).slice(0, 30);
  return (lines.length ? lines : ['Empty note']).map((line) => `- ${line}`).join('\n');
}
