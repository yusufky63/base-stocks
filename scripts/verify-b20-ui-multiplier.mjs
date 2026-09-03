import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const abi = parseAbi(["function uiMultiplier() view returns (uint256)", "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)", "function MAX_UI_MULTIPLIER() view returns (uint256)", "function extraMetadata(string) view returns (string)"]);
for (const [t, a] of Object.entries({ NVDA: "0xb20000000000000000000078ee7ce2fE4908108C", AAPL: "0xb200000000000000000000C2e324d24d7eEcd1fb", TSLA: "0xb2000000000000000000001e800a7f5189430cD0" })) {
  const out = { t };
  for (const fn of ["uiMultiplier", "newUIMultiplier", "effectiveAt", "MAX_UI_MULTIPLIER"]) { try { out[fn] = String(await client.readContract({ address: a, abi, functionName: fn })); } catch (e) { out[fn] = "ERR " + (e.shortMessage || e.message).slice(0, 50); } }
  try { out.isin = await client.readContract({ address: a, abi, functionName: "extraMetadata", args: ["isin"] }); } catch { out.isin = "ERR"; }
  console.log(JSON.stringify(out));
}
