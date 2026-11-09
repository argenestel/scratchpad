import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFileSync, accessSync, constants } from 'node:fs';
import type { Hono, Context, MiddlewareHandler } from 'hono';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { config } from './config.js';
import { db } from './db.js';
import type { Env, User } from './types.js';
import { seedRiddlers } from './store.js';
import { body, empty } from './http.js';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann',
  BASE = 'https://auth.openai.com',
  REDIRECT = 'http://localhost:1455/auth/callback';
const key = createHash('sha256').update(config.secret).digest();
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
function encrypt(t: Tokens) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(t), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function decrypt(s: string): Tokens {
  const b = Buffer.from(s, 'base64'),
    d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}
function jwt(s?: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(s!.split('.')[1], 'base64url').toString());
  } catch {
    return {};
  }
}
function user(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, plan: row.plan, authMethod: row.auth_method };
}
function rowFor(id: string) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id) as UserRow | undefined;
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
  const t = tokenSchema.parse(await res.json()),
    id = jwt(t.id_token),
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
function saveTokens(t: Tokens): User {
  const a = jwt(t.access),
    i = jwt(t.idToken),
    claims = { ...(a['https://api.openai.com/auth'] || {}), ...(i['https://api.openai.com/auth'] || {}) };
  const email =
    i.email ||
    a.email ||
    i['https://api.openai.com/profile']?.email ||
    a['https://api.openai.com/profile']?.email ||
    null;
  const name = i.name || a.name || null,
    plan = claims.chatgpt_plan_type || null;
  const prior = db.prepare('SELECT * FROM users WHERE account_id=?').get(t.accountId) as UserRow | undefined;
  const id = prior?.id || randomUUID();
  db.prepare(
    'INSERT INTO users(id,account_id,email,name,plan,auth_method,tokens) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET email=COALESCE(excluded.email,users.email),name=COALESCE(excluded.name,users.name),plan=COALESCE(excluded.plan,users.plan),tokens=excluded.tokens',
  ).run(id, t.accountId, email, name, plan, 'chatgpt', encrypt(t));
  return user(rowFor(id)!);
}
const refreshLocks = new Map<string, Promise<Tokens>>();
export async function getCredentials(userId: string, forceRefresh = false, rejectedAccess?: string) {
  const row = rowFor(userId);
  if (!row) throw new HTTPException(401, { message: 'Sign in required' });
  if (row.auth_method === 'apikey') {
    if (!config.apiKey) throw new Error('API key unavailable');
    return { access: config.apiKey, accountId: null, authMethod: row.auth_method };
  }
  if (!row.tokens) throw new Error('Sign in again');
  let t = decrypt(row.tokens);
  if (t.expires < Date.now() + 300000 || (forceRefresh && (!rejectedAccess || t.access === rejectedAccess))) {
    let pending = refreshLocks.get(userId);
    if (!pending) {
      pending = (async () => {
        const fresh = decrypt(rowFor(userId)!.tokens!);
        const next = await tokenRequest({ grant_type: 'refresh_token', refresh_token: fresh.refresh }, fresh);
        db.prepare('UPDATE users SET tokens=? WHERE id=?').run(encrypt(next), userId);
        return next;
      })();
      refreshLocks.set(userId, pending);
    }
    try {
      t = await pending;
    } finally {
      if (refreshLocks.get(userId) === pending) refreshLocks.delete(userId);
    }
  }
  return { access: t.access, accountId: t.accountId, authMethod: row.auth_method };
}
async function current(c: Context): Promise<User | null> {
  const id = await getSignedCookie(c, config.secret, 'dd_session');
  if (!id) return null;
  const row = db
    .prepare(
      'SELECT users.* FROM users JOIN sessions ON users.id=sessions.user_id WHERE sessions.id=? AND sessions.expires_at>?',
    )
    .get(id, Date.now()) as UserRow | undefined;
  return row ? user(row) : null;
}
async function session(c: Context, u: User) {
  seedRiddlers(u.id);
  const old = await getSignedCookie(c, config.secret, 'dd_session');
  if (old) db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(old, u.id);
  const id = randomBytes(32).toString('base64url');
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(id, u.id, Date.now() + 30 * 86400000);
  await setSignedCookie(c, 'dd_session', id, config.secret, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.appUrl.startsWith('https:'),
    path: '/',
    maxAge: 30 * 86400,
  });
}
export const requireUser: MiddlewareHandler<Env> = async (c, next) => {
  const u = await current(c);
  if (!u) return c.json({ error: 'Sign in required' }, 401);
  c.set('user', u);
  await next();
};
const states = new Map<string, { verifier: string; expires: number }>(),
  tickets = new Map<string, { user: User; expires: number }>();
type Device = { userCode: string; expires: number; interval: number; next: number; busy: boolean };
const devices = new Map<string, Device>();
function cleanup() {
  const now = Date.now();
  for (const [k, v] of states) if (v.expires < now) states.delete(k);
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k);
  for (const [k, v] of devices) if (v.expires < now) devices.delete(k);
}
const cleanupTimer = setInterval(cleanup, 60000);
cleanupTimer.unref();
function canImport() {
  try {
    if (!config.codexAuthFile) return false;
    accessSync(config.codexAuthFile, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
export function registerAuth(app: Hono<Env>) {
  app.get('/api/auth/me', async (c) =>
    c.json({
      user: await current(c),
      methods: { browser: browserOAuthUsable(), device: true, codexImport: canImport(), apiKey: !!config.apiKey },
    }),
  );
  app.post('/api/auth/chatgpt/start', async (c) => {
    await body(c, empty);
    cleanup();
    const verifier = randomBytes(32).toString('base64url'),
      state = randomBytes(32).toString('hex');
    states.set(state, { verifier, expires: Date.now() + 600000 });
    const url = new URL(BASE + '/oauth/authorize');
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT,
      scope: 'openid profile email offline_access',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'pi',
    }).toString();
    return c.json({ url: url.toString() });
  });
  app.get('/api/auth/complete', async (c) => {
    const ticket = z.string().min(20).parse(c.req.query('ticket'));
    const t = tickets.get(ticket);
    tickets.delete(ticket);
    if (!t || t.expires < Date.now())
      throw new HTTPException(400, { message: 'Invalid or expired login ticket' });
    await session(c, t.user);
    return c.redirect('/', 302);
  });
  app.post('/api/auth/chatgpt/device', async (c) => {
    await body(c, empty);
    cleanup();
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
    devices.set(d.device_auth_id, {
      userCode: d.user_code,
      expires: Date.now() + 900000,
      interval,
      next: Date.now() + interval * 1000,
      busy: false,
    });
    return c.json({
      deviceId: d.device_auth_id,
      userCode: d.user_code,
      verificationUrl: BASE + '/codex/device',
      interval,
    });
  });
  app.post('/api/auth/chatgpt/device/poll', async (c) => {
    const { deviceId } = await body(c, z.object({ deviceId: z.string().min(1).max(2000) }).strict());
    const d = devices.get(deviceId);
    if (!d || d.expires < Date.now()) {
      devices.delete(deviceId);
      throw new HTTPException(400, { message: 'Device sign-in expired' });
    }
    if (d.busy || Date.now() < d.next) return c.json({ status: 'pending' });
    d.busy = true;
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
        const data = (await res.json().catch(() => ({}))) as any;
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
      const u = saveTokens(
        await tokenRequest({
          grant_type: 'authorization_code',
          code: data.authorization_code,
          code_verifier: data.code_verifier,
          redirect_uri: BASE + '/deviceauth/callback',
        }),
      );
      devices.delete(deviceId);
      await session(c, u);
      return c.json({ status: 'ok', user: u });
    } finally {
      d.busy = false;
    }
  });
  app.post('/api/auth/codex-import', async (c) => {
    await body(c, empty);
    if (!canImport()) throw new HTTPException(400, { message: 'Codex import not configured or unreadable' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(config.codexAuthFile!, 'utf8'));
    } catch {
      throw new HTTPException(400, { message: 'Cannot read Codex credentials' });
    }
    const { tokens: t } = z
      .object({
        tokens: z.object({
          id_token: z.string().optional(),
          access_token: z.string(),
          refresh_token: z.string(),
          account_id: z.string().optional(),
        }),
      })
      .parse(parsed);
    const claims = jwt(t.access_token),
      i = jwt(t.id_token);
    const accountId =
      t.account_id ||
      claims['https://api.openai.com/auth']?.chatgpt_account_id ||
      i['https://api.openai.com/auth']?.chatgpt_account_id;
    if (!accountId) throw new HTTPException(400, { message: 'Codex account ID missing' });
    let creds: Tokens = {
      access: t.access_token,
      refresh: t.refresh_token,
      idToken: t.id_token,
      expires: (claims.exp || 0) * 1000,
      accountId,
    };
    if (creds.expires < Date.now() + 300000)
      creds = await tokenRequest({ grant_type: 'refresh_token', refresh_token: creds.refresh }, creds);
    const u = saveTokens(creds);
    await session(c, u);
    return c.json({ user: u });
  });
  app.post('/api/auth/apikey', async (c) => {
    await body(c, empty);
    if (!config.apiKey) throw new HTTPException(400, { message: 'API key fallback not configured' });
    db.prepare(
      "INSERT OR IGNORE INTO users(id,auth_method,name) VALUES('local-apikey','apikey','Local user')",
    ).run();
    const u = user(rowFor('local-apikey')!);
    await session(c, u);
    return c.json({ user: u });
  });
  app.post('/api/auth/logout', async (c) => {
    await body(c, empty);
    const id = await getSignedCookie(c, config.secret, 'dd_session');
    if (id) db.prepare('DELETE FROM sessions WHERE id=?').run(id);
    deleteCookie(c, 'dd_session', { path: '/' });
    return c.json({ ok: true });
  });
  app.post('/api/auth/test-session', async (c) => {
    if (config.nodeEnv !== 'test' || process.env.NODE_ENV !== 'test')
      throw new HTTPException(404, { message: 'Not found' });
    const { identity } = await body(
      c,
      z
        .object({
          identity: z
            .string()
            .regex(/^[\w-]{1,80}$/)
            .default('smoke'),
        })
        .strict(),
    );
    const id = 'test-' + identity;
    db.prepare("INSERT OR IGNORE INTO users(id,auth_method,name) VALUES(?,'apikey','Test user')").run(id);
    const u = user(rowFor(id)!);
    await session(c, u);
    return c.json({ user: u });
  });
}
export function startCallbackListener() {
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method !== 'GET' || url.pathname !== '/auth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>Not found</h1>');
        return;
      }
      const state = z.string().min(1).parse(url.searchParams.get('state')),
        pending = states.get(state);
      states.delete(state);
      if (!pending || pending.expires < Date.now() || url.searchParams.has('error'))
        throw new Error('Login expired or denied');
      const code = z.string().min(1).parse(url.searchParams.get('code'));
      const u = saveTokens(
        await tokenRequest({
          grant_type: 'authorization_code',
          code,
          code_verifier: pending.verifier,
          redirect_uri: REDIRECT,
        }),
      );
      const ticket = randomBytes(32).toString('base64url');
      tickets.set(ticket, { user: u, expires: Date.now() + 60000 });
      res.writeHead(302, {
        Location: config.appUrl + '/api/auth/complete?ticket=' + encodeURIComponent(ticket),
      });
      res.end();
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><title>Sign-in failed</title><h1>Sign-in failed</h1><p>Login expired, was denied, or could not be completed. Return to scratchpad and try again.</p>',
      );
    }
  });
  server.listen(config.callbackPort, '0.0.0.0');
  return server;
}

/**
 * ChatGPT browser OAuth redirects to the fixed http://localhost:1455/auth/callback, so it only
 * works when the app itself is opened on localhost. Public deployments (tunnel, VPS) use device code.
 */
function browserOAuthUsable() {
  try {
    const host = new URL(config.appUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch {
    return true;
  }
}
