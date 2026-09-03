import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", AAPL = "0xb2000000000000000000000000000000000000dc";
const fAbi = parseAbi(["function getPool(address,address,int24) view returns (address)", "function tickSpacings() view returns (int24[])", "function allPoolsLength() view returns (uint256)"]);
for (const f of ["0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A", "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef"]) {
  console.log("factory", f);
  for (const fn of ["tickSpacings", "allPoolsLength"]) { try { console.log(" ", fn, String(await client.readContract({ address: f, abi: fAbi, functionName: fn }))); } catch (e) { console.log(" ", fn, "ERR", e.shortMessage || e.message); } }
  for (const ts of [1, 10, 50, 100, 200, 2000]) { try { const p = await client.readContract({ address: f, abi: fAbi, functionName: "getPool", args: [NVDA, USDC, ts] }); if (p !== "0x0000000000000000000000000000000000000000") console.log("  NVDA/USDC ts", ts, p); } catch {} }
}
