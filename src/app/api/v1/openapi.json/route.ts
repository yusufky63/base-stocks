import { buildOpenApi } from "@/lib/api-v1/openapi";
import { V1_CORS } from "@/lib/api-v1/respond";
import { paymentInfo } from "@/lib/api-v1/x402";

/**
 * OpenAPI 3.1 for the public API, generated from the same catalog the docs page reads, so the
 * schema cannot drift from the endpoints it describes. Served as a document rather than kept as a
 * file for the same reason; `lib/api-v1/openapi.ts` builds it.
 */
export async function GET(): Promise<Response> {
  return new Response(JSON.stringify(buildOpenApi(paymentInfo().network), null, 2), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, s-maxage=600, stale-while-revalidate=3600", ...V1_CORS },
  });
}
