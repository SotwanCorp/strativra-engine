import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";

/** HMAC-SHA256 hex of `kind:value`. Used for IPs, emails and domains; raw values are never stored. */
export function hmacHash(secret: string, kind: string, value: string): string {
  return createHmac("sha256", secret).update(`${kind}:${value}`).digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 32-char base64url token from 24 random bytes. */
export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

export function newId(): string {
  return randomBytes(12).toString("base64url");
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

function emailKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("email-transient-key").digest();
}

/**
 * The raw email must survive a worker restart long enough to be handed back to the
 * site in the completion webhook. It is stored AES-256-GCM encrypted, only until the
 * job finishes, then nulled. It is never logged.
 */
export function sealEmail(secret: string, email: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", emailKey(secret), iv);
  const ct = Buffer.concat([c.update(email, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64url");
}

export function openEmail(secret: string, sealed: string | null): string | undefined {
  if (!sealed) return undefined;
  try {
    const b = Buffer.from(sealed, "base64url");
    const d = createDecipheriv("aes-256-gcm", emailKey(secret), b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Approximate registrable domain (no public suffix list dependency). */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "edu", "ac", "or", "ne", "go", "nom"]);
export function registrableDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(h) || h.includes(":")) return h; // IP literal
  const parts = h.split(".");
  if (parts.length <= 2) return h;
  const last = parts[parts.length - 1];
  const second = parts[parts.length - 2];
  if (last.length === 2 && SECOND_LEVEL.has(second)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}
