import { defineConfig } from "@playwright/test";

/**
 * Visual tests run against a dev server on port 3100 (avoids colliding with the
 * Docker `web` container / local dev on 3000). Screenshots are written to
 * ./screenshots. The Ollama health endpoint is stubbed per-test so banner
 * states are deterministic without a live model.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    viewport: { width: 1440, height: 1024 },
    deviceScaleFactor: 2,
    colorScheme: "dark",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "npx next dev -p 3100",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 120_000,
    // Isolate the test server's SQLite file from any running container DB.
    env: { DATA_DIR: ".pw-data" },
  },
});
