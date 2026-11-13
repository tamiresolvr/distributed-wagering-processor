import { createHash, randomBytes } from 'node:crypto';

/** UUIDv7 (time-ordered) — good index locality for ids. */
export function uuidv7(): string {
  const ts = BigInt(Date.now());
  const r = randomBytes(10);
  const b = Buffer.alloc(16);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | (r[0]! & 0x0f);
  b[7] = r[1]!;
  b[8] = 0x80 | (r[2]! & 0x3f);
  for (let i = 0; i < 7; i++) b[9 + i] = r[3 + i]!;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** JSON with recursively sorted keys; `undefined` members are dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
