import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';

const [{ skillsRouter }] = await Promise.all([
  import('../server/routes/skills.js'),
]);

const app = express();
app.use('/api/skills', skillsRouter);
const server = createServer(app);
const originalFetch = globalThis.fetch;
const CLAWHUB_PUBLIC_API = 'https://wry-manatee-359.convex.site/api/v1';

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const localBaseUrl = `http://127.0.0.1:${address.port}`;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === localBaseUrl) return originalFetch(url, init);

    assert.equal(
      url.origin + url.pathname,
      `${CLAWHUB_PUBLIC_API}/packages`,
      'Browse must use ClawHub’s published public API origin, not the website origin that returns 404.',
    );
    assert.equal(url.searchParams.get('family'), 'skill');
    assert.equal(url.searchParams.get('sort'), 'downloads');
    assert.equal(url.searchParams.get('limit'), '24');

    return new Response(JSON.stringify({
      items: [{
        slug: 'example-skill',
        displayName: 'Example skill',
        summary: 'A regression-test skill',
        latestVersion: { version: '1.0.0' },
        owner: { handle: 'example' },
        stats: { downloads: 42 },
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const response = await originalFetch(`${localBaseUrl}/api/skills/registry/browse?limit=24`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    skills: [{
      slug: 'example-skill',
      ownerHandle: 'example',
      sourceUrl: 'https://clawhub.ai/example/skills/example-skill',
      displayName: 'Example skill',
      summary: 'A regression-test skill',
      version: null,
      latestVersion: '1.0.0',
      updatedAt: null,
      stats: { downloads: 42 },
    }],
  });
} finally {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('ClawHub registry browse tests passed');
