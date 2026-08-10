const SECRET_PATTERN = /(api[_-]?key|authorization|token|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const BEARER_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]+/gi;

export function redactOperationalReason(value: unknown): string {
  return String(value ?? 'unknown')
    .replace(BEARER_PATTERN, 'Bearer [redacted]')
    .replace(SECRET_PATTERN, '$1=[redacted]')
    .slice(0, 240);
}

export function operationalLog(event: string, fields: Record<string, unknown>): void {
  const safe: Record<string, unknown> = { event, at: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (/content|message|credential|secret|token|authorization/i.test(key)) continue;
    safe[key] = typeof value === 'string' ? redactOperationalReason(value) : value;
  }
  console.info(JSON.stringify(safe));
}
