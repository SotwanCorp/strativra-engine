# CLAUDE.md: Strativra Tracking Audit Engine

The engine behind Strativra's free tracking scan and paid Tracking Audit. Spec and benchmark decisions: @SPEC.md. Business context and the decisions log live in the site repo `SotwanCorp/strativra` (`CONTEXT.md`). Record engine decisions in `SPEC.md` in the same change.

Cloud sessions have no local memory. These files are the memory.

## Layout

```
src/types.ts      the shared contract. Change types here first, then the modules
src/core/         pure logic: decoders, contracts, detection, rules, ranking (no browser)
src/browser/      Playwright runner: scenarios, consent, capture, discovery, safe funnel walk
src/report/       report model -> private web report (HTML) + PDF
src/worker/       hosted runner: HTTP API, SQLite queue, limits, Turnstile, storage
src/cli/          local runner for paid audits (credentials stay on the owner's machine)
src/core/instant/ the instant raw-HTML scanner (moved from the old Astro site)
```

## Commands

```bash
npm ci            # Node 22.6+
npm run check     # tsc --noEmit, must pass
npm test          # node:test via --experimental-strip-types, must pass
```

Chromium: use `playwright-core` with `executablePath` from `CHROMIUM_PATH` (cloud sessions: `/opt/pw-browsers/chromium-1243/chrome-linux64/chrome`). Don't run `playwright install`.

## Rules (non-negotiable)

1. **Never submit, never pay.** No clicks on submit, pay, place order, subscribe, confirm. Never type an email or phone into a live site. Non-tracking POSTs and payment endpoints are blocked at the network layer.
2. **SSRF:** every request and redirect from the browser is checked against private ranges, not just the start URL.
3. **No stealth.** No fingerprint spoofing. A bot wall is reported as "blocked by bot protection".
4. **Privacy:** cookie values are never stored. dataLayer copies are PII-redacted. Never push PII to any dataLayer.
5. **Honesty:** no invented metrics, benchmarks or client names. Unknown stays unknown (e.g. undocumented gcd letters). Claims from outside are hedged: we only see the browser half of sGTM and CAPI.
6. **Report copy:** no em-dashes or en-dashes in visible text, no prices, CTA label "Book a Tracking Audit" (from the CTA labels table in `SotwanCorp/strativra` `CLAUDE.md`).
7. **Erasable TypeScript only** (no enums, no parameter properties), imports with `.ts` extensions.

## How to work here

Same as the docs repo (`SotwanCorp/strativra`): orchestrate with subagents (cheapest model that can do each task), benchmark before each build step, correctness first. Every module ships with `node:test` tests on fixtures, not live sites.
