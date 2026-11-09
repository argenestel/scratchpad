import { useEffect, useRef, useState } from 'react';
import { api, type AuthMethods, type User } from '../api';
import { I, OpenAIMark } from '../ui';

type Device = { deviceId: string; userCode: string; verificationUrl: string; interval: number };

export function SignIn({ methods, onSignedIn }: { methods: AuthMethods; onSignedIn: (u: User) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(() => new URLSearchParams(location.search).get('auth_error'));
  const [device, setDevice] = useState<Device | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number>();

  useEffect(() => () => window.clearTimeout(pollRef.current), []);

  // Browser flow: the OAuth callback lands on :1455 and redirects back here with a cookie.
  // While the popup is out, poll /me so we notice completion without a reload.
  const browser = async () => {
    setErr(null); setBusy('browser');
    try {
      const { url } = await api.startBrowser();
      const w = window.open(url, '_blank', 'noopener');
      if (!w) location.href = url;
      const started = Date.now();
      const tick = async () => {
        try { const r = await api.me(); if (r.user) return onSignedIn(r.user); } catch { /* ignore */ }
        if (Date.now() - started < 10 * 60_000) pollRef.current = window.setTimeout(tick, 2000);
        else setBusy(null);
      };
      pollRef.current = window.setTimeout(tick, 2500);
    } catch (e) { setErr((e as Error).message); setBusy(null); }
  };

  const startDevice = async () => {
    setErr(null); setBusy('device');
    try {
      const d = await api.startDevice();
      setDevice(d);
      const tick = async () => {
        try {
          const r = await api.pollDevice(d.deviceId);
          if (r.status === 'ok') return onSignedIn(r.user);
          pollRef.current = window.setTimeout(tick, Math.max(2, d.interval) * 1000);
        } catch (e) { setErr((e as Error).message); setBusy(null); setDevice(null); }
      };
      pollRef.current = window.setTimeout(tick, Math.max(2, d.interval) * 1000);
    } catch (e) { setErr((e as Error).message); setBusy(null); }
  };

  const simple = async (kind: 'codex' | 'apikey') => {
    setErr(null); setBusy(kind);
    try { const r = kind === 'codex' ? await api.codexImport() : await api.apiKey(); onSignedIn(r.user); }
    catch (e) { setErr((e as Error).message); setBusy(null); }
  };

  const cancel = () => { window.clearTimeout(pollRef.current); setBusy(null); setDevice(null); };

  return (
    <div className="landing">
      <nav className="landing-nav">
        <span className="wordmark">scratchpad<i>.</i></span>
        <a className="btn ghost sm" href="https://github.com/openai/codex" target="_blank" rel="noreferrer">How sign-in works</a>
      </nav>

      <main className="landing-main">
        <section className="hero">
          <h1>A notebook that <em>thinks</em> with you.</h1>
          <p>Write the way you always do. scratchpad reads along, asks the question you skipped, explains the hard part, and sketches it in ink.</p>
          <div className="hero-demo" aria-hidden>
            We should move the queue to Postgres. <mark>It's simpler than running Kafka and we'll never need more than 10k jobs/sec.</mark>
            <div className="ink-note ink">What happens to in-flight jobs when a worker dies holding a row lock? And is "never" a number from somewhere?</div>
          </div>
        </section>

        <section className="signin-card">
          <h2>Start writing</h2>
          <p className="sub">scratchpad runs on your own ChatGPT account, just like Codex. Nothing to pay here and no API key needed.</p>

          {device ? (
            <div className="device-box">
              <div style={{ fontSize: 13.5, color: 'var(--text-2)' }}>Open the link below and enter this code</div>
              <div className="device-code">{device.userCode}</div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(device.userCode); setCopied(true); }}>{copied ? 'Copied' : 'Copy code'}</button>
                <a className="btn sm primary" href={device.verificationUrl} target="_blank" rel="noreferrer">Open {new URL(device.verificationUrl).host}</a>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center', fontSize: 13, color: 'var(--text-3)' }}>
                <span className="pulse" /> Waiting for you to approve…
                <button className="btn ghost sm" onClick={cancel}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <button className="btn primary" onClick={browser} disabled={!!busy && busy !== 'browser'}>
                <OpenAIMark /> {busy === 'browser' ? 'Finish in the new tab…' : 'Sign in with ChatGPT'}
                <span className="meta">{busy === 'browser' ? <span className="pulse" /> : 'Browser'}</span>
              </button>
              <button className="btn" onClick={startDevice} disabled={!!busy}>
                <I.device /> Use a device code <span className="meta">Remote / headless</span>
              </button>
              {methods.codexImport && (
                <button className="btn" onClick={() => simple('codex')} disabled={!!busy}>
                  <I.terminal /> Use my Codex sign-in <span className="meta">~/.codex/auth.json</span>
                </button>
              )}
              {methods.apiKey && (
                <button className="btn" onClick={() => simple('apikey')} disabled={!!busy}>
                  <I.key /> Continue with server API key <span className="meta">Local only</span>
                </button>
              )}
              {busy === 'browser' && <button className="btn ghost sm" style={{ width: 'auto', justifySelf: 'center', height: 30 }} onClick={cancel}>Cancel</button>}
            </div>
          )}

          {err && <p className="err" style={{ marginTop: 14 }}>{err}</p>}
          <p className="fine">
            Uses the same OAuth flow as the Codex CLI. Your tokens are encrypted and stay on this server. Requests go to your ChatGPT plan with reasoning on, so you can watch scratchpad think.
          </p>
        </section>
      </main>

      <footer className="landing-foot">
        <span>scratchpad<i style={{ color: 'var(--ink)', fontStyle: 'normal' }}>.</i> self-hosted</span>
        <span>It won't rewrite your notes.</span>
        <span>It won't give every answer.</span>
        <span>It won't interrupt every thought.</span>
      </footer>
    </div>
  );
}
