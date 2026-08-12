import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';

const [{ skillsRouter }] = await Promise.all([
  import('../server/routes/skills.js'),
]);

const app = express();
app.use(express.json());
app.use('/api/skills', skillsRouter);
const server = createServer(app);

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/skills`;

  const browse = await fetch(`${base}/registry/browse?limit=24`);
  assert.equal(browse.status, 200);
  const { skills } = await browse.json() as { skills: Array<{ slug: string; curated?: { owner: string; status: string } }> };
  assert.equal(skills.length, 13);
  assert.deepEqual(skills.map((skill) => skill.slug), [...skills.map((skill) => skill.slug)].sort());
  assert.ok(skills.every((skill) => skill.curated?.status === 'approved'));
  assert.ok(skills.every((skill) => skill.slug && skill.curated?.owner === 'Digital Chili'));

  const search = await fetch(`${base}/registry/search?q=interface&limit=24`);
  assert.equal(search.status, 200);
  const searchBody = await search.json() as { skills: Array<{ slug: string }> };
  assert.deepEqual(searchBody.skills.map((skill) => skill.slug), ['api-and-interface-design', 'make-interfaces-feel-better']);

  const content = await fetch(`${base}/registry/humanizer/content`);
  assert.equal(content.status, 200);
  assert.match((await content.json() as { content: string }).content, /^---\nname: humanizer\n/);

  const unknown = await fetch(`${base}/registry/not-reviewed/content`);
  assert.equal(unknown.status, 404);

  const unknownScan = await fetch(`${base}/registry/not-reviewed/scan`);
  assert.equal(unknownScan.status, 404);
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log('Digital Chili registry browse tests passed');
