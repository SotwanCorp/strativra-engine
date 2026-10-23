import { createHmac } from "node:crypto";

export interface WebhookPayload {
  event: "scan.done" | "scan.failed";
  jobId: string;
  reportId: string;
  url: string;
  /** Raw email, handed back to the site's lead store + mailer. Never logged here. */
  email?: string;
  /** Private report token (only on scan.done). The site emails reportBaseUrl/r/<token>. */
  token?: string;
  reportUrl?: string;
  error?: string;
}

export function signBody(secret: string, timestamp: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface WebhookOptions {
  url?: string;
  secret: string;
  fetch?: typeof fetch;
  retries?: number;
  backoffMs?: number;
  log?: (msg: string) => void;
}

/** POST the signed payload. Headers: X-Strativra-Timestamp, X-Strativra-Signature = sha256=HMAC(secret, `${ts}.${body}`). */
export async function sendWebhook(payload: WebhookPayload, o: WebhookOptions): Promise<boolean> {
  if (!o.url) return false;
  const body = JSON.stringify(payload);
  const retries = o.retries ?? 3;
  for (let i = 0; i < retries; i++) {
    const ts = String(Math.floor(Date.now() / 1000));
    try {
      const res = await (o.fetch ?? fetch)(o.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-strativra-timestamp": ts,
          "x-strativra-signature": signBody(o.secret, ts, body),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
    } catch { /* retry */ }
    if (i < retries - 1) await new Promise((r) => setTimeout(r, (o.backoffMs ?? 2000) * 2 ** i));
  }
  o.log?.(`webhook delivery failed for job ${payload.jobId}`);
  return false;
}
