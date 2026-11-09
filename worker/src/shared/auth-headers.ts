// Adapted from server/src/ai/auth-headers.ts: factory credential type.
import type { createAuth } from '../auth.js';

export function authHeaders(
  credentials: Awaited<ReturnType<ReturnType<typeof createAuth>['getCredentials']>>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: 'Bearer ' + credentials.access,
  };
  if (credentials.authMethod === 'chatgpt') {
    headers['ChatGPT-Account-Id'] = credentials.accountId!;
    headers['OpenAI-Beta'] = 'responses=experimental';
    headers.originator = 'pi';
    headers['User-Agent'] = 'pi';
  }
  return headers;
}
