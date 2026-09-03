import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const assets = JSON.parse(await (await fetch("http://localhost:3000/api/assets")).text()).assets;
const abi = parseAbi(["function totalSupply() view returns (uint256)", "function supplyCap() view returns (uint128)", "function pausedFeatures() view returns (uint8[])", "function isPaused(uint8) view returns (bool)"]);
const FEAT = ["TRANSFER", "MINT", "BURN", "SEIZE"];
for (const a of assets) {
  const [ts, cap, pf] = await Promise.all([
    client.readContract({ address: a.address, abi, functionName: "totalSupply" }).catch(() => null),
    client.readContract({ address: a.address, abi, functionName: "supplyCap" }).catch(() => null),
    client.readContract({ address: a.address, abi, functionName: "pausedFeatures" }).catch(() => null),
  ]);
  console.log(a.underlying.padEnd(6), "supply=" + (ts === null ? "ERR" : (Number(ts) / 1e8).toFixed(2)), "cap=" + (cap === null ? "ERR" : cap === 0n ? "0 (unlimited?)" : (Number(cap) / 1e8).toFixed(0)), "paused=" + (pf === null ? "ERR" : pf.length ? pf.map((f) => FEAT[f] ?? f).join(",") : "none"), "senderPolicy=" + a.transferSenderPolicyId, "receiverPolicy=" + a.transferReceiverPolicyId);
}
