import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const FACTORY = "0xB20f000000000000000000000000000000000000";
const latest = await client.getBlockNumber();
const topics = new Map(); let total = 0; let sample = null;
for (let to = latest, i = 0; i < 70; i++) { const from = to - 9_999n; if (from < 0n) break; const logs = await client.getLogs({ address: FACTORY, fromBlock: from, toBlock: to }).catch(() => []); for (const l of logs) { total++; const t = l.topics[0]; topics.set(t, (topics.get(t) ?? 0) + 1); if (!sample) sample = l; } to = from - 1n; }
console.log("factory logs in last ~700k blocks:", total);
for (const [t, n] of topics) console.log(" topic0", t, "count", n);
if (sample) console.log("sample:", JSON.stringify({ block: String(sample.blockNumber), topics: sample.topics, data: sample.data.slice(0, 200) }));
