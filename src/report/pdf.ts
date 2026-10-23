import { chromium } from "playwright-core";

const DEFAULT_CHROMIUM = "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";

/** Render a report HTML document to an A4 PDF. Motion is off, print CSS applies. */
export async function renderPdf(html: string, opts: { executablePath?: string } = {}): Promise<Buffer> {
  const executablePath = opts.executablePath ?? process.env.CHROMIUM_PATH ?? DEFAULT_CHROMIUM;
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ javaScriptEnabled: true, offline: true });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => true));
    await page.emulateMedia({ media: "print", reducedMotion: "reduce" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
