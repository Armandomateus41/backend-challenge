import { createHash } from 'node:crypto';

/**
 * Canonical JSON: object keys sorted by code point at every depth, `undefined` members omitted,
 * no insignificant whitespace. Two semantically equal payloads produce the same string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError('Canonical JSON does not support non-finite numbers');
      }
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item ?? null)).join(',')}]`;
      }
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
