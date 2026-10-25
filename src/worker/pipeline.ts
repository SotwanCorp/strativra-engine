import type { CaptureUpload } from "../core/upload.ts";

/** Contract the worker needs from the scan pipeline (injected, never imported directly). */
export type Pipeline = {
  validateUrl(input: string): Promise<URL>;
  run(
    url: URL,
    /** `ai: false` skips AI enrichment (unverified sites, budget). Default true. */
    opts: { region: string; reportId: string; screenshotDir: string; ai?: boolean },
  ): Promise<{ report: unknown; html: string; pdf?: Buffer }>;
  /**
   * Report from a recording uploaded by the browser extension. Decode, rules, (AI), report, PDF.
   * Makes no request to the recorded site and starts no crawling browser.
   */
  fromCapture(
    upload: CaptureUpload,
    opts: { reportId: string; ai?: boolean },
  ): Promise<{ report: unknown; html: string; pdf?: Buffer }>;
};
