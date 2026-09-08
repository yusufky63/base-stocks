import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { route, json } from "@/lib/api";
import { requireSession } from "@/lib/auth/session";
import { AppError } from "@/lib/errors";
import { metrics } from "@/lib/http";

const HOST = "api.developer.coinbase.com";
const PATH = "/onramp/v1/token";
const BUY_URL = "https://pay.coinbase.com/buy/select-asset";

/**
 * A Coinbase Onramp session, for the signed-in wallet and no other.
 *
 * Onramp turns a card or an Apple Pay tap into USDC that lands directly in the user's own wallet
 * on Base. Nothing is custodied on the way: the app never holds the fiat or the USDC, and the only
 * thing it contributes is the address to send to.
 *
 * That address is exactly what must not be attacker-controlled. A token minted for an arbitrary
 * address would let anyone spend this project's Onramp quota funding a wallet of their choosing,
 * which is why the route takes the address from the signed-in session rather than from the body,
 * and why it needs a wallet signature at all. Coinbase asks integrators to authenticate this call
 * for the same reason.
 *
 * The token is single-use and expires in five minutes, so it is minted per click and never cached.
 * Only the finished URL is returned: the raw token has no other use, and not shipping it keeps the
 * client from inventing one.
 */
export const POST = route({ rateLimit: { key: "onramp.session", limit: 10, windowMs: 60_000, durable: true } }, async (req) => {
  const address = requireSession(req);

  const apiKeyId = process.env.CDP_API_KEY_ID?.trim();
  const apiKeySecret = process.env.CDP_API_KEY_SECRET?.trim();
  if (!apiKeyId || !apiKeySecret) throw new AppError("PROVIDER_UNAVAILABLE", "Card top-ups are not enabled on this deployment.", 503);

  const jwt = await generateJwt({ apiKeyId, apiKeySecret, requestMethod: "POST", requestHost: HOST, requestPath: PATH });

  const res = await fetch(`https://${HOST}${PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
    // `assets` narrows the picker to the only thing this app settles in, so nobody buys ETH here by
    // accident and then wonders why the Buy button is still asking for USDC.
    body: JSON.stringify({ addresses: [{ address, blockchains: ["base"] }], assets: ["USDC"] }),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    metrics.count("onramp.session", false, `http ${res.status}`);
    throw new AppError("PROVIDER_UNAVAILABLE", "Coinbase could not start a top-up session right now. Try again in a moment.", 502, { status: res.status, detail });
  }

  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    metrics.count("onramp.session", false, "no token");
    throw new AppError("PROVIDER_UNAVAILABLE", "Coinbase did not return a top-up session. Try again in a moment.", 502);
  }

  metrics.count("onramp.session", true);
  // Never cached: the token behind this URL dies in five minutes and works once.
  return json({ url: `${BUY_URL}?sessionToken=${encodeURIComponent(body.token)}` }, { cacheSeconds: 0 });
});
