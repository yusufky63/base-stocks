import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const abi = parseAbi(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function name() view returns (string)", "function symbol() view returns (string)"]);
const factoryAbi = parseAbi(["function isB20(address token) view returns (bool)"]);
const FACTORY = "0xB20f000000000000000000000000000000000000";
// Coinbase SPCXc + any addresses passed via argv
const list = ["0xb2000000000000000000007b9fcbd005511aCBd5", ...process.argv.slice(2)];
for (const a of list) {
  const out = { address: a };
  for (const fn of ["name", "symbol", "decimals", "totalSupply"]) { try { out[fn] = String(await client.readContract({ address: a, abi, functionName: fn })); } catch { out[fn] = "ERR"; } }
  try { out.isB20 = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: "isB20", args: [a] }); } catch { out.isB20 = "ERR"; }
  console.log(JSON.stringify(out));
}
