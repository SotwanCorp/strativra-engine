/** Fake Jev / Claude clients and a capture fixture for the AI layer tests. Fictional data only. */
import type { Questions, SystemOneRequest, SystemOneResult } from "@typesafe-ai/sdk";
import type Anthropic from "@anthropic-ai/sdk";
import type { Capture } from "../types.ts";
import type { JevClient } from "./judge.ts";
import type { ClaudeClient, ClaudeParsed } from "./writer.ts";

type Answers = SystemOneResult<Questions>["answers"];

export interface FakeJevOpts {
  /** Per question name, override the answer. */
  answer?: (name: string, q: Questions[string]) => unknown;
  /** Default confidence for choice/score answers. */
  confidence?: number;
  throws?: unknown;
}

export class FakeJev implements JevClient {
  calls: SystemOneRequest<Questions>[] = [];
  opts: FakeJevOpts;
  constructor(opts: FakeJevOpts = {}) {
    this.opts = opts;
  }
  async systemOne(req: SystemOneRequest<Questions>): Promise<SystemOneResult<Questions>> {
    this.calls.push(structuredClone(req));
    if (this.opts.throws) throw this.opts.throws;
    const answers: Record<string, Answers[string]> = {};
    const conf = this.opts.confidence ?? 0.95;
    for (const [name, q] of Object.entries(req.questions)) {
      const o = this.opts.answer?.(name, q) as Answers[string] | undefined;
      if (o) {
        answers[name] = o;
        continue;
      }
      if (q.type === "noul") answers[name] = { type: "noul", noul: 0.9 };
      else if (q.type === "choice") {
        const labels = Object.keys(q.criteria);
        const probabilities = Object.fromEntries(labels.map((l, i) => [l, i === 0 ? conf : (1 - conf) / Math.max(1, labels.length - 1)]));
        answers[name] = { type: "choice", choice: labels[0], confidence: conf, probabilities };
      } else if (q.type === "score") {
        const n = q.criteria.length;
        const probabilities = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === 1 ? 1 : 0]));
        answers[name] = { type: "score", score: 1.02, confidence: conf, legend: {}, probabilities } as unknown as Answers[string];
      }
    }
    return { model: "jev-test", answers, usage: { input_tokens: 100, output_tokens: 10 } };
  }
}

export class FakeClaude implements ClaudeClient {
  calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  responder: (params: Anthropic.MessageCreateParamsNonStreaming, n: number) => unknown;
  stop: string;
  throws?: unknown;
  constructor(responder: (params: Anthropic.MessageCreateParamsNonStreaming, n: number) => unknown, opts: { stop?: string; throws?: unknown } = {}) {
    this.responder = responder;
    this.stop = opts.stop ?? "end_turn";
    this.throws = opts.throws;
  }
  messages = {
    parse: async (params: Anthropic.MessageCreateParamsNonStreaming): Promise<ClaudeParsed> => {
      this.calls.push(params);
      if (this.throws) throw this.throws;
      const out = this.responder(params, this.calls.length - 1);
      return {
        parsed_output: out,
        stop_reason: this.stop,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 800, cache_creation_input_tokens: 0 },
        model: params.model,
      };
    },
  };
  /** Everything the model was sent, as one string. */
  sent(): string {
    return JSON.stringify(this.calls);
  }
}

/** Fictional capture matching src/report/fixtures/sample-report.ts refs. Contains PII on purpose. */
export function sampleCapture(): Capture {
  const base = { scenario: "none" as const, phase: "pre" as const, ts: 1000, pageUrl: "https://example-shop.test/", method: "GET", resourceType: "image" };
  return {
    target: "example-shop.test",
    finalUrl: "https://example-shop.test/",
    region: "EU (Germany)",
    startedAt: "2026-10-23T09:29:00.000Z",
    durationMs: 48000,
    userAgent: "test",
    pages: [
      { url: "https://example-shop.test/?email=jane.doe@example.org", status: 200, via: "start", title: "Home" },
      { url: "https://example-shop.test/contact", status: 200, via: "link", title: "Contact" },
    ],
    scenarios: [
      {
        scenario: "none",
        banner: "not_applicable",
        requests: [
          { ...base, id: "req-014", url: "https://www.google-analytics.com/g/collect?v=2&tid=G-TEST0000&en=page_view&cid=1234567890.1700000000&uid=user-8842&gcs=G111&dl=https%3A%2F%2Fexample-shop.test%2F%3Femail%3Djane.doe%40example.org" },
          { ...base, id: "req-021", url: "https://www.facebook.com/tr?id=000000000000000&ev=PageView&ud[em]=7d3b8c1f00aa11bb22cc33dd44ee55ff66778899aabbccddeeff001122334455&fbp=fb.1.1700000000.987654321" },
          { ...base, id: "req-044", url: "https://www.facebook.com/tr?id=000000000000000&ev=Purchase&eid=" },
          { ...base, id: "req-051", url: "https://www.googleadservices.com/pagead/conversion/000000000/?label=abc123&value=1&em=absent" },
          { ...base, id: "req-900", url: "https://cdn.example-shop.test/app.js" },
        ],
        dataLayer: [
          { scenario: "none", phase: "pre", ts: 900, pageUrl: "https://example-shop.test/", payload: { event: "user_data", email: "jane.doe@example.org", phone: "+33 6 12 34 56 78", note: "call me on +33 6 12 34 56 78 or jane.doe@example.org" } },
          { scenario: "none", phase: "pre", ts: 950, pageUrl: "https://example-shop.test/", payload: { event: "purchase", currency: "EUR", value: 49.9, transaction_id: "T-1" } },
        ],
        cookies: [{ scenario: "none", phase: "pre", name: "_ga", domain: ".example-shop.test", firstParty: true }],
        screenshots: [{ key: "shots/consent-none.png", caption: "Banner still open while tags fire", pageUrl: "https://example-shop.test/", scenario: "none" }],
        errors: [],
      },
    ],
    conversionPoints: [
      { id: "cp1", type: "purchase", pageUrl: "https://example-shop.test/product", label: "Add to cart + checkout", detectedBy: "shopify", confidence: 0.95, walk: [] },
      { id: "cp2", type: "lead", pageUrl: "https://example-shop.test/contact", label: "Contact form (3 fields)", detectedBy: "generic", confidence: 0.5, walk: [] },
    ],
    platformHints: ["Example Platform"],
  };
}
