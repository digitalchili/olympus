import { useEffect, useState } from 'react';
import type { HermesProvider, ProviderSetupRequest } from '@shared/provider-settings';
import { manageHermesProviders, updateAgentDefaults } from '../lib/api';
import { useProfile } from '../contexts/ProfileContext';

const inputClass = 'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100';
const buttonClass = 'rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900';
const changed = () => window.dispatchEvent(new Event('olympus:models-changed'));

export function ProvidersSettings() {
  const { activeProfileId, activeProfile } = useProfile();
  return <ProfileProviders key={activeProfileId} profileId={activeProfileId} profileLabel={activeProfile?.label ?? activeProfileId} />;
}

export function ProfileProviders({ profileId, profileLabel }: { profileId: string; profileLabel: string }) {
  const [providers, setProviders] = useState<HermesProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<HermesProvider | 'new' | null>(null);
  const [preset, setPreset] = useState('deepseek');
  const [name, setName] = useState('DeepSeek');
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [catalog, setCatalog] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    void manageHermesProviders(profileId, { action: 'list' }).then(result => {
      if (active && 'providers' in result) setProviders(result.providers);
    }).catch(() => { if (active) setError('Could not load providers. Reopen this tab to retry.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [profileId]);

  const open = (row: HermesProvider | 'new') => {
    setEditing(row); setApiKey(''); setError(''); setNotice('');
    setName(row === 'new' ? 'DeepSeek' : row.name);
    setBaseUrl(row === 'new' ? 'https://api.deepseek.com/v1' : row.baseUrl);
    setPreset('deepseek');
    setCatalog(row === 'new' ? [] : row.models);
    setSelected(row === 'new' ? [] : row.models);
  };
  const input = (action: 'discover' | 'save'): ProviderSetupRequest => ({ action, name, baseUrl,
    ...(editing && editing !== 'new' ? { id: editing.id, revision: editing.revision } : {}),
    ...(apiKey ? { apiKey } : {}), models: selected,
  });
  const execute = async (request: ProviderSetupRequest) => {
    setBusy(request.action); setError(''); setNotice('');
    try {
      const result = await manageHermesProviders(profileId, request);
      if ('models' in result) {
        setCatalog(result.models);
        setSelected(current => current.some(m => result.models.includes(m)) ? current.filter(m => result.models.includes(m)) : result.models.slice(0, 1));
        setNotice('Models found. Select the models to test and save.');
      } else {
        setProviders(result.providers); setEditing(null); setApiKey(''); changed();
        setNotice(request.action === 'remove' ? 'Provider disconnected.' : 'Connection tested and saved. Your default model is unchanged.');
      }
    } catch (e) { setError(e instanceof Error ? e.message : 'Provider setup failed. Try again.'); }
    finally { setBusy(''); }
  };
  const chosenDefault = (row: HermesProvider) => row.models.includes(defaults[row.id]) ? defaults[row.id] : row.models[0];
  const useDefault = async (row: HermesProvider) => {
    setBusy('default'); setError(''); setNotice('');
    try {
      await updateAgentDefaults({ provider: row.provider, model: chosenDefault(row) }, profileId);
      const result = await manageHermesProviders(profileId, { action: 'list' });
      if ('providers' in result) setProviders(result.providers);
      changed(); setNotice('Profile default updated for new turns.');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not update the default model.'); }
    finally { setBusy(''); }
  };
  return <div className="max-w-3xl space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-semibold">Providers</h2><p className="mt-1 text-sm text-zinc-500">API connections and models for {profileLabel}.</p></div>
      {!editing && <button className={buttonClass} disabled={loading || !!busy} onClick={() => open('new')}>Add provider</button>}
    </div>
    <p className="text-sm text-zinc-500">Keys stay in this profile’s Hermes secret configuration. Connection tests make small model requests, which may use provider credit.</p>
    {loading && <p role="status">Loading providers…</p>}
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}
    {notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">{notice}</p>}
    {editing && <form className="space-y-4 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800" onSubmit={e => { e.preventDefault(); void execute(input('save')); }}>
      <h3 className="font-semibold">{editing === 'new' ? 'Add provider' : `Edit ${editing.name}`}</h3>
      {editing === 'new' && <label className="block space-y-1 text-sm"><span>Provider type</span><select className={inputClass} value={preset} disabled={!!busy} onChange={e => {
        setPreset(e.target.value); setName(e.target.value === 'deepseek' ? 'DeepSeek' : '');
        setBaseUrl(e.target.value === 'deepseek' ? 'https://api.deepseek.com/v1' : ''); setApiKey(''); setCatalog([]); setSelected([]);
      }}><option value="deepseek">DeepSeek</option><option value="custom">Custom OpenAI-compatible</option></select></label>}
      <label className="block space-y-1 text-sm"><span>Name</span><input required className={inputClass} value={name} readOnly={editing !== 'new'} disabled={!!busy} maxLength={60} onChange={e => setName(e.target.value)} /></label>
      <label className="block space-y-1 text-sm"><span>API base URL</span><input required type="url" className={inputClass} value={baseUrl} disabled={!!busy} placeholder="https://provider.example/v1" onChange={e => { setBaseUrl(e.target.value); setCatalog([]); setSelected([]); }} /></label>
      <label className="block space-y-1 text-sm"><span>API key{editing !== 'new' && editing.hasKey ? ' · saved securely' : ''}</span><input type="password" autoComplete="new-password" className={inputClass} value={apiKey} disabled={!!busy} placeholder={editing !== 'new' && editing.hasKey ? 'Leave blank to keep the saved key' : 'Enter key, or leave blank for a local endpoint'} onChange={e => { setApiKey(e.target.value); setCatalog([]); setSelected([]); }} /></label>
      <button type="button" className="text-sm underline disabled:opacity-40" disabled={!!busy || !baseUrl} onClick={() => void execute(input('discover'))}>{busy === 'discover' ? 'Discovering models…' : 'Discover / refresh models'}</button>
      {catalog.length > 0 && <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Models to test and show in the picker</legend><div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">{catalog.map(model => <label key={model} className="flex items-start gap-2 break-all text-sm"><input type="checkbox" className="mt-1" disabled={!!busy} checked={selected.includes(model)} onChange={e => setSelected(current => e.target.checked ? [...current, model] : current.filter(m => m !== model))} />{model}</label>)}</div></fieldset>}
      <div className="flex items-center gap-4"><button className={buttonClass} disabled={!!busy || !selected.length || !name || !baseUrl}>{busy === 'save' ? 'Testing and saving…' : 'Test and save'}</button><button type="button" disabled={!!busy} className="text-sm underline" onClick={() => { setEditing(null); setApiKey(''); }}>Cancel</button></div>
      <p className="text-xs text-zinc-500">Saving keeps your current default. If this profile is running tasks, let them finish before saving connection changes.</p>
    </form>}
    {!loading && !providers.length && !editing && <p className="rounded-xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-500">No custom API endpoints configured. Add a provider to discover and test its models.</p>}
    {providers.map(row => <section key={row.id} aria-label={row.name} className="space-y-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{row.name}{row.isDefault && <span className="ml-2 text-xs font-normal text-zinc-500">Profile default</span>}</h3><span className={`text-xs ${row.connected ? 'text-emerald-600' : 'text-zinc-500'}`}>{row.connected ? 'Connected' : 'Configured · not tested'}</span></div>
      <p className="break-all text-sm text-zinc-500">{row.baseUrl}</p>
      <p className="break-words text-sm">{row.models.join(', ') || 'No models selected'}</p>
      {row.testedAt && <p className="text-xs text-zinc-500">Tested {new Date(row.testedAt).toLocaleString()}</p>}
      <div className="flex flex-wrap items-center gap-4 text-sm"><button className="underline disabled:opacity-40" disabled={!!busy || !!editing || !row.editable} onClick={() => open(row)}>Edit connection and models</button><button className="underline disabled:opacity-40" disabled={!!busy || !!editing || !row.editable || row.isDefault} onClick={() => void execute({ action: 'remove', id: row.id, revision: row.revision })}>Disconnect</button></div>
      {!row.editable && <p className="text-xs text-zinc-500">This connection has advanced settings that this editor cannot safely change yet.</p>}
      {row.isDefault && <p className="text-xs text-zinc-500">Choose another default in General Settings before disconnecting.</p>}
      {row.connected && row.models.length > 0 && <div className="flex flex-wrap items-center gap-2 pt-2"><select aria-label={`Default model for ${row.name}`} className={`${inputClass} !w-auto max-w-full`} disabled={!!busy} value={chosenDefault(row)} onChange={e => setDefaults(current => ({ ...current, [row.id]: e.target.value }))}>{row.models.map(m => <option key={m}>{m}</option>)}</select><button disabled={!!busy} className="text-sm underline disabled:opacity-40" onClick={() => void useDefault(row)}>Use as profile default</button></div>}
    </section>)}
  </div>;
}
