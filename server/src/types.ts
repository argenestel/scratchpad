import { z } from 'zod';
import { pathWithinBox } from './ai/drawing.js';
export type User = {
  id: string;
  email: string | null;
  name: string | null;
  plan: string | null;
  authMethod: 'chatgpt' | 'apikey';
};
export type Env = { Variables: { user: User } };
export const colorSchema = z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
export const drawingSchema = z
  .object({
    viewBox: z
      .string()
      .regex(/^\s*-?\d+(?:\.\d+)?[ ,]+-?\d+(?:\.\d+)?[ ,]+\d+(?:\.\d+)?[ ,]+\d+(?:\.\d+)?\s*$/)
      .refine((v) =>
        v
          .trim()
          .split(/[ ,]+/)
          .map(Number)
          .slice(2)
          .every((n) => n > 0),
      ),
    steps: z
      .array(
        z.object({
          caption: z.string().optional(),
          strokes: z
            .array(
              z.object({
                d: z
                  .string()
                  .min(1)
                  .max(30000)
                  .regex(/^[MmZzLlHhVvCcSsQqTtAaEe\d\s.,+\-]+$/),
                width: z.number().positive().max(50).optional(),
              }),
            )
            .min(1)
            .max(100),
          labels: z
            .array(z.object({ x: z.number().finite(), y: z.number().finite(), text: z.string() }))
            .optional(),
        }),
      )
      .min(2)
      .max(6),
  })
  .superRefine((drawing, ctx) => {
    const box = drawing.viewBox.trim().split(/[ ,]+/).map(Number);
    for (const [i, step] of drawing.steps.entries()) {
      for (const stroke of step.strokes)
        if (!pathWithinBox(stroke.d, box))
          ctx.addIssue({
            code: 'custom',
            message: 'Invalid path or coordinates outside viewBox',
            path: ['steps', i, 'strokes'],
          });
      for (const label of step.labels || [])
        if (label.x < box[0] || label.x > box[0] + box[2] || label.y < box[1] || label.y > box[1] + box[3])
          ctx.addIssue({ code: 'custom', message: 'Label outside viewBox', path: ['steps', i, 'labels'] });
    }
  });
export type Drawing = z.infer<typeof drawingSchema>;
export type Mode = 'thinks' | 'ask';
export type Note = {
  id: string;
  title: string;
  content: string;
  mode: Mode;
  purpose: string;
  inkColor: string;
  riddlerIds: string[];
  createdAt: number;
  updatedAt: number;
};
export type NoteSummary = {
  id: string;
  title: string;
  snippet: string;
  mode: Mode;
  inkColor: string;
  updatedAt: number;
  annotationCount: number;
};
export type Riddler = { id: string; name: string; persona: string; color: string; builtin: boolean };
export type Reply = {
  id: string;
  role: 'user' | 'ai';
  body: string;
  thinking: string | null;
  createdAt: number;
};
export type Annotation = {
  id: string;
  noteId: string;
  kind: 'question' | 'explain' | 'drawing' | 'comment';
  anchor: string | null;
  body: string;
  drawing: Drawing | null;
  riddlerId: string | null;
  thinking: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  replies: Reply[];
  createdAt: number;
};
export type Emit = (event: string, data: Record<string, unknown>) => void | Promise<void>;

export type Effort = string;
export type ModelInfo = {
  id: string;
  name: string;
  description: string;
  defaultEffort: Effort;
  efforts: Effort[];
};
export type Settings = {
  askStyle: 'comment' | 'block';
  readAlongStyle: 'comment' | 'block';
  model: string;
  effort: Effort;
  summary: 'concise' | 'detailed' | 'auto' | 'off';
  backgroundModel: string | null;
  backgroundEffort: Effort | null;
};
export type AIOptions = Pick<Settings, 'model' | 'effort' | 'summary'>;
