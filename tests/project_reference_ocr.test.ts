import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'olympus-ocr-tests-'));

// Minimal valid 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==',
  'base64',
);

try {
  const imagePath = join(root, 'screenshot.png');
  await writeFile(imagePath, TINY_PNG);

  const {
    extractReferenceText,
    extractImageWithVision,
    resolveVisionConfig,
  } = await import('../server/project-references/extraction-worker.js');

  // 1. Mock Vision API server
  let visionCalled = false;
  let receivedAuthHeader = '';

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      visionCalled = true;
      receivedAuthHeader = req.headers['authorization'] ?? '';
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: 'Order #9876\nProduct: Special Herb\nTotal: 1,500 THB\nStatus: Paid',
            },
          },
        ],
      }));
      return;
    }
    res.writeHead(404).end();
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const mockBaseUrl = `http://127.0.0.1:${address.port}/v1`;

  // 2. Test Vision Config Resolution from Environment
  process.env.OPENAI_API_KEY = 'test-vision-key-123';
  process.env.OPENAI_BASE_URL = mockBaseUrl;
  const config = resolveVisionConfig();
  assert.ok(config);
  assert.equal(config.apiKey, 'test-vision-key-123');
  assert.equal(config.baseUrl, mockBaseUrl);

  // 3. Test Vision Extraction via Mock Server
  const visionText = await extractImageWithVision(imagePath, config);
  assert.match(visionText, /Order #9876/);
  assert.match(visionText, /Special Herb/);
  assert.equal(visionCalled, true);
  assert.equal(receivedAuthHeader, 'Bearer test-vision-key-123');

  // Verify full extractReferenceText pipeline with Vision primary
  const fullVisionResult = await extractReferenceText({
    path: imagePath,
    extension: '.png',
    mimeType: 'image/png',
  });
  assert.equal(fullVisionResult.warnings.length, 0);
  assert.ok(fullVisionResult.chunks.length >= 1);
  assert.match(fullVisionResult.chunks[0].text, /Order #9876/);

  // 4. Test Local OCR Fallback when Vision is disabled or fails
  const mockOcrScript = join(root, 'mock_ocr.sh');
  await writeFile(mockOcrScript, '#!/bin/sh\necho "Tesseract fallback: Invoice #555 Total $20"\n', { mode: 0o755 });
  process.env.OLYMPUS_PROJECT_REFERENCES_OCR_COMMAND = mockOcrScript;

  // Force local OCR
  process.env.OLYMPUS_DISABLE_VISION_OCR = 'true';
  const fallbackResult = await extractReferenceText({
    path: imagePath,
    extension: '.png',
    mimeType: 'image/png',
  });
  assert.equal(fallbackResult.warnings.length, 0);
  assert.ok(fallbackResult.chunks.length >= 1);
  assert.match(fallbackResult.chunks[0].text, /Tesseract fallback/);

  // 5. Test Graceful Warning when neither is available
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OLYMPUS_VISION_API_KEY;
  // HERMES_HOME may contain usable provider auth on developer/CI hosts, so
  // disable Vision explicitly to keep this "neither available" case deterministic.
  process.env.OLYMPUS_DISABLE_VISION_OCR = 'true';
  process.env.OLYMPUS_PROJECT_REFERENCES_OCR_COMMAND = 'non_existent_binary_xyz_123';

  const noOcrResult = await extractReferenceText({
    path: imagePath,
    extension: '.png',
    mimeType: 'image/png',
  });
  assert.equal(noOcrResult.chunks.length, 0);
  assert.equal(noOcrResult.warnings.length, 1);
  assert.match(noOcrResult.warnings[0], /No Vision API key|failed/i);

  server.close();
} finally {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OLYMPUS_PROJECT_REFERENCES_OCR_COMMAND;
  delete process.env.OLYMPUS_DISABLE_VISION_OCR;
  await rm(root, { recursive: true, force: true });
}

console.log('Project reference OCR tests passed');
process.exit(0);
