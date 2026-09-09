import { expect, test } from "@playwright/test";

const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";

test.describe("anonymous smoke", () => {
  test("home renders the hero, nav and footer wordmark", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Stocks,");
    await expect(page.getByRole("banner").getByRole("link", { name: "Gifts" })).toBeVisible();
    await expect(page.locator("footer svg.footer-wordmark")).toBeAttached();
    await expect(page.locator("footer").getByText("@xBaseStocks")).toBeVisible();
  });

  test("markets lists live stocks with prices", async ({ page }) => {
    await page.goto("/markets");
    await expect(page.getByText("NVIDIA", { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("AAPL", { exact: false }).first()).toBeVisible();
  });

  test("stock page carries the five tabs and the trade modes", async ({ page }) => {
    await page.goto(`/stocks/${NVDA}`);
    const tabs = page.getByRole("tablist", { name: "Stock sections" }).first();
    for (const label of ["Position", "Trades", "Orders", "Earn", "Details"]) {
      await expect(tabs.getByRole("tab", { name: label })).toBeVisible({ timeout: 20_000 });
    }
    const mode = page.getByRole("tablist", { name: "Trade mode" }).first();
    for (const label of ["Buy", "Sell", "Limit"]) {
      await expect(mode.getByRole("tab", { name: label })).toBeVisible();
    }
  });

  test("a live quote appears for an anonymous visitor", async ({ page }) => {
    await page.goto(`/stocks/${NVDA}`);
    await expect(page.getByText("You receive (est.)").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/best net/).first()).toBeVisible({ timeout: 30_000 });
  });

  test("gifts page shows create and history", async ({ page }) => {
    await page.goto("/gifts");
    const tabs = page.getByRole("tablist", { name: "Gift sections" });
    await expect(tabs.getByRole("tab", { name: "Create" })).toBeVisible();
    await expect(tabs.getByRole("tab", { name: "History" })).toBeVisible();
    await expect(page.getByText("Connect a wallet to gift stock you hold.")).toBeVisible();
  });

  test("how-it-works covers integrations, limit orders and claim links", async ({ page }) => {
    await page.goto("/how-it-works");
    await expect(page.locator("#integrations")).toBeAttached();
    await expect(page.getByText("How do limit orders work?")).toBeVisible();
    await expect(page.getByText("What is a claim-link gift?")).toBeVisible();
  });

  test("unknown claim links land on not-found, never on a gift card", async ({ page }) => {
    await page.goto("/gifts/claim/gift_doesnotexist");
    await expect(page.getByText("A gift for you")).toHaveCount(0);
  });

  test("health and status APIs answer", async ({ request }) => {
    const health = await request.get("/api/health");
    expect(health.ok()).toBeTruthy();
    expect((await health.json()).ok).toBe(true);
    const assets = await request.get("/api/assets");
    expect(assets.ok()).toBeTruthy();
    const list = (await assets.json()).assets as unknown[];
    expect(list.length).toBeGreaterThanOrEqual(13);
  });
});
