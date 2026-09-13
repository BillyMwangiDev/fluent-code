const sensitiveKey = /(?:^|[_-])(api[_-]?key|authorization|auth(?:entication)?|cookie|credential|password|secret|token|prompt|environment|env)(?:$|[_-])/i;
const secretValue = /(?:bearer\s+|basic\s+|sk-(?:ant-|proj-|live-|test-)?|or-)[A-Za-z0-9_./=-]{6,}|(?:api[_-]?key|authorization|password|token)\s*[:=]\s*[^\s,;]+/gi;

export type RedactedPayload = Record<string, unknown>;

/**
 * Produces a JSON-safe diagnostic value. This is intentionally conservative: fields named like
 * credentials or prompts disappear entirely, and token-like fragments in otherwise useful text
 * are replaced before a trace can reach disk or an export.
 */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(secretValue, match => `${match.slice(0, Math.min(match.length, 8)).replace(/./g, '•')}[REDACTED]`);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return String(value);
  const source = value as Record<string, unknown>;
  if (source.sensitive === true || source.isSensitive === true) return '[REDACTED]';
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) result[key] = sensitiveKey.test(key) ? '[REDACTED]' : redact(entry);
  return result;
}

export function redactPayload(value: unknown): RedactedPayload {
  const redacted = redact(value);
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted) ? redacted as RedactedPayload : {value: redacted};
}
