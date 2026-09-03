import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const FACTORY = "0xB20f000000000000000000000000000000000000";
const abi = parseAbi(["event B20Created(address indexed token, string name, string symbol)"]);
const registryAbi = parseAbi(["function getOracleParams(address token) view returns (uint256 multiplier, bool paused)"]);
const latest = await client.getBlockNumber();
const found = [];
for (let to = latest, i = 0; i < 60; i++) { const from = to - 9_999n; if (from < 0n) break; const logs = await client.getContractEvents({ address: FACTORY, abi, eventName: "B20Created", fromBlock: from, toBlock: to }).catch(() => []); for (const l of logs) found.push({ token: l.args.token, name: l.args.name, symbol: l.args.symbol, decimals: l.args.decimals, block: Number(l.blockNumber) }); to = from - 1n; }
console.log("B20Created in last ~600k blocks:", found.length);
for (const f of found.slice(0, 40)) { let oracle = "-"; try { const r = await client.readContract({ address: "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD", abi: registryAbi, functionName: "getOracleParams", args: [f.token] }); oracle = String(r[0]) + (r[1] ? " paused" : ""); } catch { oracle = "ERR"; } console.log(" ", f.symbol.padEnd(8), (f.name||"").slice(0,32).padEnd(33), f.token, "dec", 0, "block", f.block, "oracle", oracle); }
