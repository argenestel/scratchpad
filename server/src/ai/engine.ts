import { sanitizeMindmap, mindmapOutline } from './mindmap.js';
import { mindmapRules } from './prompts.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { aiOptions } from '../settings.js';
import { response } from './client.js';
import { statusEmitter } from './status.js';
import { drawingRules, drawingDescription, instructions, reviewRules } from './prompts.js';
import {
  drawingSchema,
  type Note,
  type Riddler,
  type Emit,
  type Annotation,
  type AIOptions,
} from '../types.js';
import * as store from '../store.js';
export function extractJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{'),
      end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('Invalid JSON');
  }
}
const decisionSchema = z.object({
  speak: z.boolean(),
  kind: z.enum(['question', 'explain', 'drawing', 'comment']),
  anchor: z.string().nullable(),
  body: z.string(),
  drawing: drawingSchema.nullable().optional(),
});
const decisionFormat = {
  type: 'json_schema',
  name: 'speak_up',
  strict: false,
  schema: {
    type: 'object',
    properties: {
      speak: { type: 'boolean' },
      kind: { type: 'string', enum: ['question', 'explain', 'drawing', 'comment'] },
      anchor: { type: ['string', 'null'] },
      body: { type: 'string' },
      drawing: { type: ['object', 'null'], additionalProperties: true },
    },
    required: ['speak', 'kind', 'anchor', 'body'],
  },
};
function context(uid: string, note: Note) {
  return JSON.stringify({
    note,
    existingOpenAnnotations: store
      .annotations(uid, note.id)
      .filter((a) => a.status === 'open' && a.body)
      .map(({ kind, anchor, body }) => ({ kind, anchor, body })),
  });
}
function anchor(note: Note, value: string | null) {
  return store.normalizeAnchor(note.content, value);
}
// Decode only a complete prefix of the JSON body string, including split escapes.
function partialBody(json: string): string {
  const match = /"body"\s*:\s*"/.exec(json);
  if (!match) return '';
  let out = '';
  for (let i = match.index + match[0].length; i < json.length; i++) {
    const ch = json[i];
    if (ch === '"') return out;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    if (++i >= json.length) return out;
    const escaped = json[i];
    if (escaped === 'u') {
      const hex = json.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const escapes: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        '/': '/',
        b: '\b',
        f: '\f',
        n: '\n',
        r: '\r',
        t: '\t',
      };
      if (!(escaped in escapes)) return out;
      out += escapes[escaped];
    }
  }
  return out;
}
export async function review(
  uid: string,
  note: Note,
  riddler: Riddler | undefined,
  emit: Emit,
  annotation?: Annotation,
  resolvedOptions?: AIOptions,
): Promise<Annotation | null> {
  const options = resolvedOptions ?? (await aiOptions(uid, true));
  let currentAnnotationId = annotation?.id;
  const emitTagged: Emit = async (event, data) => {
    await emit(event, {
      ...data,
      ...(currentAnnotationId ? { annotationId: currentAnnotationId } : {}),
      ...(riddler ? { riddlerId: riddler.id } : {}),
    });
  };
  let raw = '',
    thinking = '';
  let streamedBody = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let incoming = '';
    const result = await response(
      uid,
      instructions(note, riddler) + '\n' + reviewRules + '\nDrawing schema: ' + drawingDescription,
      context(uid, note) +
        (annotation
          ? '\nThe user explicitly requested this riddler review. Return one useful annotation; speak true unless there is nothing to add.'
          : '') +
        (attempt ? '\nYour prior output was invalid. Return valid JSON matching the exact schema.' : ''),
      async (event, data) => {
        if (event === 'thinking' || (event === 'status' && data.state === 'thinking'))
          await emitTagged(event, data);
        if (event === 'text') {
          incoming += String(data.delta || '');
          if (/"speak"\s*:\s*true/.test(incoming)) {
            const prefix = partialBody(incoming);
            if (prefix.startsWith(streamedBody) && prefix.length > streamedBody.length) {
              if (!streamedBody)
                await emitTagged('status', { state: 'writing', riddlerId: riddler?.id ?? null });
              await emitTagged('text', { delta: prefix.slice(streamedBody.length) });
              streamedBody = prefix;
            }
          }
        }
      },
      options,
      decisionFormat,
    );
    raw = result.text;
    thinking += result.thinking;
    try {
      const d = decisionSchema.parse(extractJSON(raw));
      if (!d.speak) {
        if (!annotation) return null;
        const body = d.body || 'No new concerns to add from this perspective.';
        await emitTagged('status', { state: 'writing' });
        await emitTagged('text', { delta: body });
        return { ...annotation, body, thinking: thinking || null };
      }
      let drawing = d.drawing || null,
        kind = d.kind,
        body = d.body;
      if (kind === 'drawing' && !drawing) throw new Error('Drawing missing');
      if (drawing) {
        kind = 'drawing';
        await emitTagged('status', { state: 'drawing', riddlerId: riddler?.id ?? null });
      }
      const a: Annotation = {
        ...(annotation || store.newAnnotation(note, riddler?.id ?? null)),
        kind,
        anchor: anchor(note, d.anchor),
        body,
        drawing,
        thinking: thinking || null,
      };
      currentAnnotationId = a.id;
      if (body && body !== streamedBody) {
        await emitTagged('status', { state: 'writing', riddlerId: riddler?.id ?? null });
        await emitTagged('text', {
          delta: body.startsWith(streamedBody) ? body.slice(streamedBody.length) : body,
        });
      }
      return a;
    } catch {
      if (attempt === 1) {
        return {
          ...(annotation || store.newAnnotation(note, riddler?.id ?? null)),
          body: 'I could not prepare that margin note. Try asking a focused question.',
          thinking: thinking || null,
        };
      }
    }
  }
  return null;
}
export async function ask(
  uid: string,
  note: Note,
  data: {
    prompt: string;
    selection?: string;
    action?: 'ask' | 'explain' | 'draw' | 'question' | 'mindmap';
    riddlerId?: string;
  },
  emit: Emit,
  signal?: AbortSignal,
) {
  const options = await aiOptions(uid);
  const riddler = data.riddlerId ? store.getRiddler(uid, data.riddlerId) : undefined,
    a = store.newAnnotation(note, riddler?.id ?? null),
    draw = data.action === 'draw';
  a.anchor = anchor(note, data.selection || null);
  a.kind = draw
    ? 'drawing'
    : data.action === 'explain'
      ? 'explain'
      : data.action === 'question'
        ? 'question'
        : 'comment';
  emit = statusEmitter(emit, options, { riddlerId: riddler?.id ?? null });
  await emit('status', { state: 'thinking', phase: 'reading' });
  let thinking = '';
  if (data.action === 'mindmap') {
    a.kind = 'explain';
    await emit('status', { state: 'drawing', phase: 'drawing' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await response(
        uid,
        instructions(note, riddler) + '\n' + mindmapRules,
        JSON.stringify({ source: data.selection ?? note.content, prompt: data.prompt }) +
          (attempt ? '\nThe prior output was invalid. Follow the mindmap syntax rules exactly.' : ''),
        async (event, value) => {
          if (event === 'thinking') await emit(event, { ...value, annotationId: a.id });
        },
        options,
        undefined,
        signal,
      );
      thinking += result.thinking;
      const body = sanitizeMindmap(result.text);
      if (body) {
        a.body = body;
        break;
      }
      if (attempt === 1) a.body = mindmapOutline(data.selection ?? note.content);
    }
    await emit('text', { delta: a.body, annotationId: a.id });
  } else {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await response(
        uid,
        instructions(note, riddler) +
          (draw
            ? '\n' + drawingRules
            : '\nRespond directly in concise markdown. Prefer Mermaid in the Markdown body for technical diagrams. For other visuals, if an ink drawing would help, output ONLY a Drawing JSON object instead. ' +
              drawingDescription +
              ' Otherwise answer in markdown.'),
        context(uid, note) +
          '\n' +
          JSON.stringify(data) +
          (attempt
            ? '\nThe prior output was invalid. Return valid Drawing JSON, or Markdown containing a fenced mermaid block for a system/flow/sequence diagram.'
            : ''),
        async (event, value) => {
          if (event === 'thinking' || !draw || (event === 'status' && value.state === 'thinking'))
            await emit(event, { ...value, annotationId: a.id });
        },
        options,
        undefined,
        signal,
      );
      thinking += result.thinking;
      const mermaid =
        /(?:^|\n)```mermaid[^\S\r\n]*\r?\n\s*(?:flowchart\b|sequenceDiagram\b|stateDiagram-v2\b|erDiagram\b|classDiagram\b)[\s\S]+?\r?\n```(?:\s|$)/.test(
          result.text,
        );
      if (draw && mermaid) {
        a.kind = 'explain';
        a.body = result.text;
        await emit('status', { state: 'writing' });
        await emit('text', { delta: a.body, annotationId: a.id });
        break;
      }
      const isDrawing =
        draw || (/^[\s`]*(?:json\s*)?\{/.test(result.text) && /"(?:viewBox|steps)"/.test(result.text));
      if (isDrawing) {
        try {
          a.drawing = drawingSchema.parse(extractJSON(result.text));
          await emit('status', { state: 'drawing' });
          a.kind = 'drawing';
          a.body = '';
          break;
        } catch {
          if (attempt === 1) {
            a.kind = 'comment';
            a.body = 'I could not prepare a valid drawing. Try a more specific drawing request.';
            await emit('status', { state: 'writing' });
            await emit('text', { delta: a.body, annotationId: a.id });
          }
        }
      } else {
        a.body = result.text;
        break;
      }
    }
  }
  a.thinking = thinking || null;
  store.putAnnotation(uid, a);
  await emit('status', { state: 'idle', phase: 'done' });
  await emit('annotation', { annotation: a });
}
export async function reply(uid: string, a: Annotation, text: string, emit: Emit, signal?: AbortSignal) {
  const options = await aiOptions(uid);
  const note = store.getNote(uid, a.noteId),
    riddler = a.riddlerId ? store.riddlers(uid).find((r) => r.id === a.riddlerId) : undefined;
  emit = statusEmitter(emit, options, { riddlerId: a.riddlerId });
  await emit('status', { state: 'thinking', phase: 'reading' });
  a.replies.push({ id: randomUUID(), role: 'user', body: text, thinking: null, createdAt: Date.now() });
  store.putAnnotation(uid, a);
  const result = await response(
    uid,
    instructions(note, riddler) +
      '\nRespond concisely to the latest user reply in this annotation thread. Use markdown.',
    JSON.stringify({ note, annotation: a }),
    async (event, value) => {
      await emit(event, { ...value, annotationId: a.id });
    },
    options,
    undefined,
    signal,
  );
  const latest = store.getAnnotation(uid, a.id);
  latest.replies.push({
    id: randomUUID(),
    role: 'ai',
    body: result.text,
    thinking: result.thinking || null,
    createdAt: Date.now(),
  });
  store.putAnnotation(uid, latest);
  await emit('status', { state: 'idle', phase: 'done' });
  await emit('annotation', { annotation: latest });
}
