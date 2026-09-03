import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const assets = JSON.parse(await (await fetch("http://localhost:3000/api/assets")).text()).assets;
const POLICY = "0x8453000000000000000000000000000000000002";
const abi = parseAbi([
  "function policyId(bytes32) view returns (uint64)",
  "function isAuthorized(uint64 policyId, address account) view returns (bool)",
  "function paused(uint8 feature) view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
]);
const KYBER_ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const NVDA_CL_POOL = "0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9";
const RANDOM = "0x000000000000000000000000000000000000dEaD";
const ZERO32 = "0x" + "00".repeat(32);
for (const a of assets) {
  const out = { t: a.underlying };
  try { out.policyId = String(await client.readContract({ address: a.address, abi, functionName: "policyId", args: [ZERO32] })); } catch (e) { out.policyId = "ERR"; }
  try { out.transferPaused = await client.readContract({ address: a.address, abi, functionName: "paused", args: [0] }); } catch (e) { out.transferPaused = "ERR"; }
  try { const ts = await client.readContract({ address: a.address, abi, functionName: "totalSupply" }); out.supply = (Number(ts) / 1e8).toFixed(2); } catch (e) { out.supply = "ERR"; }
  const pid = out.policyId !== "ERR" ? BigInt(out.policyId) : 5n;
  for (const [k, addr] of Object.entries({ pool: NVDA_CL_POOL, kyber: KYBER_ROUTER, random: RANDOM })) {
    try { out["auth_" + k] = await client.readContract({ address: POLICY, abi, functionName: "isAuthorized", args: [pid, addr] }); } catch (e) { out["auth_" + k] = "ERR"; }
  }
  console.log(JSON.stringify(out));
}
