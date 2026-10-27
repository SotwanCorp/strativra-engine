/**
 * Request bodies from chrome.webRequest.onBeforeRequest ("requestBody").
 *
 * Chrome hands over either `raw` (an array of chunks; a chunk holds `bytes` or a `file` path) or
 * `formData` (when it parsed a urlencoded or multipart body itself). Every byte chunk is concatenated
 * in order, file chunks are skipped (never read), and the result is capped at 64 KB of UTF-8, cut on a
 * character boundary. Parsed form data is rebuilt as a urlencoded string, which the engine decoders read.
 * Bodies are only kept for tracking requests (see record.ts `shouldKeepBody`); headers are never read.
 */

export const BODY_CAP = 64 * 1024;

export interface UploadChunk {
  bytes?: ArrayBuffer | ArrayBufferView;
  file?: string;
}

export interface RequestBodyLike {
  raw?: UploadChunk[];
  formData?: Record<string, Array<string | ArrayBuffer>>;
  error?: string;
}

function toBytes(b: ArrayBuffer | ArrayBufferView): Uint8Array {
  return b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

/** All byte chunks, in order, stopping once `limit` bytes are collected. */
export function concatChunks(raw: UploadChunk[], limit: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const c of raw) {
    if (!c || !c.bytes || total >= limit) continue;
    const b = toBytes(c.bytes);
    const take = Math.min(b.byteLength, limit - total);
    parts.push(take === b.byteLength ? b : b.subarray(0, take));
    total += take;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** Longest prefix of `s` whose UTF-8 encoding fits in `maxBytes`. */
export function capUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  if (s.length <= maxBytes / 3 || enc.encode(s).byteLength <= maxBytes) return s;
  let lo = 0;
  let hi = Math.min(s.length, maxBytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(s.slice(0, mid)).byteLength <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let cut = s.slice(0, lo);
  // Never leave half a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/** Body as text, or undefined when Chrome gave nothing readable. */
export function bodyToString(rb: RequestBodyLike | undefined | null, cap = BODY_CAP): string | undefined {
  if (!rb) return undefined;
  if (Array.isArray(rb.raw) && rb.raw.some((c) => c && c.bytes)) {
    // A few spare bytes so a character cut by the byte limit is dropped, not mangled.
    const bytes = concatChunks(rb.raw, cap + 4);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return capUtf8(text.replace(/�$/, ""), cap);
  }
  if (rb.formData && typeof rb.formData === "object") {
    const q = new URLSearchParams();
    for (const [k, values] of Object.entries(rb.formData)) {
      for (const v of Array.isArray(values) ? values : []) q.append(k, typeof v === "string" ? v : "[binary]");
    }
    return capUtf8(q.toString(), cap);
  }
  return undefined;
}
