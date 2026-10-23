/** Contract the worker needs from the scan pipeline (injected, never imported directly). */
export type Pipeline = {
  validateUrl(input: string): Promise<URL>;
  run(
    url: URL,
    opts: { region: string; reportId: string; screenshotDir: string },
  ): Promise<{ report: unknown; html: string; pdf?: Buffer }>;
};
