import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const FACTORY = "0xB20f000000000000000000000000000000000000";
const abi = parseAbi(["event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)"]);
const curated = ["0xb200000000000000000000C2e324d24d7eEcd1fb","0xb200000000000000000000d9192b6B456483C2E8","0xb200000000000000000000c85a31389D71F3ecfb","0xB20000000000000000000019f6E7C675b73C2e4D","0xb2000000000000000000002D0BA3164cc74f58B7","0xB2000000000000000000004AFF16039bA04bdFBc","0xb2000000000000000000008bC8786B856E61707C","0xB200000000000000000000Ab99cFa739E253872B","0xb2000000000000000000004884b426556b92883d","0xb20000000000000000000078ee7ce2fE4908108C","0xb200000000000000000000397293Cb8cda9a10c5","0xb2000000000000000000007b9fcbd005511aCBd5","0xb2000000000000000000001e800a7f5189430cD0"];
const latest = await client.getBlockNumber();
let chunk = 100_000n; const found = [];
for (let to = latest; to > 0n && found.length < curated.length; ) {
  const from = to - chunk + 1n > 0n ? to - chunk + 1n : 0n;
  try {
    const logs = await client.getContractEvents({ address: FACTORY, abi, eventName: "B20Created", args: { token: curated }, fromBlock: from, toBlock: to });
    for (const l of logs) { const tx = await client.getTransaction({ hash: l.transactionHash }); found.push({ symbol: l.args.symbol, token: l.args.token, block: Number(l.blockNumber), from: tx.from, to: tx.to }); }
    to = from - 1n;
  } catch (e) { if (chunk > 10_000n) { chunk = chunk / 10n; continue; } console.log("range error at", String(to), e.shortMessage || e.message); break; }
  if (latest - to > 3_000_000n) break;
}
console.log("found", found.length);
for (const f of found) console.log(" ", f.symbol.padEnd(7), f.token, "block", f.block, "from", f.from, "to", f.to);
const froms = new Set(found.map((f) => f.from.toLowerCase())); console.log("distinct creators:", [...froms].join(", "));
