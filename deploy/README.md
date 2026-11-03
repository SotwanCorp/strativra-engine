# Deploying the scan worker

One EU Hetzner VPS (CX22 or bigger, Ubuntu 24.04) running Docker. SQLite queue, concurrency 2, R2 for reports.

## Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `SECRET` | yes | none | 16+ chars. HMAC key for IP, email and domain hashes; also derives the key that encrypts the transient email. Changing it resets rate limits. |
| `WEBHOOK_SECRET` | no | `SECRET` | Signs the job-complete webhook. Share with the site. |
| `SITE_WEBHOOK_URL` | yes in prod | none | Site endpoint that receives `scan.done` / `scan.failed` (carries the raw email and the report token). |
| `SITE_ORIGIN` | yes in prod | none | The only CORS origin allowed, e.g. `https://strativra.com`. |
| `REPORT_BASE_URL` | yes in prod | `http://127.0.0.1:PORT` | Public base of the worker, used to build `reportUrl` (`/r/<token>`). |
| `TURNSTILE_SECRET` | yes in prod | none | Cloudflare Turnstile secret. |
| `ALLOW_NO_TURNSTILE` | no | unset | `1` allows running with no `TURNSTILE_SECRET` (dev only, logs a warning). |
| `ENGINE_API_KEY` | yes in prod | none | Bearer key the site and platform send to `/scans`, `/captures` and `/reports`. With no key, `/captures` and `DELETE /reports/{id}` answer 401 (they have no Turnstile to fall back on), and `/scans` refuses `source`, `trigger`, `accountRef` and `siteRef`. |
| `DATA_DIR` | no | `./data` (`/data` in Docker) | SQLite file `worker.sqlite` and the local store. |
| `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | no | none | All four set: reports go to R2. Otherwise local disk under `DATA_DIR/store`. |
| `CHROMIUM_PATH` | yes | set in image | Chromium for `playwright-core`. |
| `PORT`, `HOST` | no | `8787`, `0.0.0.0` | Listen address. |
| `CONCURRENCY` | no | `2` | Parallel scans. |
| `REGION_LABEL` | no | `EU (Germany)` | Printed in reports. |
| `JOB_TIMEOUT_MS` | no | `240000` | Per-scan hard timeout. |
| `RETENTION_DAYS` | no | `90` | Report lifetime and cleanup horizon. |
| `LIMIT_IP_PER_HOUR`, `LIMIT_EMAIL_PER_DAY`, `LIMIT_DOMAIN_PER_DAY`, `MAX_QUEUE_DEPTH` | no | `5`, `3`, `3`, `50` | Rate limits (429 + `Retry-After`). |
| `TRUST_PROXY` | no | unset | `1` reads the client IP from `X-Forwarded-For`. Only enable behind a proxy that overwrites it. |
| `NODE_ENV` | no | `production` | `test` bypasses Turnstile. Never set in prod. |

## API (all with `Authorization: Bearer $ENGINE_API_KEY`)

Contract: `CONNECTORS.md` section 5 in `SotwanCorp/strativra`; details and decisions in `SPEC.md` section 10.

| Call | Notes |
|---|---|
| `POST /scans` | `{url, email?, turnstileToken?, source?, trigger?, accountRef?, siteRef?, ai?}`. `source`: `website` (default), `account`, `api`, `wordpress`, `extension`. `trigger`: `manual` (default), `change_event`, `schedule`, `upload`. Refs: 1 to 64 chars of `A-Za-z0-9_-`. `ai`: boolean, default true; `false` skips AI enrichment. `email` is required for `website`, optional for the other sources. 202 `{jobId}`. Errors: `{error}` 400 `invalid_url|invalid_email|invalid_source|invalid_trigger|invalid_account_ref|invalid_site_ref|invalid_ai`, 429, 403. |
| `POST /captures` | Chrome extension upload, through the platform. `Content-Type: application/json`, optional `Content-Encoding: gzip`. Body `{capture, guidedSteps, consentMarkerTs, source:"extension", trigger:"upload", accountRef, siteRef, ai}`. Caps: 2 MB as sent, 10 MB unzipped, 5,000 requests, 64 KB per body. The engine validates and re-redacts, then builds the report with no browsing and no request to the recorded site. 202 `{jobId}`. Errors are `application/problem+json` (`code`): 400 `invalid_gzip|invalid_json|invalid_capture`, 413 `payload_too_large`, 415, 429 `rate_limited`, 401. |
| `GET /scans/{jobId}` | `{id, status, position, error?}` for scans and captures. |
| `DELETE /reports/{reportId}` | Erasure. `reportId` is the id from the webhook. Deletes html, json, pdf, assets and the DB rows; 204 even when nothing exists; 500 `storage_error` means retry. |

Rate limits (`LIMIT_*`) apply to `/scans`. `/captures` only obeys `MAX_QUEUE_DEPTH`. Platform quotas are the platform's job. The SQLite file migrates itself on start (new job columns `kind`, `source`, `trigger_kind`, `account_ref`, `site_ref`, `ai`, `input_gz`, and `reports.assets`); no manual step. An uploaded capture is held gzipped in the job row only until the job ends.

## Webhook contract

`POST SITE_WEBHOOK_URL`, JSON body:

```
{event: "scan.done"|"scan.failed", jobId, reportId, url, source, trigger, accountRef?, siteRef?, ai,
 email?, token?, reportUrl?, error?, summary?}
```

- `source`, `trigger`, `accountRef`, `siteRef` and `ai` echo what the job was created with (old jobs: `website`, `manual`, `true`). `accountRef` and `siteRef` are absent when not sent.
- `summary` (only on `scan.done`): `{counts: {critical, high, medium, low}, top: [{id, title, severity}] (the first 3 open findings), conversions: [{type, status}], aborted?: {reason, detail}}`.
- `email` is absent for jobs without one (API, account and extension sources); `token` and `reportUrl` only on `scan.done`.

Headers: `X-Strativra-Timestamp` (unix seconds) and `X-Strativra-Signature: sha256=HMAC_SHA256(WEBHOOK_SECRET, "<timestamp>.<raw body>")`. The site must verify the signature, reject timestamps older than 5 minutes, send the email when there is one, and store the lead via `submitLead()` for `website` scans. Three attempts with backoff. A job erased with `DELETE /reports/{id}` while it runs sends no webhook.

## Hetzner setup

1. Create the server (EU location), add your SSH key, disable password login.
2. `apt update && apt install -y docker.io docker-compose-v2 ufw caddy`.
3. Clone the repo, create `.env` (chmod 600) from the table above.
4. Apply the egress firewall below, then `docker compose up -d --build`.
5. Caddy as the TLS front: `worker.strativra.com { reverse_proxy 127.0.0.1:8787 }`. Caddy sets `X-Forwarded-For`, so keep `TRUST_PROXY=1`.
6. Check `curl https://worker.strativra.com/healthz`.

### Egress firewall (SSRF defence in depth)

The app checks every request and redirect, but the container must also be unable to reach private networks or cloud metadata. Docker user traffic is filtered in the `DOCKER-USER` chain, which `ufw` does not manage:

```bash
# Drop container traffic to private ranges, link-local and metadata. Insert before Docker's own rules.
for net in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 ::1/128 fc00::/7 fe80::/10; do
  case "$net" in *:*) ipt=ip6tables ;; *) ipt=iptables ;; esac
  # Allow the container network itself (compose bridge) to talk to its own gateway for DNS, if needed.
  $ipt -I DOCKER-USER -s 172.16.0.0/12 -d "$net" -j DROP 2>/dev/null || true
done
# Keep replies to inbound connections working (published ports):
iptables -I DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Explicitly block the metadata endpoint
iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
```

Notes: the rule for `172.16.0.0/12` as a destination also blocks container-to-container traffic on the default bridge, which is fine for the worker alone; if you add the site container on the same network, allow its subnet first. Persist with `apt install iptables-persistent && netfilter-persistent save`. Verify from inside the container: `docker compose exec worker node -e "fetch('http://169.254.169.254/').catch(e=>console.log('blocked',e.cause?.code))"`.
Host `ufw`: `ufw default deny incoming; ufw allow OpenSSH; ufw allow 80,443/tcp; ufw enable`. Also block Hetzner's private network if used (10.0.0.0/8 is covered above). DNS: use public resolvers (1.1.1.1) in `/etc/docker/daemon.json` so the DNS rule above does not break name resolution.

Chromium sandbox: running non-root in Docker needs either Docker's default seccomp profile plus `--ipc=host` (set in compose), or Playwright's recommended seccomp profile (`security_opt: seccomp=seccomp_profile.json`). The browser module decides whether to pass `--no-sandbox`.

## Cloudflare R2

1. Create bucket `strativra-reports` (EU jurisdiction if the plan allows). Keep it private; reports are only served through the worker.
2. API token: Object Read & Write, scoped to this bucket. Put the keys in `.env` as `R2_*`; endpoint is `https://<account_id>.r2.cloudflarestorage.com`.
3. Lifecycle rule (dashboard: bucket, Settings, Object lifecycle rules): prefix empty, **delete objects 90 days after creation**. This is the authoritative expiry for R2; the worker's daily job deletes the DB rows (and local files in local mode).
4. Turnstile: create a widget for `strativra.com`; the site key goes in the site, the secret in `TURNSTILE_SECRET`.

## Retention and cleanup

Reports expire 90 days after completion, or earlier through `DELETE /reports/{reportId}` (right to erasure). A daily job (and one at startup) deletes expired `reports` rows, jobs older than the retention window, and stale rate-limit hits, and in local mode removes report and asset files. Unknown or expired tokens return the same 404 as invalid ones.

## Backups of the SQLite file

The DB (`/data/worker.sqlite`, WAL mode) holds hashes, job state and report token hashes, no raw IPs or emails. Back it up nightly with a consistent copy, never `cp` of a live file:

```bash
docker compose exec -T worker node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/worker.sqlite');d.exec(\"VACUUM INTO '/data/backup.sqlite'\")"
docker compose cp worker:/data/backup.sqlite - | gzip > /backups/worker-$(date +%F).sqlite.gz
```

Ship `/backups` to a second location (an R2 bucket with a 30-day lifecycle, or Hetzner Storage Box). Losing the DB loses report links (tokens) and rate-limit memory, not the scanned data in R2. Remove `VACUUM INTO` target before running again (``rm -f` first).

## Node and SQLite

`node:sqlite` needs no flag on Node 22.13+ (prints an ExperimentalWarning, silenced in the image CMD). Running TypeScript directly needs `--experimental-strip-types` on Node < 22.18; the image CMD always passes it. On Node 22.5 to 22.12 add `--experimental-sqlite`.
