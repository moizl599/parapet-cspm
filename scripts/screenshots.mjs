/**
 * Phase 9 review screenshots. Mocks the API (no DB / no AWS / no Ollama needed)
 * and captures the four states requested for review.
 *
 *   node scripts/screenshots.mjs
 *
 * Requires the dev server running (BASE_URL, default http://localhost:3100).
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3100";
const OUT = "screenshots";
mkdirSync(OUT, { recursive: true });

const ENVIRONMENTS = [
  {
    id: "env-prod",
    name: "Production",
    targetAccountId: "123456789012",
    authMode: "role",
    roleArn: "arn:aws:iam::123456789012:role/SecurityAudit",
    regions: ["us-east-1", "eu-west-1"],
    hasExternalId: true,
    createdAt: "2026-05-01T10:00:00.000Z",
    lastScanId: "scan-prod-1",
    lastScanAt: "2026-06-05T14:20:00.000Z",
    lastPostureScore: 62,
  },
  {
    id: "env-staging",
    name: "Staging",
    targetAccountId: "234567890123",
    authMode: "role",
    roleArn: "arn:aws:iam::234567890123:role/SecurityAudit",
    regions: ["us-east-1"],
    hasExternalId: true,
    createdAt: "2026-05-02T10:00:00.000Z",
    lastScanId: "scan-staging-1",
    lastScanAt: "2026-06-04T09:10:00.000Z",
    lastPostureScore: 88,
  },
  {
    id: "env-sandbox",
    name: "Sandbox",
    targetAccountId: "345678901234",
    authMode: "base",
    roleArn: null,
    regions: [],
    hasExternalId: false,
    createdAt: "2026-05-03T10:00:00.000Z",
    lastScanId: null,
    lastScanAt: null,
    lastPostureScore: null,
  },
];

const HEALTH = {
  ok: true,
  status: "ready",
  message: "Model ready",
  baseUrl: "http://localhost:11434/v1",
  model: "llama3.1:8b",
};

async function mock(page) {
  await page.route("**/api/environments", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { environments: ENVIRONMENTS } });
    return route.fallback();
  });
  await page.route("**/api/health/ollama", (route) =>
    route.fulfill({ json: HEALTH }),
  );
  await page.route("**/api/environments/test", (route) =>
    route.fulfill({ json: { ok: true, account_id: "123456789012" } }),
  );
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
await mock(page);

// (a) Analyzing progress — mid-run, chunk 3/6 + soft estimate.
await page.goto(`${BASE}/?demo=analyzing`, { waitUntil: "networkidle" });
await page.waitForTimeout(1600); // let the elapsed clock tick
await page.screenshot({ path: `${OUT}/a-analyzing.png` });
console.log("✓ a-analyzing.png");

// (b) Environments list.
await page.goto(`${BASE}/environments`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);
await page.screenshot({ path: `${OUT}/b-environments.png` });
console.log("✓ b-environments.png");

// (c) Add-environment form mid-fill with a Test connection result.
await page.getByRole("button", { name: "Add environment" }).first().click();
await page.getByLabel("Name").fill("Production");
await page.getByRole("radio", { name: /Assume role/ }).click();
await page
  .getByLabel("Role ARN")
  .fill("arn:aws:iam::123456789012:role/SecurityAudit");
await page.getByLabel(/External ID/).fill("cspm-ext-9f3a2b41");
await page.getByLabel("Regions").fill("us-east-1, eu-west-1");
await page.getByRole("button", { name: "Test connection" }).click();
await page.getByText(/Connected/).waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/c-add-env-form.png` });
console.log("✓ c-add-env-form.png");
await page.keyboard.press("Escape");

// (d) Header environment switcher open (demo backdrop so the body is populated).
await page.goto(`${BASE}/?demo=analyzing`, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.locator('button[aria-haspopup="listbox"]').click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/d-switcher-open.png` });
console.log("✓ d-switcher-open.png");

await browser.close();
console.log("done");
