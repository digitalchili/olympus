import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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

export async function validateOfficeArchive(path: string): Promise<void> {
  await readZipEntries(path, () => false);
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

async function extractImage(path: string): Promise<ExtractionResult> {
  const command = process.env.OLYMPUS_PROJECT_REFERENCES_OCR_COMMAND?.trim();
  if (!command) return { chunks: [], warnings: ['Local OCR is not configured; no OCR text was fabricated.'] };
  const { stdout } = await execFileAsync(command, [path], { timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return { chunks: chunkText(stdout, { pageNumber: 1 }), warnings: [] };
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
