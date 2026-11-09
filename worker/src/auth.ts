// Ported from server/src/auth.ts: preserve Codex device OAuth and session semantics.
// D1 leases replace process-local locks; WebCrypto replaces Node crypto.
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Bindings, Env, User } from './types.js';
import { body, empty } from './http.js';
import { createStore } from './store.js';

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const BASE = 'https://auth.openai.com';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
type Tokens = { access: string; refresh: string; idToken?: string; expires: number; accountId: string };
type UserRow = {
  id: string;
  account_id: string | null;
  email: string | null;
  name: string | null;
  plan: string | null;
  auth_method: 'chatgpt' | 'apikey';
  tokens: string | null;
};
type Device = { userCode: string; expires: number; interval: number; next: number };
function encode(bytes: Uint8Array) {
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
}
function decode(value: string) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}
function jwt(value?: string): Record<string, any> {
  try {
    return JSON.parse(decoder.decode(decode(value!.split('.')[1])));
  } catch {
    return {};
  }
}
function user(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, plan: row.plan, authMethod: row.auth_method };
}
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().optional(),
  expires_in: z.number().positive().optional(),
});
async function tokenRequest(params: Record<string, string>, old?: Tokens): Promise<Tokens> {
  const res = await fetch(BASE + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...params }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new HTTPException(502, { message: 'ChatGPT token exchange failed; sign in again' });
  const t = tokenSchema.parse(await res.json());
  const id = jwt(t.id_token),
    access = jwt(t.access_token);
  const accountId =
    access['https://api.openai.com/auth']?.chatgpt_account_id ||
    id['https://api.openai.com/auth']?.chatgpt_account_id ||
    old?.accountId;
  if (typeof accountId !== 'string' || !accountId)
    throw new HTTPException(502, { message: 'ChatGPT account ID missing' });
  const refresh = t.refresh_token || old?.refresh;
  if (!refresh) throw new HTTPException(502, { message: 'ChatGPT refresh token missing' });
  return {
    access: t.access_token,
    refresh,
    idToken: t.id_token || old?.idToken,
    expires: t.expires_in ? Date.now() + t.expires_in * 1000 : (access.exp || 0) * 1000,
    accountId,
  };
}

export function createAuth(env: Bindings) {
  if (!env.APP_SECRET) throw new Error('APP_SECRET is required');
  const secret = env.APP_SECRET;
  const db = env.DB;
  const store = createStore(env);
  // The packed IV/tag/ciphertext format also matches the original server.
  const key = crypto.subtle
    .digest('SHA-256', encoder.encode(secret))
    .then((hash) => crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']));
  async function encrypt(tokens: Tokens) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const result = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key, encoder.encode(JSON.stringify(tokens))),
    );
    const packed = new Uint8Array(12 + result.length);
    packed.set(iv);
    packed.set(result.subarray(-16), 12);
    packed.set(result.subarray(0, -16), 28);
    return encode(packed);
  }
  async function decrypt(value: string): Promise<Tokens> {
    const packed = decode(value);
    const data = new Uint8Array(packed.length - 12);
    data.set(packed.subarray(28));
    data.set(packed.subarray(12, 28), data.length - 16);
    return JSON.parse(
      decoder.decode(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.subarray(0, 12) }, await key, data),
      ),
    );
  }
  const rowFor = (id: string) => db.prepare('SELECT * FROM users WHERE id=?').bind(id).first<UserRow>();
  async function saveTokens(t: Tokens): Promise<User> {
    const a = jwt(t.access),
      i = jwt(t.idToken);
    const claims = {
      ...(a['https://api.openai.com/auth'] || {}),
      ...(i['https://api.openai.com/auth'] || {}),
    };
    const email =
      i.email ||
      a.email ||
      i['https://api.openai.com/profile']?.email ||
      a['https://api.openai.com/profile']?.email ||
      null;
    const row = await db
      .prepare(
        'INSERT INTO users(id,account_id,email,name,plan,auth_method,tokens) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET email=COALESCE(excluded.email,users.email),name=COALESCE(excluded.name,users.name),plan=COALESCE(excluded.plan,users.plan),tokens=excluded.tokens RETURNING *',
      )
      .bind(
        crypto.randomUUID(),
        t.accountId,
        email,
        i.name || a.name || null,
        claims.chatgpt_plan_type || null,
        'chatgpt',
        await encrypt(t),
      )
      .first<UserRow>();
    if (!row) throw new Error('Could not save credentials');
    return user(row);
  }
  async function getCredentials(userId: string, forceRefresh = false, rejectedAccess?: string) {
    const row = await rowFor(userId);
    if (!row) throw new HTTPException(401, { message: 'Sign in required' });
    if (row.auth_method === 'apikey') {
      if (!env.OPENAI_API_KEY) throw new Error('API key unavailable');
      return { access: env.OPENAI_API_KEY, accountId: null, authMethod: row.auth_method };
    }
    if (!row.tokens) throw new HTTPException(401, { message: 'Sign in again' });
    let t = await decrypt(row.tokens);
    const needsRefresh = (value: Tokens) =>
      value.expires < Date.now() + 300000 ||
      (forceRefresh && (!rejectedAccess ? value.access === t.access : value.access === rejectedAccess));
    if (needsRefresh(t)) {
      const originalAccess = t.access;
      const owner = crypto.randomUUID();
      const deadline = Date.now() + 65000;
      while (true) {
        const locked = await db
          .prepare(
            'INSERT INTO refresh_locks(user_id,owner,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE refresh_locks.expires_at<=? RETURNING owner',
          )
          .bind(userId, owner, Date.now() + 45000, Date.now())
          .first<{ owner: string }>();
        if (locked) {
          try {
            const freshRow = await rowFor(userId);
            if (!freshRow?.tokens) throw new HTTPException(401, { message: 'Sign in again' });
            const fresh = await decrypt(freshRow.tokens);
            // Another isolate may have refreshed while we waited for its lease.
            const force = forceRefresh && fresh.access === (rejectedAccess || originalAccess);
            if (fresh.expires >= Date.now() + 300000 && !force) {
              t = fresh;
            } else {
              const next = await tokenRequest(
                { grant_type: 'refresh_token', refresh_token: fresh.refresh },
                fresh,
              );
              const saved = await db
                .prepare(
                  'UPDATE users SET tokens=? WHERE id=? AND EXISTS (SELECT 1 FROM refresh_locks WHERE user_id=? AND owner=? AND expires_at>?) RETURNING id',
                )
                .bind(await encrypt(next), userId, userId, owner, Date.now())
                .first();
              if (!saved)
                throw new HTTPException(503, { message: 'Credential refresh lease expired; try again' });
              t = next;
            }
          } finally {
            await db
              .prepare('DELETE FROM refresh_locks WHERE user_id=? AND owner=?')
              .bind(userId, owner)
              .run();
          }
          break;
        }
        if (Date.now() >= deadline)
          throw new HTTPException(503, { message: 'Credential refresh busy; try again' });
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    return { access: t.access, accountId: t.accountId, authMethod: row.auth_method };
  }
  async function current(c: Context<Env>): Promise<User | null> {
    const id = await getSignedCookie(c, secret, 'dd_session');
    if (!id) return null;
    const row = await db
      .prepare(
        'SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE sessions.id=? AND sessions.expires_at>?',
      )
      .bind(id, Date.now())
      .first<UserRow>();
    return row ? user(row) : null;
  }
  async function session(c: Context<Env>, u: User) {
    await store.seedRiddlers(u.id);
    const old = await getSignedCookie(c, secret, 'dd_session');
    const id = encode(crypto.getRandomValues(new Uint8Array(32)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const statements = [
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').bind(Date.now()),
      db
        .prepare('INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)')
        .bind(id, u.id, Date.now() + 30 * 86400000),
    ];
    if (old) statements.unshift(db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').bind(old, u.id));
    await db.batch(statements);
    await setSignedCookie(c, 'dd_session', id, secret, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: new URL(c.req.url).protocol === 'https:',
      path: '/',
      maxAge: 30 * 86400,
    });
  }
  const requireUser: MiddlewareHandler<Env> = async (c, next) => {
    const u = await current(c);
    if (!u) return c.json({ error: 'Sign in required' }, 401);
    c.set('user', u);
    await next();
  };
  function registerAuth(app: Hono<Env>) {
    app.get('/api/auth/me', async (c) =>
      c.json({
        user: await current(c),
        methods: { browser: false, device: true, codexImport: false, apiKey: !!env.OPENAI_API_KEY },
      }),
    );
    app.post('/api/auth/chatgpt/start', (c) =>
      c.json({ error: 'Browser sign-in is unavailable on this hosted deployment; use device sign-in.' }, 404),
    );
    app.get('/api/auth/complete', (c) =>
      c.json(
        { error: 'Browser sign-in callbacks are unavailable on this hosted deployment; use device sign-in.' },
        404,
      ),
    );
    app.post('/api/auth/codex-import', (c) =>
      c.json(
        {
          error:
            'Local Codex credential import is unavailable on this hosted deployment; use device sign-in.',
        },
        404,
      ),
    );
    app.post('/api/auth/chatgpt/device', async (c) => {
      await body(c, empty);
      // Opportunistic cleanup avoids a timer in the Worker runtime.
      await db
        .prepare("DELETE FROM devices WHERE json_extract(data,'$.expires')<=? AND lease_until<=?")
        .bind(Date.now(), Date.now())
        .run();
      const res = await fetch(BASE + '/api/accounts/deviceauth/usercode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new HTTPException(502, { message: 'Device sign-in unavailable' });
      const d = z
        .object({
          device_auth_id: z.string().min(1),
          user_code: z.string().min(1),
          interval: z.coerce.number().nonnegative().finite(),
        })
        .parse(await res.json());
      const interval = Math.max(1, d.interval);
      const device: Device = {
        userCode: d.user_code,
        expires: Date.now() + 900000,
        interval,
        next: Date.now() + interval * 1000,
      };
      await db
        .prepare('INSERT INTO devices(id,data) VALUES(?,?)')
        .bind(d.device_auth_id, JSON.stringify(device))
        .run();
      return c.json({
        deviceId: d.device_auth_id,
        userCode: d.user_code,
        verificationUrl: BASE + '/codex/device',
        interval,
      });
    });
    app.post('/api/auth/chatgpt/device/poll', async (c) => {
      const { deviceId } = await body(c, z.object({ deviceId: z.string().min(1).max(2000) }).strict());
      const owner = crypto.randomUUID();
      const now = Date.now();
      const row = await db
        .prepare(
          "UPDATE devices SET lease_owner=?,lease_until=? WHERE id=? AND lease_until<=? AND json_extract(data,'$.expires')>? AND json_extract(data,'$.next')<=? RETURNING data",
        )
        .bind(owner, now + 75000, deviceId, now, now, now)
        .first<{ data: string }>();
      if (!row) {
        const existing = await db
          .prepare('SELECT data FROM devices WHERE id=?')
          .bind(deviceId)
          .first<{ data: string }>();
        if (!existing || (JSON.parse(existing.data) as Device).expires <= now)
          throw new HTTPException(400, { message: 'Device sign-in expired' });
        return c.json({ status: 'pending' });
      }
      const d: Device = JSON.parse(row.data);
      d.next = Date.now() + d.interval * 1000;
      try {
        const res = await fetch(BASE + '/api/accounts/deviceauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_auth_id: deviceId, user_code: d.userCode }),
          signal: AbortSignal.timeout(30000),
        });
        if (res.status === 403 || res.status === 404) return c.json({ status: 'pending' });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string | { code?: string } };
          const code = typeof data.error === 'object' ? data.error?.code : data.error;
          if (code === 'deviceauth_authorization_pending') return c.json({ status: 'pending' });
          if (code === 'slow_down') {
            d.interval += 5;
            d.next = Date.now() + d.interval * 1000;
            return c.json({ status: 'pending' });
          }
          throw new HTTPException(502, { message: 'Device sign-in failed' });
        }
        const data = z
          .object({ authorization_code: z.string(), code_verifier: z.string() })
          .parse(await res.json());
        const tokens = await tokenRequest({
          grant_type: 'authorization_code',
          code: data.authorization_code,
          code_verifier: data.code_verifier,
          redirect_uri: BASE + '/deviceauth/callback',
        });
        const claimed = await db
          .prepare('DELETE FROM devices WHERE id=? AND lease_owner=? AND lease_until>? RETURNING id')
          .bind(deviceId, owner, Date.now())
          .first();
        if (!claimed) throw new HTTPException(400, { message: 'Device sign-in expired; try again' });
        const u = await saveTokens(tokens);
        await session(c, u);
        return c.json({ status: 'ok', user: u });
      } finally {
        await db
          .prepare('UPDATE devices SET data=?,lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?')
          .bind(JSON.stringify(d), deviceId, owner)
          .run();
      }
    });
    app.post('/api/auth/apikey', async (c) => {
      await body(c, empty);
      if (!env.OPENAI_API_KEY) throw new HTTPException(400, { message: 'API key fallback not configured' });
      await db
        .prepare(
          "INSERT OR IGNORE INTO users(id,auth_method,name) VALUES('local-apikey','apikey','Local user')",
        )
        .run();
      const u = user((await rowFor('local-apikey'))!);
      await session(c, u);
      return c.json({ user: u });
    });
    app.post('/api/auth/logout', async (c) => {
      await body(c, empty);
      const id = await getSignedCookie(c, secret, 'dd_session');
      if (id) await db.prepare('DELETE FROM sessions WHERE id=?').bind(id).run();
      deleteCookie(c, 'dd_session', { path: '/' });
      return c.json({ ok: true });
    });
  }
  return { registerAuth, requireUser, getCredentials };
}
