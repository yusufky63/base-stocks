import { NextResponse } from "next/server";
import { publicEnv } from "@/config/env";
import { BASE_CHAIN_ID } from "@/config/chain";

/**
 * The mini app manifest, served at `/.well-known/farcaster.json` through a rewrite.
 *
 * Built here rather than kept as a static file for one reason that matters in practice: the
 * `accountAssociation` is a signature over *this exact domain*, and it is produced by hand in the
 * Base or Farcaster developer tool long after the code is written. Reading it from the environment
 * means the signature is pasted into Vercel once and the repository never carries a credential.
 *
 * Until it is signed the block is omitted entirely rather than emitted empty: an unsigned manifest
 * is honestly unsigned, where one full of empty strings looks signed and fails validation.
 */
export const dynamic = "force-dynamic";

const APP_URL = publicEnv.appUrl.replace(/\/$/, "");

function accountAssociation(): Record<string, string> | null {
  const header = process.env.FARCASTER_ACCOUNT_HEADER?.trim();
  const payload = process.env.FARCASTER_ACCOUNT_PAYLOAD?.trim();
  const signature = process.env.FARCASTER_ACCOUNT_SIGNATURE?.trim();
  if (!header || !payload || !signature) return null;
  return { header, payload, signature };
}

/** Addresses allowed to manage this mini app in the Base build tools; comma separated. */
function allowedAddresses(): string[] {
  return (process.env.BASE_BUILDER_ALLOWED_ADDRESSES ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
}

export function GET() {
  const association = accountAssociation();
  const allowed = allowedAddresses();
  return NextResponse.json(
    {
      ...(association ? { accountAssociation: association } : {}),
      ...(allowed.length > 0 ? { baseBuilder: { allowedAddresses: allowed } } : {}),
      miniapp: {
        version: "1",
        name: "BaseStocks",
        homeUrl: `${APP_URL}/`,
        iconUrl: `${APP_URL}/brand/icon-1024.png`,
        splashImageUrl: `${APP_URL}/brand/splash-200.png`,
        splashBackgroundColor: "#0370fd",
        subtitle: "Stocks, built for onchain",
        description:
          "Trade Coinbase Tokenized Stocks, build baskets, automate plans and put idle USDC to work on Base. Self-custodial: every action is confirmed in your wallet.",
        primaryCategory: "finance",
        tags: ["stocks", "base", "defi", "portfolio", "usdc"],
        heroImageUrl: `${APP_URL}/opengraph-image`,
        tagline: "Tokenized stocks, your wallet",
        ogTitle: "BaseStocks · Stocks on Base",
        ogDescription: "Trade tokenized stocks, build baskets and earn on Base, self-custodially.",
        ogImageUrl: `${APP_URL}/opengraph-image`,
        // Every action this app takes settles on Base; a host that cannot reach it should say so
        // up front rather than let a user get as far as a transaction that can never be signed.
        requiredChains: [`eip155:${BASE_CHAIN_ID}`],
        noindex: false,
      },
    },
    { headers: { "cache-control": "public, max-age=0, s-maxage=600, stale-while-revalidate=3600" } },
  );
}
