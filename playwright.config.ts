import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke suite against the dev server (reuses one already running on :3000, starts one otherwise).
 * Anonymous flows only: no wallet, no signing, no onchain writes — safe anywhere.
 */
export default defineConfig({
  testDir: "tests/e2e",
  timeout: 45_000,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    port: 3000,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
