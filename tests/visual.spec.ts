import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const SHOTS = "screenshots";

const READY = {
  ok: true,
  status: "ready",
  message: "ready",
  baseUrl: "http://ollama:11434/v1",
  model: "llama3.1:8b",
};

/** Stub the Ollama health endpoint so banner state is deterministic. */
async function stubHealth(page: Page, body: object, status = 200) {
  await page.route("**/api/health/ollama", (route) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

test.beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
});

test("overview renders posture, severity and summary", async ({ page }) => {
  await stubHealth(page, READY);
  await page.goto("/?demo=1");
  await expect(page.getByText("Posture score")).toBeVisible();
  await expect(page.getByText("Failed findings by severity")).toBeVisible();
  await expect(page.getByText("Executive summary")).toBeVisible();
  await page.waitForTimeout(900); // settle gauge/donut transitions
  await page.screenshot({ path: `${SHOTS}/overview.png`, fullPage: true });
});

test("all-clear state (posture 100, no failed findings)", async ({ page }) => {
  await stubHealth(page, READY);
  await page.goto("/?demo=clear");
  await expect(page.getByText("All clear")).toBeVisible();
  await expect(page.getByText("Strong")).toBeVisible();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/all-clear.png`, fullPage: true });
});

test("action queue card expands to detail", async ({ page }) => {
  await stubHealth(page, READY);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: /Action queue/i }).click();
  await expect(page.getByText("Lock down the public").first()).toBeVisible();
  await page.locator("button[aria-expanded]").first().click();
  await expect(page.getByText("Why it matters").first()).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `${SHOTS}/action-queue-expanded.png`,
    fullPage: true,
  });
});

test("findings table applies a severity filter", async ({ page }) => {
  await stubHealth(page, READY);
  await page.goto("/?demo=1");
  await page.getByRole("button", { name: /Findings/i }).click();
  await page.getByLabel("Filter by severity").selectOption("critical");
  await expect(page.getByText(/Showing \d+ of \d+ findings/)).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: `${SHOTS}/findings-filtered.png`,
    fullPage: true,
  });
});

test("ollama banner - model not pulled", async ({ page }) => {
  await stubHealth(
    page,
    {
      ok: false,
      status: "model-not-found",
      message: "model missing",
      baseUrl: "http://ollama:11434/v1",
      model: "llama3.1:8b",
    },
    503,
  );
  await page.goto("/?demo=1");
  await expect(page.getByText("Local model not pulled yet")).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/ollama-model-not-found.png`,
    fullPage: true,
  });
});

test("ollama banner - unreachable", async ({ page }) => {
  await stubHealth(
    page,
    {
      ok: false,
      status: "unreachable",
      message: "down",
      baseUrl: "http://ollama:11434/v1",
      model: "llama3.1:8b",
    },
    503,
  );
  await page.goto("/?demo=1");
  await expect(page.getByText("Ollama is unreachable")).toBeVisible();
  await page.screenshot({
    path: `${SHOTS}/ollama-unreachable.png`,
    fullPage: true,
  });
});
