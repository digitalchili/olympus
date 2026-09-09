import { useEffect, useState } from 'react';
import { RefreshCw, ExternalLink } from 'lucide-react';
import type { ProviderUsage } from '@shared/provider-usage';
import { fetchProviderUsage } from '../lib/api';
import { useProfile } from '../contexts/ProfileContext';

function resetLabel(resetAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  if (!minutes) return 'Reset due — refresh for the latest allowance';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  return `Resets in ${days ? `${days}d ` : ''}${hours ? `${hours}h ` : ''}${minutes % 60}m`;
}

export function ProviderUsageCard({ usage, now }: { usage: ProviderUsage; now: number }) {
  return <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900" aria-label={usage.label}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-zinc-900 dark:text-zinc-100">{usage.label}</h3>
      <div className="flex items-center gap-2 text-xs text-zinc-500">
        {usage.plan && <span>{usage.plan}</span>}
        {usage.isDefault && <span className="rounded bg-zinc-100 px-2 py-1 dark:bg-zinc-800">Default</span>}
      </div>
    </div>
    {!usage.available && <div className="mt-4 text-sm text-zinc-500 dark:text-zinc-400"><p className="font-medium">Usage unavailable</p><p className="mt-1">{usage.unavailableReason}</p></div>}
    <div className="space-y-5">
      {usage.windows.map((window, index) => <div className="mt-4" key={`${window.label}:${index}`}>
        <div className="mb-2 flex items-center justify-between gap-3 text-sm">
          <span className="text-zinc-600 dark:text-zinc-300">{window.label}</span>
          <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{window.remainingPercent === null ? 'Unavailable' : `${Math.round(window.remainingPercent)}% remaining`}</span>
        </div>
        {window.remainingPercent !== null && <div role="progressbar" aria-label={`${window.label} allowance remaining`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent} className="h-2 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
          <div style={{ width: `${window.remainingPercent}%` }} className={`h-full rounded-full ${window.remainingPercent < 20 ? 'bg-amber-500' : 'bg-emerald-500'}`} />
        </div>}
        {window.resetAt !== null && <p className="mt-2 text-xs text-zinc-500" title={new Date(window.resetAt).toLocaleString()}>{resetLabel(window.resetAt, now)} · {new Date(window.resetAt).toLocaleString()}</p>}
        {window.detail && <p className="mt-1 text-xs text-zinc-500">{window.detail}</p>}
      </div>)}
    </div>
    {usage.details.map((detail, index) => <p key={index} className="mt-3 text-sm text-zinc-600 dark:text-zinc-300">{detail}</p>)}
    <div className="mt-5 flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
      <span>{usage.available ? 'Updated' : 'Checked'} {new Date(usage.fetchedAt).toLocaleTimeString()}</span>
      {usage.dashboardUrl && <a href={usage.dashboardUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">Provider dashboard <ExternalLink size={12} /></a>}
    </div>
  </section>;
}

export function UsageSettings() {
  const { activeProfileId, activeProfile } = useProfile();
  return <ProfileUsage key={activeProfileId} profileId={activeProfileId} profileLabel={activeProfile?.label ?? activeProfileId} />;
}

function ProfileUsage({ profileId, profileLabel }: { profileId: string; profileLabel: string }) {
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let current = true;
    setBusy(true);
    void fetchProviderUsage(profileId, refresh > 0).then(result => {
      if (current) { setProviders(result.providers); setNow(Date.now()); setError(false); }
    }).catch(() => { if (current) setError(true); }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [profileId, refresh]);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === 'visible') setRefresh(value => value + 1);
    }, 60_000);
    return () => clearInterval(timer);
  }, []);
  return <div className="max-w-3xl space-y-5">
    <div className="flex items-start justify-between gap-4">
      <div><h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Usage</h2>
        <p className="mt-1 text-sm text-zinc-500">Provider accounts connected through {profileLabel}.</p></div>
      <button disabled={busy} onClick={() => setRefresh(value => value + 1)} className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300"><RefreshCw size={14} className={busy ? 'animate-spin' : ''} />{busy ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    <p className="text-xs text-zinc-500">Allowances belong to the provider account and may be shared with other apps and profiles. API spending is separate from subscription limits.</p>
    {error && <p role="alert" className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-200">Could not refresh account usage. {providers ? 'Showing the last retrieved figures.' : 'Check this profile’s provider connection and try again.'}</p>}
    {busy && !providers && <p role="status" className="text-sm text-zinc-500">Loading provider usage…</p>}
    {providers?.length === 0 && <p className="text-sm text-zinc-500">No connected providers were found for this profile.</p>}
    {providers?.map(usage => <ProviderUsageCard key={usage.provider} usage={usage} now={now} />)}
  </div>;
}
