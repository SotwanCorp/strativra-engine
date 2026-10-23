export interface WorkerConfig {
  port: number;
  host: string;
  dataDir: string;
  secret: string;
  webhookSecret: string;
  webhookUrl?: string;
  siteOrigin?: string;
  reportBaseUrl: string;
  region: string;
  concurrency: number;
  jobTimeoutMs: number;
  retentionDays: number;
  trustProxy: boolean;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const secret = env.SECRET ?? "";
  if (secret.length < 16 && env.NODE_ENV !== "test") throw new Error("SECRET env var is required (16+ chars, used to HMAC IPs and emails)");
  const port = Number(env.PORT ?? 8787);
  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? "./data",
    secret,
    webhookSecret: env.WEBHOOK_SECRET ?? secret,
    webhookUrl: env.SITE_WEBHOOK_URL || undefined,
    siteOrigin: env.SITE_ORIGIN || undefined,
    reportBaseUrl: (env.REPORT_BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ""),
    region: env.REGION_LABEL ?? "EU (Germany)",
    concurrency: Math.max(1, Number(env.CONCURRENCY ?? 2)),
    jobTimeoutMs: Number(env.JOB_TIMEOUT_MS ?? 240_000),
    retentionDays: Number(env.RETENTION_DAYS ?? 90),
    trustProxy: env.TRUST_PROXY === "1",
  };
}
