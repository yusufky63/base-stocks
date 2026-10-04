import { publicEnv } from "@/config/public-env";
import { llmsFullTxt } from "@/lib/api-v1/llms";
import { ensureDiscoveredRegistry } from "@/services/b20-asset-service";

/**
 * The whole public API in one plain-text file, beside the short llms.txt index: what a model needs
 * in its context to call the API correctly, trade building included. The base URL is the
 * deployment's own, as llms.txt's is.
 */
export async function GET(): Promise<Response> {
  await ensureDiscoveredRegistry();
  return new Response(llmsFullTxt(publicEnv.appUrl.replace(/\/$/, "")), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400", "access-control-allow-origin": "*" },
  });
}
