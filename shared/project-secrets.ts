export interface ProjectSecretEntry { name: string; value: string }
export interface ProjectSecretMetadata { name: string; updatedAt: number }
export type ProjectSecretInput = { kind: 'none' } | { kind: 'secrets'; entries: ProjectSecretEntry[] } | { kind: 'invalid'; error: string };

const MAX_INPUT = 64 * 1024;
const MAX_VALUE = 16 * 1024;
const namePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const reserved = /^(?:PATH|HOME|SHELL|ENV|BASH_ENV|CDPATH|IFS|ZDOTDIR|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|GIT_ASKPASS|SSH_ASKPASS|__proto__|constructor|prototype)$|^(?:LD_|DYLD_|HERMES_|OLYMPUS_|GIT_CONFIG)/i;
const setup = /^(?:\/secrets?\b|(?:please\s+)?(?:save|store|remember)\s+(?:(?:this|these|the|my)\s+)?(?:(?:in|as|to|for)\s+)?(?:(?:the|my|this)\s+)?(?:project(?:['’]s)?\s+)?(?:secrets?|(?:api\s+)?keys?|credentials?|passwords?|tokens?)(?:\s*[:\n]|$))/i;
const credential = /\b(?:[A-Za-z0-9_]*_)?(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE_KEY|DATABASE_URL|DB_URL|CONNECTION_STRING)(?:_[A-Za-z0-9_]*)?\s*[:=]|\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s/]+:[^\s@]+@/i;
const badInput = 'Use NAME=value entries to save project secrets. They have not been sent to the agent.';
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function validateProjectSecretEntries(input: unknown): ProjectSecretEntry[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 64) throw new Error('Provide between 1 and 64 project secrets.');
  const names = new Set<string>();
  let size = 0;
  return input.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !namePattern.test(entry.name)) throw new Error('Use valid environment variable names for project secrets.');
    if (reserved.test(entry.name)) throw new Error('That environment variable name is reserved by the runtime.');
    if (names.has(entry.name)) throw new Error('Each secret name must appear only once.');
    names.add(entry.name);
    if (typeof entry.value !== 'string' || !entry.value.length || entry.value.includes('\0') || bytes(entry.value) > MAX_VALUE) throw new Error('Each secret value must be non-empty and at most 16 KB.');
    size += bytes(entry.name) + bytes(entry.value);
    if (size > MAX_INPUT) throw new Error('Save at most 64 KB of project secrets at a time.');
    return { name: entry.name, value: entry.value };
  });
}

/** Parse only the explicitly opened secret form; never inspect ordinary task text. */
export function parseProjectSecretInput(input: string): ProjectSecretInput {
  let text = input.trim();
  const explicit = setup.test(text);
  const dotenv = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text.replace(/^```(?:env|dotenv)?\s*\n/, '').replace(/^(?:\s*#[^\n]*\n)+/, '').trim());
  if (!explicit && !dotenv && !credential.test(text)) return { kind: 'none' };
  if (bytes(text) > MAX_INPUT) return { kind: 'invalid', error: 'Save at most 64 KB of project secrets at a time.' };
  if (explicit) {
    if (/^\/secrets?\b/i.test(text)) text = text.replace(/^\/secrets?\b\s*:?[ \t]*/i, '').trim();
    else {
      const end = text.search(/[:\n]/);
      if (end === -1) return { kind: 'invalid', error: badInput };
      text = text.slice(end + 1).trim();
    }
  }
  if (text.startsWith('```')) {
    const fence = /^```(?:env|dotenv)?[ \t]*\n([\s\S]*?)\n```$/.exec(text);
    if (!fence) return { kind: 'invalid', error: badInput };
    text = fence[1];
  }
  const entries: ProjectSecretEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) return { kind: 'invalid', error: badInput };
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const parts: string[] = [];
      let part = value.slice(1);
      let valueBytes = 0;
      let closed = false;
      for (;;) {
        let end = -1;
        for (let i = 0; i < part.length; i++) {
          if (part[i] === '\\' && quote === '"') { i++; continue; }
          if (part[i] === quote) { end = i; break; }
        }
        if (end !== -1) {
          if (!/^\s*(?:#.*)?$/.test(part.slice(end + 1))) return { kind: 'invalid', error: badInput };
          parts.push(part.slice(0, end)); closed = true; break;
        }
        parts.push(part);
        valueBytes += bytes(part) + 1;
        if (valueBytes > MAX_VALUE) return { kind: 'invalid', error: 'Each secret value must be non-empty and at most 16 KB.' };
        if (index + 1 === lines.length) break;
        part = lines[++index];
      }
      if (!closed) return { kind: 'invalid', error: badInput };
      value = parts.join('\n');
      if (quote === '"') value = value.replace(/\\([nr"\\])/g, (_, char: string) => ({ n: '\n', r: '\r', '"': '"', '\\': '\\' })[char]!);
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
      if (/\s/.test(value)) return { kind: 'invalid', error: badInput };
    }
    entries.push({ name: match[1], value });
  }
  try { return { kind: 'secrets', entries: validateProjectSecretEntries(entries) }; }
  catch (error) { return { kind: 'invalid', error: (error as Error).message }; }
}
