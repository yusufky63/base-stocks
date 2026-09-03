import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C", USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const F = "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef";
const fAbi = parseAbi(["function getPool(address,address,int24) view returns (address)", "function tickSpacings() view returns (int24[])", "function allPoolsLength() view returns (uint256)", "function poolImplementation() view returns (address)", "function voter() view returns (address)", "function owner() view returns (address)"]);
for (const fn of ["tickSpacings", "allPoolsLength", "poolImplementation", "voter", "owner"]) { try { const r = await client.readContract({ address: F, abi: fAbi, functionName: fn }); console.log(fn, Array.isArray(r) ? r.map(Number) : String(r)); } catch (e) { console.log(fn, "ERR", e.shortMessage || e.message); } }
for (const ts of [1, 10, 50, 100, 200, 2000]) console.log("getPool ts", ts, await client.readContract({ address: F, abi: fAbi, functionName: "getPool", args: [NVDA, USDC, ts] }).catch(e => "ERR " + (e.shortMessage || e.message)));
// Other B20 stocks with pools on this factory?
const assets = await fetch("http://localhost:3000/api/assets").then(r => r.json());
for (const a of assets.assets) { for (const ts of [10, 100, 200]) { const p = await client.readContract({ address: F, abi: fAbi, functionName: "getPool", args: [a.address, USDC, ts] }).catch(() => null); if (p && p !== "0x0000000000000000000000000000000000000000") console.log(a.underlying, "ts", ts, p); } }
