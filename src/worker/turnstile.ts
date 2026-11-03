export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileOptions {
  secret?: string;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  warn?: (msg: string) => void;
}

export interface TurnstileResult {
  ok: boolean;
  reason?: string;
}

export async function verifyTurnstile(token: string | undefined, remoteIp: string | undefined, opts: TurnstileOptions = {}): Promise<TurnstileResult> {
  const env = opts.env ?? process.env;
  const secret = opts.secret ?? env.TURNSTILE_SECRET;
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  if (env.NODE_ENV === "test") return { ok: true };
  if (!secret) {
    if (env.ALLOW_NO_TURNSTILE === "1") {
      warn("turnstile: TURNSTILE_SECRET unset, bypass allowed by ALLOW_NO_TURNSTILE=1 (dev only)");
      return { ok: true };
    }
    return { ok: false, reason: "turnstile_not_configured" };
  }
  if (!token || typeof token !== "string" || token.length > 2048) return { ok: false, reason: "missing_token" };

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp) body.set("remoteip", remoteIp);
  try {
    const res = await (opts.fetch ?? fetch)(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, reason: "verify_http_error" };
    const data = (await res.json()) as { success?: boolean; "error-codes"?: string[] };
    return data.success ? { ok: true } : { ok: false, reason: data["error-codes"]?.[0] ?? "rejected" };
  } catch {
    return { ok: false, reason: "verify_unreachable" };
  }
}
