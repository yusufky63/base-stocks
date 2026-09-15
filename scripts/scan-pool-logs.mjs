// Every GiftPool log about one pool, in order: created, legs, claims, cancel, withdrawals.
// Prints one line per event with block, time, tx hash and the sender of that transaction, so a
// "who closed this pool and when" question is answered from the chain rather than the database.
// Read-only; sends nothing. Scans both GiftPool deployments.
//
//   node scripts/scan-pool-logs.mjs <poolId(bytes32)> [fromBlock]
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const POOLS = ["0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10", "0x591d505C2bFa754122bBF04c0f5A601bDA8b6ed9"];
const [, , id, fromArg] = process.argv;
if (!id || !/^0x[0-9a-fA-F]{64}$/.test(id)) {
  console.error("usage: node scripts/scan-pool-logs.mjs <poolId(bytes32)> [fromBlock]");
  process.exit(1);
}
const abi = parseAbi([
  "event PoolCreated(bytes32 indexed id, address indexed creator, address gate, uint32 slots, uint64 expiry, uint64 lockedUntil, bytes32 memoRef)",
  "event PoolLeg(bytes32 indexed id, address indexed token, uint256 amountPerClaim)",
  "event PoolClaimed(bytes32 indexed id, address indexed recipient, uint32 index)",
  "event PoolCancelled(bytes32 indexed id, address indexed creator)",
  "event PoolWithdrawn(bytes32 indexed id, address indexed token, uint256 amount)",
]);
const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL || "https://mainnet.base.org") });
const head = await client.getBlockNumber();
let from = BigInt(fromArg ?? "50800000");
let step = 40_000n;
const found = [];
while (from <= head) {
  const to = from + step > head ? head : from + step;
  try {
    const logs = await client.getLogs({ address: POOLS, events: abi, args: { id }, fromBlock: from, toBlock: to });
    found.push(...logs);
    from = to + 1n;
  } catch (e) {
    if (step > 2_000n) { step /= 4n; continue; }
    throw e;
  }
}
found.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : Number(a.blockNumber - b.blockNumber)));
const blocks = new Map();
for (const l of found) {
  if (!blocks.has(l.blockNumber)) blocks.set(l.blockNumber, client.getBlock({ blockNumber: l.blockNumber }));
}
for (const l of found) {
  const b = await blocks.get(l.blockNumber);
  const tx = await client.getTransaction({ hash: l.transactionHash });
  const when = new Date(Number(b.timestamp) * 1000).toISOString();
  const args = Object.fromEntries(Object.entries(l.args).filter(([k]) => k !== "id").map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
  console.log(`${l.blockNumber} ${when} ${l.eventName.padEnd(13)} contract=${l.address} tx=${l.transactionHash} from=${tx.from} ${JSON.stringify(args)}`);
}
if (found.length === 0) console.log("no logs for this id on either GiftPool");
