import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let value: unknown;
  try {
    const raw = await c.req.text();
    value = raw.trim() ? JSON.parse(raw) : (schema as z.ZodType) === empty ? {} : undefined;
  } catch {
    throw new HTTPException(400, { message: 'Expected a JSON body' });
  }
  return schema.parse(value);
}
export const empty = z.object({}).strict();
export const idSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
export function routeId(c: Context) {
  return idSchema.parse(c.req.param('id'));
}
export function missing(): never {
  throw new HTTPException(404, { message: 'Not found' });
}
