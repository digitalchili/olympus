import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Load the real renderer, including its CSS and Markdown sanitization pipeline.
const vite = await createServer({
  configFile: 'client/vite.config.ts',
  server: { middlewareMode: true, hmr: false, watch: null },
});

try {
  const { MarkdownContent } = await vite.ssrLoadModule('/client/src/components/MarkdownContent.tsx');
  const render = (href: string, taskId: string | undefined = 'zip-task') => renderToStaticMarkup(
    createElement(MarkdownContent, { content: `[Download ZIP file](${href})`, taskId }),
  );

  for (const href of [
    '/tmp/workspace/pages.zip',
    'sandbox:/tmp/workspace/pages.zip',
    'file:///tmp/workspace/pages.zip',
    './output/pages.zip',
    'pages.zip',
    '/tmp/workspace/Billing%20Notes%20%E0%B9%84%E0%B8%97%E0%B8%A2.zip',
  ]) {
    const markup = render(href);
    assert.match(markup, /href="\/api\/tasks\/zip-task\/artifacts\/download\?path=/, href);
    assert.match(markup, /\bdownload=""/, href);
    assert.doesNotMatch(markup, /target="_blank"/, href);
    assert.match(markup, /profile=default/, 'downloads retain profile routing');
  }

  const encoded = render('/tmp/workspace/Billing%20Notes%20%E0%B9%84%E0%B8%97%E0%B8%A2.zip');
  assert.doesNotMatch(encoded, /%2520/, 'Markdown URL escaping is decoded once before query encoding');

  for (const href of ['https://example.com/pages.zip', 'mailto:hello@example.com', '//example.com/pages.zip']) {
    const markup = render(href);
    assert.match(markup, /target="_blank"/);
    assert.doesNotMatch(markup, /artifacts\/download|\bdownload=""/);
  }
  assert.doesNotMatch(render('javascript:alert%281%29'), /href="javascript:/i);
  assert.doesNotMatch(render('data:text/html,hello'), /href="data:/i);
  assert.doesNotMatch(render('https://example.com', undefined), /artifacts\/download/);
  assert.doesNotMatch(render('#section'), /artifacts\/download/);
  for (const route of ['/', '/?profile=writer', '/channels', '/studio', '/cron', '/tasks/example', '/projects/example', '/api/files/preview?path=example']) {
    assert.doesNotMatch(render(route), /artifacts\/download/, `preserve app route ${route}`);
  }
  const genericMarkdown = renderToStaticMarkup(createElement(MarkdownContent, {
    content: '[Local link](/tmp/workspace/pages.zip)',
  }));
  assert.doesNotMatch(genericMarkdown, /artifacts\/download/, 'non-chat Markdown has no task download context');

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://olympus.example:8443', search: '?profile=somboon' } },
  });
  try {
    const path = '/opt/data/olympus-dispatch/workspace/outputs/billing-note-august26/Billing-Note-August26-Bangkok-pages.zip';
    for (const href of [path, `https://olympus.example:8443${path}`]) {
      const markup = render(href);
      assert.match(markup, /href="\/api\/tasks\/zip-task\/artifacts\/download\?path=%2Fopt%2Fdata/);
      assert.match(markup, /profile=somboon/);
      assert.doesNotMatch(markup, /target="_blank"/);
    }
    assert.doesNotMatch(render('https://example.com/opt/data/pages.zip'), /artifacts\/download/);
    assert.doesNotMatch(render('https://olympus.example:8443/tasks/another-task'), /artifacts\/download/);
  } finally {
    Reflect.deleteProperty(globalThis, 'window');
  }

  console.log('Markdown download link tests passed');
} finally {
  await vite.close();
}
