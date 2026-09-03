import type { NextConfig } from "next";

/**
 * `@base-org/account` → `@coinbase/cdp-sdk` dynamically imports optional x402 payment packages
 * we never use. Turbopack resolves imports eagerly, so point those optional specifiers at an
 * empty module (documented `turbopack.resolveAlias` fallback pattern).
 */
const EMPTY = "./src/lib/empty.ts";
const optionalX402 = [
  "@x402/core/client",
  "@x402/core/server",
  "@x402/evm",
  "@x402/evm/batch-settlement/client",
  "@x402/evm/exact/client",
  "@x402/evm/exact/server",
  "@x402/evm/exact/v1/client",
  "@x402/evm/upto/client",
  "@x402/evm/upto/server",
  "@x402/express",
  "@x402/extensions/bazaar",
  "@x402/extensions/builder-code",
  "@x402/fetch",
  "@x402/svm/exact/client",
  "@x402/svm/exact/server",
  "@x402/svm/exact/v1/client",
];

const nextConfig: NextConfig = {
  /** Share cards read fonts and brand PNGs from disk at request time; make sure the serverless bundles carry them. */
  outputFileTracingIncludes: {
    "/opengraph-image": ["./public/fonts/**", "./public/brand/**"],
    "/stocks/[address]/opengraph-image": ["./public/fonts/**", "./public/brand/**"],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  // Keep the wallet SDK's Node entry (which statically imports the CDP SDK) out of server bundles;
  // Node resolves it at runtime and the optional x402 imports stay lazy and never execute.
  serverExternalPackages: ["@base-org/account", "@coinbase/cdp-sdk"],
  turbopack: {
    resolveAlias: Object.fromEntries(optionalX402.map((s) => [s, { browser: EMPTY }])),
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
  ],
};

export default nextConfig;
