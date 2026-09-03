import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const V3 = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"; // Uniswap v3 factory on Base
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", WETH = "0x4200000000000000000000000000000000000006";
const abi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const stocks = { AAPL: "0xb200000000000000000000C2e324d24d7eEcd1fb", GOOGL: "0xb2000000000000000000002D0BA3164cc74f58B7", META: "0xb2000000000000000000008bC8786B856E61707C", NVDA: "0xb20000000000000000000078ee7ce2fE4908108C" };
for (const [t, a] of Object.entries(stocks)) for (const q of [USDC, WETH]) for (const fee of [100, 500, 3000, 10000]) {
  const p = await client.readContract({ address: V3, abi, functionName: "getPool", args: [a, q, fee] }).catch(() => null);
  if (p && p !== "0x0000000000000000000000000000000000000000") { const bal = await client.readContract({ address: q, abi: erc, functionName: "balanceOf", args: [p] }).catch(() => 0n); console.log(t, q === USDC ? "USDC" : "WETH", "fee", fee, p, "quoteBal", String(bal)); }
}
console.log("v3 scan done");
