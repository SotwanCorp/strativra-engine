/**
 * API key format (CONNECTORS.md 3.2): "strv_live_" + 32 base62 + 6-char base62 CRC32 of the random part.
 *
 * Details the platform must match (the contract leaves them open):
 *  - base62 alphabet "0-9A-Za-z" (digits, then upper case, then lower case)
 *  - CRC32 = IEEE 802.3 (zlib, PHP crc32()) over the 32 ASCII characters of the random part
 *  - the checksum is the CRC as an unsigned integer in base62, big-endian, left-padded with "0" to 6 chars
 *
 * The check runs client-side only to catch typos and truncated pastes. The key itself is never logged.
 */

export const KEY_PREFIX = "strv_live_";
export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const KEY_RE = /^strv_live_([0-9A-Za-z]{32})([0-9A-Za-z]{6})$/;

let table: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** CRC32 (IEEE) of the UTF-8 bytes of `s`, as an unsigned 32-bit integer. */
export function crc32(s: string): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (const b of new TextEncoder().encode(s)) c = t[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Unsigned integer in base62, left-padded with "0" to `width`. */
export function base62(n: number, width: number): string {
  let out = "";
  let x = Math.floor(n);
  do {
    out = BASE62[x % 62] + out;
    x = Math.floor(x / 62);
  } while (x > 0);
  return out.padStart(width, "0");
}

export function keyChecksum(random: string): string {
  return base62(crc32(random), 6);
}

export type KeyCheck = "ok" | "empty" | "format" | "checksum";

export function checkApiKey(input: string): KeyCheck {
  const key = (input ?? "").trim();
  if (!key) return "empty";
  const m = KEY_RE.exec(key);
  if (!m) return "format";
  return keyChecksum(m[1]) === m[2] ? "ok" : "checksum";
}

/** Safe to show in the UI: prefix and last 4 characters only. */
export function maskKey(key: string): string {
  const k = (key ?? "").trim();
  return k.length > 14 ? `${KEY_PREFIX}...${k.slice(-4)}` : "";
}
