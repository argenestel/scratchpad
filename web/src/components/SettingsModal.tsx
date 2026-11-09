import { useEffect, useState } from 'react';
import { api, type ModelInfo, type Settings, type Summary } from '../api';
import { I, Modal, toast } from '../ui';

const EFFORT_LABEL: Record<string, string> = { minimal: 'Minimal', low: 'Light', medium: 'Balanced', high: 'Deep', xhigh: 'Deeper', max: 'Max', ultra: 'Ultra' };
const SUMMARIES: { id: Summary; label: string; hint: string }[] = [
  { id: 'concise', label: 'Concise', hint: 'Short notes on what it is weighing' },
  { id: 'detailed', label: 'Detailed', hint: 'Longer reasoning summaries' },
  { id: 'auto', label: 'Auto', hint: 'Let the model decide' },
  { id: 'off', label: 'Hidden', hint: 'Still reasons, but shows no thinking' },
];

export function SettingsModal({ onClose, onChange }: { onClose: () => void; onChange?: (s: Settings) => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [source, setSource] = useState<'live' | 'fallback' | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.settings(), api.models()])
      .then(([s, m]) => { setSettings(s.settings); setModels(m.models); setSource(m.source); })
      .catch((e) => setErr((e as Error).message));
  }, []);

  const save = async (patch: Partial<Settings>) => {
    if (!settings) return;
    setSettings({ ...settings, ...patch });
    setSaving(true);
    try { const r = await api.patchSettings(patch); setSettings(r.settings); onChange?.(r.settings); }
    catch (e) { toast((e as Error).message, 'error'); }
    finally { setSaving(false); }
  };

  const byId = (id: string | null | undefined) => models.find((m) => m.id === id);
  const main = byId(settings?.model);
  const bgModel = byId(settings?.backgroundModel ?? settings?.model);

  return (
    <Modal title="Settings" onClose={onClose}>
      {err && <p className="err">{err}</p>}
      {!settings ? (!err && <div style={{ color: 'var(--text-3)', padding: '12px 0' }}>Loading your models…</div>) : (
        <div className="settings">
          <section>
            <div className="set-head">
              <h4>Model</h4>
              <span className="badge">{source === 'live' ? 'From your ChatGPT plan' : 'Default list'}</span>
              {saving && <span className="saved">Saving…</span>}
            </div>
            <div className="model-list" role="radiogroup" aria-label="Model">
              {models.map((m) => (
                <button key={m.id} role="radio" aria-checked={settings.model === m.id} className={`model-opt ${settings.model === m.id ? 'on' : ''}`}
                  onClick={() => save({ model: m.id, effort: m.efforts.includes(settings.effort) ? settings.effort : m.defaultEffort })}>
                  <span className="m-name">{m.name}{settings.model === m.id && <I.check size={14} />}</span>
                  {m.description && <span className="m-desc">{m.description}</span>}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="set-head"><h4>Thinking</h4><span className="sub">How hard {main?.name ?? 'the model'} thinks before answering</span></div>
            <div className="seg wrap" role="radiogroup" aria-label="Thinking level">
              {(main?.efforts ?? [settings.effort]).map((e) => (
                <button key={e} role="radio" aria-checked={settings.effort === e} className={settings.effort === e ? 'on' : ''} onClick={() => save({ effort: e })}>
                  {EFFORT_LABEL[e] ?? e}{main?.defaultEffort === e && <span className="def"> · default</span>}
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="set-head"><h4>Show thinking</h4><span className="sub">What appears in the margin while it reasons</span></div>
            <div className="opt-grid">
              {SUMMARIES.map((s) => (
                <button key={s.id} className={`opt ${settings.summary === s.id ? 'on' : ''}`} onClick={() => save({ summary: s.id })}>
                  <b>{s.label}</b><span>{s.hint}</span>
                </button>
              ))}
            </div>
          </section>

          <section>
            <div className="set-head"><h4>Read-along agent</h4><span className="sub">Runs in the background in “Thinks with you” mode. A lighter model keeps it quick.</span></div>
            <div className="row2">
              <label className="select">
                <span>Model</span>
                <select value={settings.backgroundModel ?? ''} onChange={(e) => {
                  const id = e.target.value || null; const m = byId(id);
                  save({ backgroundModel: id, backgroundEffort: m && settings.backgroundEffort && !m.efforts.includes(settings.backgroundEffort) ? null : settings.backgroundEffort });
                }}>
                  <option value="">Same as above</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
              <label className="select">
                <span>Thinking</span>
                <select value={settings.backgroundEffort ?? ''} onChange={(e) => save({ backgroundEffort: e.target.value || null })}>
                  <option value="">Same as above</option>
                  {(bgModel?.efforts ?? []).map((e) => <option key={e} value={e}>{EFFORT_LABEL[e] ?? e}</option>)}
                </select>
              </label>
            </div>
          </section>
        </div>
      )}
    </Modal>
  );
}
