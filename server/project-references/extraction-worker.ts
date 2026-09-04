import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import yauzl from 'yauzl';

const execFileAsync = promisify(execFile);

export type ExtractedChunkInput = {
  text: string;
  pageNumber?: number | null;
  sheetName?: string | null;
  cellRange?: string | null;
};

export type ExtractionResult = {
  chunks: ExtractedChunkInput[];
  warnings: string[];
};

type Request = { path: string; extension: string; mimeType: string };

const MAX_CHUNK_CHARS = 2_000;
const MAX_ARCHIVE_ENTRIES = 1_000;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

function xmlDecode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkText(text: string, provenance: Omit<ExtractedChunkInput, 'text'> = {}): ExtractedChunkInput[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\0/g, '').trim();
  if (!normalized) return [];
  const chunks: ExtractedChunkInput[] = [];
  for (let offset = 0; offset < normalized.length; offset += MAX_CHUNK_CHARS) {
    chunks.push({ text: normalized.slice(offset, offset + MAX_CHUNK_CHARS), ...provenance });
  }
  return chunks;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('Could not open archive'));
      else resolve(zip);
    });
  });
}

async function readZipEntries(path: string, wanted: (name: string) => boolean): Promise<Map<string, string>> {
  const zip = await openZip(path);
  const result = new Map<string, string>();
  let count = 0;
  let total = 0;
  return await new Promise((resolve, reject) => {
    zip.on('entry', (entry) => {
      count += 1;
      total += entry.uncompressedSize;
      if (count > MAX_ARCHIVE_ENTRIES || total > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        zip.close();
        reject(new Error('Archive exceeds Project reference safety limits'));
        return;
      }
      if (entry.fileName.startsWith('/') || entry.fileName.includes('..') || /\\/.test(entry.fileName)) {
        zip.close();
        reject(new Error('Archive contains unsafe entry names'));
        return;
      }
      if (!wanted(entry.fileName)) {
        zip.readEntry();
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error ?? new Error('Could not read archive entry'));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        stream.on('end', () => {
          result.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
          zip.readEntry();
        });
        stream.on('error', reject);
      });
    });
    zip.on('end', () => resolve(result));
    zip.on('error', reject);
    zip.readEntry();
  });
}

export async function validateOfficeArchive(path: string, extension?: '.docx' | '.xlsx'): Promise<void> {
  const entries = await readZipEntries(path, (name) => (
    name === '[Content_Types].xml'
    || name === 'word/document.xml'
    || name === 'xl/workbook.xml'
    || name.startsWith('xl/worksheets/sheet')
  ));
  if (extension === '.docx' && (!entries.has('[Content_Types].xml') || !entries.has('word/document.xml'))) {
    throw new Error('Project reference DOCX package is missing required entries');
  }
  if (extension === '.xlsx' && (
    !entries.has('[Content_Types].xml')
    || !entries.has('xl/workbook.xml')
    || ![...entries.keys()].some((name) => name.startsWith('xl/worksheets/sheet'))
  )) {
    throw new Error('Project reference XLSX package is missing required entries');
  }
}

async function extractDocx(path: string): Promise<ExtractionResult> {
  const entries = await readZipEntries(path, (name) => name === 'word/document.xml');
  return { chunks: chunkText(xmlDecode(entries.get('word/document.xml') ?? '')), warnings: [] };
}

function columnName(index: number): string {
  let n = index + 1;
  let name = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    name = String.fromCharCode(65 + r) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

async function extractXlsx(path: string): Promise<ExtractionResult> {
  const entries = await readZipEntries(path, (name) => (
    name === 'xl/sharedStrings.xml' || name === 'xl/workbook.xml' || name.startsWith('xl/worksheets/sheet')
  ));
  const shared = [...(entries.get('xl/sharedStrings.xml') ?? '').matchAll(/<si[\s\S]*?<\/si>/g)].map((match) => xmlDecode(match[0]));
  const chunks: ExtractedChunkInput[] = [];
  for (const [name, xml] of entries) {
    if (!name.startsWith('xl/worksheets/sheet')) continue;
    const cells: string[] = [];
    let firstCell: string | null = null;
    let lastCell: string | null = null;
    for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1];
      const body = cell[2];
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? `${columnName(cells.length)}1`;
      const raw = /<v[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
      const value = attrs.includes('t="s"') ? (shared[Number(raw)] ?? '') : xmlDecode(raw);
      if (value) {
        firstCell ??= ref;
        lastCell = ref;
        cells.push(`${ref}: ${value}`);
      }
    }
    chunks.push(...chunkText(cells.join('\n'), {
      sheetName: name.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, ''),
      cellRange: firstCell && lastCell ? `${firstCell}:${lastCell}` : null,
    }));
  }
  return { chunks, warnings: [] };
}

async function extractPdf(path: string): Promise<ExtractionResult> {
  const raw = await readFile(path, 'latin1');
  const parts = [...raw.matchAll(/\(([^()]{2,})\)/g)].map((match) => match[1].replace(/\\([\\()])/g, '$1'));
  return { chunks: chunkText(parts.join(' '), { pageNumber: 1 }), warnings: [] };
}

export interface VisionConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function resolveVisionConfig(): VisionConfig | null {
  const envKey = process.env.OLYMPUS_VISION_API_KEY?.trim()
    || process.env.OPENAI_API_KEY?.trim()
    || process.env.OPENROUTER_API_KEY?.trim();

  let apiKey = envKey || '';
  let baseUrl = process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim() || '';
  let model = process.env.OLYMPUS_VISION_MODEL?.trim() || process.env.OPENAI_VISION_MODEL?.trim() || '';

  if (!apiKey) {
    const hermesHome = process.env.HERMES_HOME?.trim()
      ? resolve(process.env.HERMES_HOME.trim().replace(/^~(?=$|\/|\\)/, homedir()))
      : join(homedir(), '.hermes');

    // 1. Check hermesHome/.env
    const envPath = join(hermesHome, '.env');
    if (existsSync(envPath)) {
      try {
        const envContent = readFileSync(envPath, 'utf8');
        const match = /^OPENAI_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m.exec(envContent)
          || /^OPENROUTER_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m.exec(envContent)
          || /^OLYMPUS_VISION_API_KEY\s*=\s*["']?([^"'\r\n]+)["']?/m.exec(envContent);
        if (match?.[1]) apiKey = match[1].trim();
      } catch {
        // ignore read error
      }
    }

    // 2. Check hermesHome/config.yaml
    if (!apiKey) {
      const configPath = join(hermesHome, 'config.yaml');
      if (existsSync(configPath)) {
        try {
          const parsed = parse(readFileSync(configPath, 'utf8'));
          if (isRecord(parsed)) {
            if (typeof parsed.api_key === 'string' && parsed.api_key.trim()) {
              apiKey = parsed.api_key.trim();
            } else if (isRecord(parsed.model) && typeof parsed.model.api_key === 'string' && parsed.model.api_key.trim()) {
              apiKey = parsed.model.api_key.trim();
            } else if (isRecord(parsed.providers) && isRecord(parsed.providers.openai) && typeof parsed.providers.openai.api_key === 'string') {
              apiKey = parsed.providers.openai.api_key.trim();
            }
            if (!baseUrl && isRecord(parsed.model) && typeof parsed.model.base_url === 'string') {
              baseUrl = parsed.model.base_url.trim();
            }
          }
        } catch {
          // ignore parse error
        }
      }
    }
  }

  if (!apiKey) return null;

  if (!baseUrl) {
    baseUrl = apiKey.startsWith('sk-or-')
      ? 'https://openrouter.ai/api/v1'
      : 'https://api.openai.com/v1';
  }
  baseUrl = baseUrl.replace(/\/+$/, '');

  if (!model) {
    model = apiKey.startsWith('sk-or-')
      ? 'openai/gpt-4o-mini'
      : 'gpt-4o-mini';
  }

  return { apiKey, baseUrl, model };
}

export async function extractImageWithVision(path: string, config: VisionConfig): Promise<string> {
  const buffer = await readFile(path);
  const base64 = buffer.toString('base64');
  const ext = path.toLowerCase();
  const mime = ext.endsWith('.png') ? 'image/png' : ext.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  try {
    const url = `${config.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };
    if (config.baseUrl.includes('openrouter')) {
      headers['HTTP-Referer'] = 'https://github.com/digitalchili/olympus';
      headers['X-Title'] = 'Olympus Dispatch';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Transcribe all visible text, labels, numbers, code, and content from this image exactly as written. Preserve layout, structure, headings, and lists where applicable. Output only the extracted transcription without conversational intro or commentary.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${mime};base64,${base64}`,
                },
              },
            ],
          },
        ],
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 150)}`);
    }

    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? '';
  } finally {
    clearTimeout(timer);
  }
}

export async function extractImageWithLocalOcr(path: string): Promise<string> {
  const configured = process.env.OLYMPUS_PROJECT_REFERENCES_OCR_COMMAND?.trim();
  const command = configured || 'tesseract';
  const args = (!configured || configured === 'tesseract') ? [path, 'stdout'] : [path];
  const { stdout } = await execFileAsync(command, args, {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return stdout.trim();
}

async function extractImage(path: string): Promise<ExtractionResult> {
  const disableVision = process.env.OLYMPUS_DISABLE_VISION_OCR === 'true'
    || process.env.OLYMPUS_OCR_PROVIDER === 'local';

  let visionError: string | null = null;

  if (!disableVision) {
    const visionConfig = resolveVisionConfig();
    if (visionConfig) {
      try {
        const text = await extractImageWithVision(path, visionConfig);
        if (text && !/^no text (found|in this image)/i.test(text)) {
          return { chunks: chunkText(text, { pageNumber: 1 }), warnings: [] };
        }
      } catch (err) {
        visionError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  // Fallback to local OCR (Tesseract or configured command)
  try {
    const text = await extractImageWithLocalOcr(path);
    if (text) {
      return { chunks: chunkText(text, { pageNumber: 1 }), warnings: [] };
    }
    return {
      chunks: [],
      warnings: ['Local OCR executed but detected no text in image.'],
    };
  } catch (ocrErr: unknown) {
    const isEnoent = typeof ocrErr === 'object' && ocrErr !== null && 'code' in ocrErr && (ocrErr as { code?: string }).code === 'ENOENT';
    const warning = visionError
      ? `Vision OCR failed (${visionError}) and local Tesseract is not installed; image saved without text indexing.`
      : isEnoent
        ? 'No Vision API key configured and local Tesseract is not installed; image saved without text indexing.'
        : `OCR extraction failed: ${ocrErr instanceof Error ? ocrErr.message : String(ocrErr)}`;
    return { chunks: [], warnings: [warning] };
  }
}

export async function extractReferenceText(request: Request): Promise<ExtractionResult> {
  switch (request.extension) {
    case '.txt':
    case '.md':
    case '.csv':
      return { chunks: chunkText(await readFile(request.path, 'utf8')), warnings: [] };
    case '.docx':
      return extractDocx(request.path);
    case '.xlsx':
      return extractXlsx(request.path);
    case '.pdf':
      return extractPdf(request.path);
    case '.png':
    case '.jpg':
    case '.jpeg':
      return extractImage(request.path);
    default:
      throw new Error(`Unsupported Project reference extension: ${request.extension}`);
  }
}

async function main() {
  const input = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
  const result = await extractReferenceText(JSON.parse(input) as Request);
  process.stdout.write(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((error) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
