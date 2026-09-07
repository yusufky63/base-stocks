import { V1_CAVEATS, V1_ENDPOINTS } from "@/lib/api-v1/catalog";
import { v1Json, v1Options } from "@/lib/api-v1/respond";
import { paymentInfo } from "@/lib/api-v1/x402";

/** The index: what exists, what it costs, and the four things about B20 a caller must encode. */
export async function GET(): Promise<Response> {
  return v1Json(
    {
      name: "BaseStocks API",
      version: "1",
      description: "Read-only data on Coinbase Tokenized Stocks (B20) on Base: prices, liquidity, Chainlink references, news, USDC yield venues, wallet positions and platform statistics.",
      docs: "https://basestocks.finance/developers",
      openapi: "https://basestocks.finance/api/v1/openapi.json",
      chain: { name: "base", chainId: 8453 },
      auth: "None. Every free endpoint is a plain GET with no key and no headers.",
      payment: paymentInfo(),
      cors: "Open to any origin.",
      endpoints: V1_ENDPOINTS,
      readThisFirst: V1_CAVEATS,
      eligibility: "Coinbase tokenized stocks are available only to eligible persons outside the United States. This API reports public chain data and does not itself offer or execute a trade.",
    },
    { cacheSeconds: 600, staleSeconds: 3_600 },
  );
}

export const OPTIONS = v1Options;
