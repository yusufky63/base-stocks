import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

/**
 * Which pages another site may frame. The widgets exist to be framed by anyone; every other page
 * keeps the named list of mini app hosts. A rule that let the whole site be framed, or that framed
 * the widgets only for the named hosts, would both pass a casual look, so the patterns are checked
 * against real paths.
 */
describe("who may frame the site", () => {
  const matches = (source: string, path: string) => new RegExp(`^${source.replace(/:path\*/g, ".*")}$`).test(path);

  it("opens the widgets to every site and keeps the rest to the named hosts", async () => {
    const rules = (await nextConfig.headers!()) as Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    const policyFor = (path: string) =>
      rules
        .filter((r) => matches(r.source, path))
        .flatMap((r) => r.headers)
        .filter((h) => h.key === "Content-Security-Policy")
        .map((h) => h.value);

    for (const path of ["/embed/trade/0xb20000000000000000000078ee7ce2fe4908108c", "/embed/stock/0xb20000000000000000000078ee7ce2fe4908108c"]) {
      const policies = policyFor(path);
      expect(policies, path).toHaveLength(1);
      expect(policies[0]).toContain("frame-ancestors *;");
      expect(policies[0]).toContain("object-src 'none'");
    }
    for (const path of ["/", "/stocks/0x1", "/widgets", "/embedded", "/api/assets"]) {
      const policies = policyFor(path);
      expect(policies, path).toHaveLength(1);
      expect(policies[0]).toContain("frame-ancestors 'self' https://farcaster.xyz");
      expect(policies[0]).not.toContain("frame-ancestors *");
    }
  });
});
