/**
 * WXT build for the Strativra Chrome extension (MV3, side panel, vanilla TS).
 *
 *   npm run ext:build        -> out/extension       (store build)
 *   npm run test:extension   -> out/extension-e2e   (same code; host permissions granted at install so
 *                                                    Playwright never meets a permission prompt)
 *
 * The MAIN-world script is the engine's INIT_SCRIPT itself: `virtual:strv-init-script` resolves to
 * the INIT_SCRIPT string from src/browser/init-script.ts, bundled as code (no eval, no remote code).
 * The engine's capture helpers import node:net / node:dns for SSRF checks the extension never calls;
 * those imports resolve to an empty stub so nothing Node-only reaches the bundle.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "wxt";
import { INIT_SCRIPT } from "../browser/init-script.ts";

const E2E = process.env.STRV_E2E === "1";
const NODE_STUB = fileURLToPath(new URL("./lib/node-stub.ts", import.meta.url));
const VERSION = "0.1.0";

export default defineConfig({
  imports: false,
  outDir: "../../out",
  outDirTemplate: E2E ? "extension-e2e" : "extension",
  zip: { artifactTemplate: "strativra-extension-{{version}}-chrome.zip" },
  manifest: {
    name: "Strativra Tracking Recorder",
    short_name: "Strativra",
    description: "Check a site's tracking: scan it on Strativra, or record your own visit and get the report.",
    version: VERSION,
    minimum_chrome_version: "116",
    action: { default_title: "Strativra" },
    permissions: ["storage", "scripting", "webRequest", "webNavigation", "sidePanel", "browsingData", "cookies"],
    host_permissions: E2E ? ["https://strativra.com/*", "https://*/*", "http://*/*"] : ["https://strativra.com/*"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
  },
  vite: () => ({
    resolve: {
      alias: [
        { find: /^node:net$/, replacement: NODE_STUB },
        { find: /^node:dns\/promises$/, replacement: NODE_STUB },
      ],
    },
    build: { sourcemap: false, minify: true },
    plugins: [
      {
        name: "strv-init-script",
        resolveId(id: string) {
          return id === "virtual:strv-init-script" ? "\0strv-init-script" : null;
        },
        load(id: string) {
          return id === "\0strv-init-script" ? INIT_SCRIPT : null;
        },
      },
    ],
  }),
});
