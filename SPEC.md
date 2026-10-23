# SPEC.md: Tracking Audit Engine spec

Spec agreed with the owner on 2026-10-23. Decisions are also in the `CONTEXT.md` log. This repo (`SotwanCorp/strativra-engine`) is the engine. The marketing site is `SotwanCorp/strativra`; its `site/src/lib/scan.ts` is the raw-HTML layer we grow from, and its `CONTEXT.md` holds the business decisions log.

## 1. What it is

A tool that shows a business **why its tracking is not working and what its current setup is**. The free tier diagnoses. The paid Tracking Audit goes deeper and says how to fix everything.

- **Free (self-serve on `/scan`):** outside-in only. A headless browser behaves like a visitor and records every tag, cookie and network hit.
- **Paid (the Tracking Audit):** outside-in, plus read-only account access, a config audit and a 30-day cross-system reconciliation that puts a size on the leak.
- **Unlock:** the CTA on locked content is "Book the Tracking Audit" (from `CTA` in `site/src/lib/site.ts`), then a scoping call, a fixed quote and an invoice. No prices on the report or the site.

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
  worker/      hosted runner (Docker + Playwright) for free scans, called by site /api/scan
  cli/         local runner for paid audits (credentials never leave the machine)
  report/      web report + PDF renderer
```

- The check catalogue grows from the existing `site/src/lib/scan.ts` (raw-HTML checks stay as the first layer).
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

## 9. Open questions

1. Container host for the worker (ties to the site hosting choice).
2. Report URL domain (`strativra.com/r/...` vs a subdomain).
3. Wire the site: `/scan` form and `/api/scan` call the worker.
