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

/**
 * Who is allowed to embed this site in a frame.
 *
 * A mini app host runs the app inside an iframe on the web — the SDK speaks over a postMessage
 * channel "available in iframes and mobile WebViews" — so a blanket `X-Frame-Options: DENY` is
 * not a strict setting here, it is the difference between the Base app opening BStocks and showing
 * a blank panel. `frame-ancestors` keeps the same protection against everyone else, named host by
 * named host, and supersedes X-Frame-Options in every current browser, so the older header is
 * dropped rather than left to contradict this one.
 */
const FRAME_ANCESTORS = [
  "'self'",
  "https://farcaster.xyz",
  "https://*.farcaster.xyz",
  "https://warpcast.com",
  "https://*.warpcast.com",
  "https://base.app",
  "https://*.base.app",
  "https://base.org",
  "https://*.base.org",
  "https://wallet.coinbase.com",
  "https://*.coinbase.com",
  // Room to admit a host that appears after this ships, without a code change.
  ...(process.env.FRAME_ANCESTORS_EXTRA ?? "").split(/[\s,]+/).filter(Boolean),
].join(" ");

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
    resolveAlias: {
      ...Object.fromEntries(optionalX402.map((s) => [s, { browser: EMPTY }])),
      // The mini app SDK's core imports Solana's web3 library for a Solana wallet provider this
      // app never asks for; it is ~650 KB of the first bundle. A stub with the same named exports
      // (each failing loudly if ever called) takes its place in the browser.
      "@solana/web3.js": { browser: "./src/lib/solana-stub.ts" },
    },
  },
  /** `/.well-known/farcaster.json` is a fixed path in the mini app spec; the manifest itself is built per environment. */
  rewrites: async () => [{ source: "/.well-known/farcaster.json", destination: "/api/farcaster-manifest" }],
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Content-Security-Policy", value: `frame-ancestors ${FRAME_ANCESTORS}` },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
  ],
};

export default nextConfig;
