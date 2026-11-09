import type { AIOptions, Emit } from '../types.js';

// Keep model identity and phases consistent, including client-generated statuses.
export function statusEmitter(emit: Emit, options: AIOptions, identity: Record<string, unknown> = {}): Emit {
  return (event, data) =>
    emit(event, {
      ...identity,
      ...data,
      ...(event === 'status'
        ? {
            model: options.model,
            effort: options.effort,
            phase: data.phase ?? (data.state === 'idle' ? 'done' : data.state),
          }
        : {}),
    });
}
