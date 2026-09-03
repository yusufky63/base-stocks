import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const npmAbi = parseAbi(["function factory() view returns (address)", "function name() view returns (string)", "function totalSupply() view returns (uint256)"]);
// Candidates
for (const [label, addr] of Object.entries({ "uniswap-v3-npm": "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1", "aero-slipstream-npm(legacy?)": "0x827922686190790b37229fd06084350E74485b72" })) {
  const out = { label, addr };
  for (const fn of ["factory", "name", "totalSupply"]) { try { out[fn] = String(await client.readContract({ address: addr, abi: npmAbi, functionName: fn })); } catch (e) { out[fn] = "ERR"; } }
  console.log(JSON.stringify(out));
}
// Discover the NPM used by the deep NVDAc/USDC Slipstream pool from its Mint events (owner = position manager)
const POOL = "0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9";
const latest = await client.getBlockNumber();
const mintEvent = parseAbiItem("event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)");
const owners = new Map();
for (let to = latest, i = 0; i < 6 && to > 0n; i++) { const from = to - 9_999n; const logs = await client.getLogs({ address: POOL, event: mintEvent, fromBlock: from, toBlock: to }).catch(() => []); for (const l of logs) owners.set(l.args.owner, (owners.get(l.args.owner) ?? 0) + 1); to = from - 1n; }
console.log("Mint owners (NPM candidates):", JSON.stringify([...owners.entries()]));
for (const [addr] of owners) { try { const f = await client.readContract({ address: addr, abi: npmAbi, functionName: "factory" }); const n = await client.readContract({ address: addr, abi: npmAbi, functionName: "name" }).catch(() => "?"); console.log("candidate", addr, "factory", f, "name", n); } catch { console.log("candidate", addr, "no factory()"); } }
