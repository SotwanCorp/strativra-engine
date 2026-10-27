# SPEC.md: Tracking Audit Engine spec

Spec agreed with the owner on 2026-10-23. Decisions are also in the `CONTEXT.md` log. This repo (`SotwanCorp/strativra-engine`) is the engine. The marketing site is WordPress (strativra.com); `SotwanCorp/strativra` holds the business docs, copy and the decisions log (`CONTEXT.md`). The instant raw-HTML scanner lives here in `src/core/instant/`.

## 1. What it is

A tool that shows a business **why its tracking is not working and what its current setup is**. The free tier diagnoses. The paid Tracking Audit goes deeper and says how to fix everything.

- **Free (self-serve on `/scan`):** outside-in only. A headless browser behaves like a visitor and records every tag, cookie and network hit.
- **Paid (the Tracking Audit):** outside-in, plus read-only account access, a config audit and a 30-day cross-system reconciliation that puts a size on the leak.
- **Unlock:** the CTA on locked content is "Book the Tracking Audit" (the CTA labels table in `SotwanCorp/strativra` `CLAUDE.md`), then a scoping call, a fixed quote and an invoice. No prices on the report or the site.

The engine is **conversion-agnostic**. It audits every way a business converts. No single tool is the focus.

## 2. Conversion model: types + adapters

Each **conversion type** has an expected *event contract*, which is what correct tracking looks like:

| Type | Examples | Contract (what must happen) |
|---|---|---|
| Purchase | cart, checkout, hosted checkout, subscription | funnel events (view_item, add_to_cart, begin_checkout, purchase), value + currency + transaction_id, Ads conversion with value, Meta Purchase with event_id |
| Lead | contact form, quote request, multi-step form | form_start / generate_lead once per real submit, Ads conversion (enhanced conversions where used), Meta Lead with event_id |
| Booking | embedded or linked scheduler | booking confirmed creates exactly one conversion, attributed to the original session |
| Sign-up | account, trial, newsletter | sign_up / equivalent, fired once, after success only |
| Contact click | tel:, mailto:, WhatsApp, chat open | click event per channel, optional Ads conversion |
| Download / other micro | brochure, file | file_download or custom event |

Cross-cutting checks apply to every type: consent gating, double firing, the order of fires vs consent, cross-domain and payment/booking referral exclusions, dedup between browser and server events, and SPA route changes.

**Adapters** (Shopify, WooCommerce, Stripe Checkout, Calendly, HubSpot, Typeform, Webflow/Framer forms, and so on) only help *detect and interpret* a conversion point (iframes, redirects, known success URLs). A site on an unknown platform is still audited against the generic contract.

## 3. Free scan (hosted, outside-in)

Runs on a hosted worker. No interaction with real data:

1. **Discover:** crawl about 5 key pages, detect the stack (GTM, gtag, GA4 IDs, Ads, Meta, other pixels, sGTM endpoints, consent platform) and every conversion point (forms, checkout, schedulers, sign-up, tel/mailto/WhatsApp/chat).
2. **Consent scenarios:** no choice / accept / reject. Record what fires and which cookies are set in each, and check Consent Mode v2 signals.
3. **Walk each conversion path up to, but never including, the final submit or payment.** Check the steps before it are tracked and a conversion tag or listener is ready.
4. **SPA:** route changes produce one page_view each.
5. **Report:** the setup map + every finding (title, severity, why it matters). The **top 3 findings are fully open** (evidence + fix). The rest are blurred, with a count.

Never submits forms, never pays, never creates accounts on a prospect's site. Keeps the existing scanner's SSRF guards and rate limits.

## 4. Paid audit (local CLI, owner-run)

Same core plus credentials, which stay on the owner's machine:

- Read-only API pulls: GTM container export, GA4 Admin config, Google Ads conversion actions, Meta pixel / CAPI diagnostics, plus CRM / booking / store exports where relevant.
- Real test conversions, agreed with the client (the "test booking or form submission we're allowed to make").
- **Reconciliation:** 30 days of conversions compared across the source of truth (orders, CRM leads, bookings) vs GA4 vs Ads vs Meta, to put a size on the gap per conversion type. Uses only the client's own data, never invented benchmarks.
- The owner reviews and signs off every finding before the client sees it (senior-led).

## 5. Deliverable

A **private web report** (unguessable URL, Signal Mono, per `DESIGN.md`) plus a **PDF export**.

- **Free report:** setup map, findings list with severities, top 3 in full, locked rest, and "Book the Tracking Audit".
- **Paid report** (matches `site-copy/06-audit.md` "What you get"):
  1. A plain-English summary to forward
  2. Setup map (as found) and conversion contract status per type
  3. Reconciliation: the gap per conversion type and system
  4. Prioritized fix list (impact x effort)
  5. Evidence per finding: screenshot, recording, network/dataLayer log
  6. Technical appendix for the developer
  7. Walkthrough call + optional fixed quote for the fixes

## 6. Architecture: one core, two runners

```
engine repo
  core/        check catalogue, conversion contracts, adapters, journeys, report model
  worker/      hosted runner (Docker + Playwright) for free scans, called by the WordPress site (server to server)
  cli/         local runner for paid audits (credentials never leave the machine)
  report/      web report + PDF renderer
```

- The check catalogue grows from the instant scanner `src/core/instant/scan.ts` (raw-HTML checks stay as the first layer).
- The worker needs a container host (Fly, Railway or a VPS), not serverless.

## 7. Gate, storage, privacy

- **Email gate:** the setup map + issue count show instantly. The top 3 + list arrive by private link sent by email. The email goes to `submitLead()`.
- **Retention:** free reports (JSON + screenshots) are deleted after **90 days**. Anonymised check stats are kept for a quarterly Tracking Report. The privacy page must say this before launch.
- Never push PII to the dataLayer. Never store a prospect's visitor data, only what our own browser saw.

## 8. Benchmark (2026-10-23): what changed

Five benchmark agents reported (capture, conversion detection, report UX, hosting, current scanner inventory). Several Google/Meta doc pages were unreachable from the sandbox, so contracts and gcd letters must be re-verified against live docs before launch.

**Applied**
- Capture: a fresh browser context per consent scenario (none / accept / reject), every request recorded with scenario + timestamp. GA4 batched POST bodies parsed line by line. `addInitScript` wraps `dataLayer.push` with timestamps; `google_tag_data.ics` read for live consent state. Network hits are the ground truth, not the dataLayer.
- Consent Mode: decode `gcs` (G1xy) and `gcd` (four slots: ad_storage, analytics_storage, ad_user_data, ad_personalization; letters p q r t u v n l). Google does not publish the gcd letter map, so show the raw value and mark unknown letters as unknown.
- Banners: DuckDuckGo `autoconsent` (MPL-2.0, used unmodified) first, a conservative multilingual text-match fallback second. "No banner", "banner not clickable" and "blocked by bot protection" are separate outcomes, never a pass. No stealth plugins.
- Run from an EU egress IP and print the region in the report.
- Purchase pass bar: `transaction_id` + `currency` + `value` + `items`. Lead: `generate_lead` (value + currency) on a real success, not on click. Dedup: Meta `eventID` present on browser events; `transaction_id` unique across a thank-you reload.
- Forms classified by scored signals (login, search, newsletter, contact/lead, checkout).
- Safety: never type an email or phone on a live site, never click submit / pay / place order / subscribe; block non-tracking POSTs and payment endpoints at the network layer with `context.route`. SSRF checks re-run on every request and redirect, plus container egress firewall rules.
- v1 adapters: WordPress (CF7, Gravity, WPForms, Elementor) + WooCommerce, Shopify, embedded schedulers and forms, Webflow, Framer, generic SPA (Lovable, Bolt), Stripe hosted checkout. Wix and Squarespace in wave 2.
- Report: 4 severities (Critical, High, Medium, Low), orange only for Critical, no composite score (counts per severity + status per conversion type). Top 3 = Impact (1-5) x Confidence (1-3) x Reach (1-3), tie-break on lowest effort, with a one-line "why". An unreproduced finding never enters the open top 3. Locked findings show their real title and severity; no fake blurred text.
- Private links: 32-char CSPRNG token, only its hash stored, `noindex`, `no-referrer`, `no-store`, no third-party scripts on the report.
- PDF: Playwright `page.pdf` with `printBackground`, `preferCSSPageSize`, `break-inside: avoid`, fonts ready, motion off.
- Setup map as an inline SVG flow (site -> tags -> destinations -> source of truth) with numbered pins to findings. Reconciliation as paired bars + gap %.
- Hosting: one EU Hetzner VPS with Docker (site + worker containers), SQLite queue (concurrency 2), R2 with a 90-day lifecycle rule, Turnstile + limits per IP, email and domain. Fly.io is the fallback.

**Skipped**: composite scores and letter grades, stealth/fingerprint spoofing, test submits on live sites, claiming sGTM or CAPI certainty from outside (we only see the browser half), serverless hosting, Redis.

**Pending owner calls**: the report-UX benchmark advises against an email wall before the report (show it, ask for the email for the PDF or a copy). The owner chose the email gate; it stays unless the owner changes it.

## 9. AI layer (decided 2026-10-23)

Goal: an auditor unlike anything on the market. The deterministic engine (capture, decode, rules) stays the base; AI sits on top.

**Who does what**
- **Jev (TypeSafe AI, "System One" model)** makes typed, calibrated decisions: Noul (yes/no probability), Choice (one of a set + distribution), Score (rubric level). Used for: is this hit a real conversion, which conversion type is this form or path, how severe is this finding, which business model is this site. Every answer carries a confidence.
- **Claude (Anthropic)** acts: explores sites like an analyst (paid only, step budget, never-submit/never-pay guards still enforced by the runner), writes the report text, generates the fix pack, answers "Ask your audit".

**Escalation ladder** for any judgment: rules engine -> Jev -> (below threshold) Claude reasons over the evidence -> (still uncertain, paid) the owner's review queue. On free reports an unresolved item shows as "Needs a closer look", which points to the paid audit.

**Evidence-locked AI**: every AI sentence or verdict must cite captured evidence ids (hit, dataLayer push, screenshot, cookie). The validator rejects any output that does not; nothing un-cited reaches a client.

**Unique features**
1. **Inferred tracking plan** (free): AI infers the business model and what the site should track (conversions + expected events), each marked tracked / partial / missing. AI never estimates conversion values (no invented numbers); the paid audit asks the client for real ones.
2. **Fix pack** (paid): GTM container JSON to import (with a diff), platform snippets where GTM can't fix it (Shopify, Webflow, WordPress, Lovable/React), the tracking plan as a sheet, and a verify-after-fix re-scan with the same evidence standard.
3. **Ask your audit**: chat answered only from the report's evidence. Free: 3 questions (small model); answers about locked findings point to "Book the Tracking Audit". Paid: unlimited.
4. **Watch mode** (paid retainer after the audit, priced on the scoping call): weekly re-scan, AI explains what changed or broke, regression alerts.

**Model tiers**: free scans use Jev + a small fast Claude model with a strict token budget per scan. Paid uses the strongest Claude model for exploration, judgment and fixes.

**Data**: only redacted evidence goes to TypeSafe or Anthropic (no ids, emails, phones, cookie values; no client account data on free). Both are listed as subprocessors on the privacy page; paid audits name them in the scoping agreement.

**AI benchmark (2026-10-23), from the SDK packages themselves**
- Jev: `@typesafe-ai/sdk` 0.7.0, `POST https://api.typesafe.ai/v1/systemone`, key in `TYPESAFE_API_KEY`, model `jev-latest`. Many named questions over one `state` per call (batch per scan stage). `choice` and `score` return a confidence; `noul` returns only a probability (confidence = distance from 0.5). Client: 10s timeout, 2 retries, honours Retry-After.
- Claude: `@anthropic-ai/sdk` with structured output (`output_config.format` json_schema via `zodOutputFormat`), prompt caching on the static system prompt + rubric. Models: Haiku 5.5 on free, Opus 5.5 on paid.
- Evidence lock = our own evidence ids inside the schema (not native citations, whose combination with strict JSON is uncertain). Validator: every id exists in this scan; event names, domains and numbers in the text appear in the cited evidence; one repair retry, then fall back to the deterministic template text. Second gate: a Jev `choice` (supports / contradicts / unrelated) over the quoted evidence, TypeSafe's "double-checking citations" pattern; only a high-confidence `supports` passes. Gate on Jev `confidence`, not probability.
- Severity = atomic Jev scores (data loss, attribution impact, compliance risk, reach) combined with weights in code; Jev moves severity by at most one level from the rules.
- Escalation: rules -> Jev (accept at confidence >= 0.8) -> Claude reasons -> owner review (paid) / "Needs a closer look" (free).
- Explorer (paid): a plain Messages-API tool loop over our own guarded browser tools, not the Agent SDK (lighter, easier to sandbox).
- GTM fix pack: merge-safe container JSON (exportFormatVersion 2), prefixed names, never overwrite, never invent measurement or conversion ids (placeholders + checklist). GTM API deferred to Watch mode.
- Cost: hard per-scan caps (Jev calls, Claude tokens), cache by evidence digest, a global daily USD circuit breaker that degrades to deterministic output, `usage` logged on every call.
- Skipped: Jev images and `box` (experimental), the Agent SDK for the explorer, trusting Jev confidence as calibrated before measuring it on a labeled set.
- To confirm with TypeSafe in writing before launch: data retention and training, rate limits, max state size, direct API access (may be a waitlist; Vercel and Netlify AI gateways are fallbacks), pricing.

## 10. Connectors: scan metadata, uploaded recordings, erasure (decided 2026-10-25)

Contract: `CONNECTORS.md` section 5 in `SotwanCorp/strativra`. The platform (WordPress) is the only caller, with the `ENGINE_API_KEY` bearer. Code: `src/worker/{server,queue,runner,webhook,meta}.ts`, `src/core/upload.ts`, `src/pipeline.ts`.

**Scan metadata.** `POST /scans` takes optional `source` (`website|account|api|wordpress|extension`, default `website`), `trigger` (`manual|change_event|schedule|upload`, default `manual`), `accountRef` and `siteRef` (1 to 64 chars of `A-Za-z0-9_-`), and `ai` (boolean, default `true`). They are stored on the job (idempotent column migration, `trigger` is the `trigger_kind` column) and echoed in the webhook. `ai:false` skips the enricher; the deterministic report and the deterministic tracking plan still render. Invalid values answer 400 `invalid_source`, `invalid_trigger`, `invalid_account_ref`, `invalid_site_ref`, `invalid_ai`.
- Without `ENGINE_API_KEY` the four platform fields are refused (400 `metadata_requires_api_key`), because an anonymous browser could otherwise file scans under another account. `ai` is always allowed (it only lowers cost).
- `email` stays required for `source: website`. For the other sources, on an authenticated call, it may be left out: the rate-limit key is then the account ref, and the webhook carries no email.

**`POST /captures`** (bearer; no Turnstile; closed with 401 when `ENGINE_API_KEY` is not set). Body: JSON, `Content-Encoding: gzip` or none. `{capture, guidedSteps, consentMarkerTs, source:"extension", trigger:"upload", accountRef, siteRef, ai}`; `source` and `trigger` may be omitted but must not differ. Unknown fields are dropped. Errors are RFC 9457 `application/problem+json` with `code` (and `error`, the same value): 400 `invalid_gzip|invalid_json|invalid_capture` (detail names the field path), 413 `payload_too_large`, 415 `unsupported_media_type|unsupported_encoding`, 429 `rate_limited` (queue full only), 401 `unauthorized`. Answers `202 {jobId}`; the job is polled with `GET /scans/{jobId}` and ends with the same webhook as a scan.
- **Caps:** 2 MB as sent, 10 MB after gunzip (enforced while unzipping), 5,000 requests in total, 64 KB per `postData` (cut, not rejected), URLs over 8,192 chars dropped, strings cut (free text 80 to 300 chars, dataLayer strings 2,000), at most 2,000 dataLayer entries and 500 cookies per run, 100 guided steps, 3 scenario runs (one per scenario, no repeats).
- **Capture shape:** the `Capture` of `src/types.ts`. Required: `target` (http/https), `startedAt` (ISO), `durationMs`, `scenarios` (1 to 3 runs). Optional with defaults: `finalUrl`, `userAgent`, `pages`, `conversionPoints`, `platformHints`. Per run: `scenario`, `banner`, `cmp`, `requests`, `dataLayer`, `cookies`, `gtagConsent`, `errors`. `region` is ignored and set to "Recorded in your browser". `aborted` and `incomplete` are not accepted (a recording has neither). Screenshots are never accepted. Cookie records keep `name`, `domain`, `firstParty` only; values are not read.
- **Re-redaction (the engine never trusts the client):** emails (also `%40`) become `[email]` everywhere; query and body values under PII-like keys (`cid`, `uid`, `_ga*`, `_gcl_*`, `_fbp`, click ids, `em`, `ph`, `ud[...]`, `email`, `phone`, `token`, `ep.email` and similar) become `[redacted]` while the key stays, so decoders still see the event shape; values nested in URL params (`dl`, `dr`) are cleaned as URLs; credentials and non-route fragments are removed from URLs; request bodies are kept only for requests a decoder recognises as tracking (a form POST to the site loses its body); dataLayer payloads get the INIT_SCRIPT rules plus key checks (emails, 9+ digit runs as `[digits:<hash>]` so a reused `transaction_id` still compares equal). Long ids (Ads account, Meta pixel) are deliberately left alone. Source: `isPiiKey` from `src/ai/redact.ts` plus the exceptions the decoders need (`sid`, `_s`, `_p`, `sct`, `seg`).
- **Phases:** a request, dataLayer entry or cookie with a valid `phase` keeps it. Otherwise `ts >= consentMarkerTs` is `post`, earlier is `pre`; with no marker everything is `pre` (no consent choice recorded). Cookies have no `ts`: `post` when there is a marker, else `pre`. `consentMarkerTs` is on the same clock as request `ts` (ms since the recording started).
- **Consent runs:** the rules were written for hosted scans, where "no choice yet" is its own `none` run. When the upload has a single run labelled `accept` or `reject`, its `pre` part becomes a `none` run (banner `not_applicable`) and the rest stays the `accept` or `reject` run. So `consent.fires_before_consent` and `consent.granted_after_reject` work on one recording.
- **Guided steps** (`{name, action, ok, ts, pageUrl?, scenario?, conversionType?, pointId?}`; `name` is normalised to snake_case) become `FunnelStep`s on `ConversionPoint`s: `pointId` names a point in the capture; else the type is `conversionType` or taken from the name (`view_item`, `add_to_cart`, `begin_checkout`, `add_payment_info`, `add_shipping_info`, `view_cart` are purchase; `form_start` is lead; `click` is contact_click) and the step goes to the point of that type on the same page, else the only or most confident one; if the capture has none of that type, the engine creates `guided-<type>` (`detectedBy: "extension"`). A step with no type (for example `stop_before_submit`) is only listed. `ok:false` steps are listed and attached but never judged. A step's scenario is `scenario`, else `none` before the consent marker and the run's scenario after it. All steps are listed in the report under "What you recorded" (`Report.recording`), and the funnel rules cite them in their evidence.
- **No network, no browsing:** the job runs decode, rules, (AI when `ai`), report and PDF. The PDF printer is offline. `validateUrl` and DNS are not called, nothing is fetched from the recorded site or any vendor; a test spies on `net`, `dns` and `fetch` to prove it. The validated upload is stored gzipped on the job row and dropped when the job ends.
- **Rate limits:** the per-IP, per-email and per-domain scan limits do not apply (nothing is fetched from a third party and the platform enforces account quotas). The queue depth cap (`MAX_QUEUE_DEPTH`) does.
- Reports from captures are `free` kind (top 3 open) like scans.

**Webhook.** `scan.done` and `scan.failed` carry, besides the old fields, `source`, `trigger`, `accountRef`, `siteRef`, `ai`. `scan.done` adds `summary: {counts, top, conversions, aborted?}`: `counts` per severity, `top` the first 3 open findings as `{id, title, severity}`, `conversions` as `{type, status}`, `aborted` as `{reason, detail}` when the scan could not run. `email` is absent when the job had none.

**`DELETE /reports/{reportId}`** (bearer; `reportId` is the id from the webhook). Idempotent 204 whether or not the report exists. Removes the `reports` row and the job row, then the stored html, json, pdf and assets (R2 asset names are kept on the report row, since R2 cannot be listed). A queued job is cancelled; a running job discards its own result when it finishes (no storage write, no webhook). A storage failure answers 500 `storage_error`: retry. Expiry after 90 days is unchanged.

## 11. Open questions

1. Container host for the worker (ties to the site hosting choice).
2. Report URL domain (`strativra.com/r/...` vs a subdomain).
3. Wire the WordPress site: a plugin for the `/scan` page (instant + deep scan), server-side calls to the worker, `/r/` report proxy, webhook into leads.
4. Jev API details (endpoint, SDK, limits, pricing, data retention) to verify; the docs domain was unreachable from the cloud sandbox.
