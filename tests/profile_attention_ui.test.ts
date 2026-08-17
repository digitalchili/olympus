import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [picker, sidebar, api, profilesRoute] = await Promise.all([
  readFile(new URL('../client/src/components/ProfilePicker.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../client/src/components/Sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../client/src/lib/api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../server/routes/profiles.ts', import.meta.url), 'utf8'),
]);

assert.match(profilesRoute, /router\.get\('\/attention'/);
assert.match(api, /fetchProfileAttention/);
assert.match(sidebar, /attentionByProfile/);
assert.match(sidebar, /visibilitychange/);
assert.match(picker, /Ready for review/);
assert.match(picker, /motion-safe:animate-pulse/);
assert.match(picker, /aria-label=.*ready for review in other profiles/i);
assert.match(picker, /aria-hidden="true"/);
assert.doesNotMatch(picker, /animate-ping/);
assert.match(picker, /bottom-\[calc\(100%\+0\.5rem\)\].*w-full/,
  'the expanded picker must stay inside the horizontally clipped sidebar scroller');
assert.doesNotMatch(picker, /\bw-72\b/,
  'a fixed 18rem popup is clipped by the 14rem sidebar');
assert.match(picker, /className="flex min-w-0 items-center gap-1\.5"/,
  'profile labels must shrink before review counts and selection marks');

console.log('Profile attention UI contracts passed');