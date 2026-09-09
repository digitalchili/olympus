import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProfileProviders } from '../../client/src/components/ProvidersSettings';
import type { HermesProvider } from '../../shared/provider-settings';
import '../../client/src/styles/globals.css';
let rows: HermesProvider[] = [];
window.fetch = async (input, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  if (!String(input).includes('profile=som')) throw new Error('Wrong profile');
  if (String(input).includes('/defaults')) {
    rows = rows.map(r => ({ ...r, isDefault: true }));
    return new Response(JSON.stringify({ provider: body.provider, model: body.model }), { status: 200 });
  }
  if (body.action === 'discover') return new Response(JSON.stringify({ models: ['fixture-chat', 'fixture-reasoner'] }));
  if (body.action === 'save') {
    if (body.apiKey === 'bad-key') return new Response(JSON.stringify({ error: 'Provider authentication failed. Check the API key.' }), { status: 400 });
    rows = [{ id: 'providers:deepseek', name: body.name, provider: 'custom:deepseek', baseUrl: body.baseUrl, models: body.models,
      revision: 'fixture-revision', connected: true, testedAt: Date.now(), isDefault: false, hasKey: true, editable: true }];
  }
  if (body.action === 'remove') rows = [];
  return new Response(JSON.stringify({ providers: rows }));
};
createRoot(document.getElementById('root')!).render(<main className="mx-auto max-w-4xl p-6"><ProfileProviders profileId="som" profileLabel="Som" /></main>);
