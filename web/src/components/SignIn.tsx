import { useEffect, useRef, useState } from 'react';
import { api, type AuthMethods, type User } from '../api';
import { I, OpenAIMark, Wordmark } from '../ui';

type Device = { deviceId: string; userCode: string; verificationUrl: string; interval: number };

/** A static preview of the product: a note with code and an inline AI thread. */
function Preview() {
  return (
    <div className="preview" aria-hidden>
      <div className="pv-bar"><span /><span /><span /><b>Rate limiter</b></div>
      <div className="pv-body">
        <div className="pv-h">Rate limiter</div>
        <p>Token bucket per API key, stored in Redis. <span className="pv-anchor">Refill is computed lazily on each request.</span></p>
        <pre><code>
          <span className="hljs-keyword">const</span> tokens = Math.<span className="hljs-title">min</span>(CAP, stored + (now - ts) * RATE);{'\n'}
          <span className="hljs-keyword">if</span> (tokens &lt; <span className="hljs-number">1</span>) <span className="hljs-keyword">return</span> <span className="hljs-literal">false</span>;
        </code></pre>
        <div className="pv-pop">
          <div className="pv-steps"><span className="done">✓ Reading</span><span className="done">✓ Thinking</span><span className="now">Writing</span><em>4.2s · gpt-6.1-sol</em></div>
          <p><b>Question</b> · <code>Date.now()</code> is milliseconds. Is <code>RATE</code> per ms or per second? If it's per second, buckets refill 1000× too fast.</p>
        </div>
      </div>
    </div>
  );
}

export function SignIn({ methods, onSignedIn }: { methods: AuthMethods; onSignedIn: (u: User) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(() => new URLSearchParams(location.search).get('auth_error'));
  const [device, setDevice] = useState<Device | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<number>();

  useEffect(() => () => window.clearTimeout(pollRef.current), []);

  // Browser flow: the OAuth callback lands on :1455 and redirects back with a cookie; poll /me meanwhile.
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
  const primaryDevice = !methods.browser;

  return (
    <div className="landing">
      <nav className="landing-nav">
        <Wordmark size={26} />
        <a className="btn ghost sm" href="https://github.com/argenestel/doddled" target="_blank" rel="noreferrer">GitHub</a>
      </nav>

      <main className="landing-main">
        <section className="hero">
          <span className="eyebrow"><I.sparkle size={14} /> AI that reads along</span>
          <h1>Think in notes.<br /><span>Get pushback in the margin.</span></h1>
          <p>A Markdown notebook for engineers. Write design docs, debug logs and study notes. scratchpad asks the question you skipped, explains the tricky line, and diagrams the system, right next to your text.</p>
          <ul className="features">
            <li><I.code size={15} /> Code blocks, to-dos, <kbd>/</kbd> commands</li>
            <li><I.bulb size={15} /> Watch it reason, step by step</li>
            <li><I.draw size={15} /> Mermaid diagrams and sketches</li>
            <li><I.users size={15} /> Reviewers with a point of view</li>
          </ul>
        </section>

        <section className="signin-col">
          <Preview />
          <div className="signin-card">
            <h2>Sign in with your ChatGPT plan</h2>
            <p className="sub">Same sign-in as Codex. No API key, nothing extra to pay.</p>

            {device ? (
              <div className="device-box">
                <div className="device-label">Open the link and enter this code</div>
                <div className="device-code">{device.userCode}</div>
                <div className="device-actions">
                  <button className="btn sm" onClick={() => { navigator.clipboard?.writeText(device.userCode); setCopied(true); }}><I.copy /> {copied ? 'Copied' : 'Copy code'}</button>
                  <a className="btn sm primary" href={device.verificationUrl} target="_blank" rel="noreferrer">Open {new URL(device.verificationUrl).host}</a>
                </div>
                <div className="device-wait"><span className="spinner" /> Waiting for approval… <button className="btn ghost sm" onClick={cancel}>Cancel</button></div>
              </div>
            ) : (
              <div className="stack">
                {methods.browser && (
                  <button className="btn primary" onClick={browser} disabled={!!busy && busy !== 'browser'}>
                    <OpenAIMark /> {busy === 'browser' ? 'Finish in the new tab…' : 'Continue with ChatGPT'}
                    <span className="meta">{busy === 'browser' ? <span className="spinner" /> : 'Browser'}</span>
                  </button>
                )}
                <button className={`btn ${primaryDevice ? 'primary' : ''}`} onClick={startDevice} disabled={!!busy}>
                  {primaryDevice ? <OpenAIMark /> : <I.device />} {primaryDevice ? 'Continue with ChatGPT' : 'Use a device code'}
                  <span className="meta">{primaryDevice ? 'Device code' : 'Remote / headless'}</span>
                </button>
                {methods.codexImport && (
                  <button className="btn" onClick={() => simple('codex')} disabled={!!busy}>
                    <I.terminal /> Use my Codex sign-in <span className="meta">~/.codex/auth.json</span>
                  </button>
                )}
                {methods.apiKey && (
                  <button className="btn" onClick={() => simple('apikey')} disabled={!!busy}>
                    <I.key /> Continue with server API key <span className="meta">Local</span>
                  </button>
                )}
                {busy === 'browser' && <button className="btn ghost sm cancel" onClick={cancel}>Cancel</button>}
              </div>
            )}

            {err && <p className="err">{err}</p>}
            <p className="fine">Tokens are encrypted and stay on this server. Requests run on your plan with reasoning on.</p>
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <span>scratchpad · self-hosted</span>
        <span>Never rewrites your notes</span>
        <span>Speaks up only when it matters</span>
      </footer>
    </div>
  );
}
