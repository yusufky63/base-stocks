// Which transaction created which claim-link gift, straight from GiftEscrow's `GiftCreated` logs.
// Prints one line per gift id: `<escrowId> <txHash> <block> <escrow>`. Read-only; sends nothing.
//
//   node scripts/scan-gift-created.mjs <fromBlock> [escrowId ...]
//
// Used once (2026-09-05) to repair ten gift rows that had been stamped with the same hash by a
// non-atomic batch; the timeline and the statistics need each deposit's own transaction.
import { readFileSync } from "node:fs";
import { createPublicClient, http, parseAbiItem } from "viem";
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

// Every escrow that has ever held gifts: V1 (2026-09-03) and V2 (2026-09-13).
const ESCROWS = ["0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55", "0x59E4C2C5AfbDae22A09566EB69f283c7f884EB23"];
const [, , fromArg, ...ids] = process.argv;
if (!fromArg) {
  console.error("usage: node scripts/scan-gift-created.mjs <fromBlock> [escrowId ...]");
  process.exit(1);
}
const client = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL || "https://mainnet.base.org") });
const head = await client.getBlockNumber();
const event = parseAbiItem("event GiftCreated(bytes32 indexed id, address indexed sender, address indexed token, uint256 amount, uint64 expiry, bytes32 memoRef)");
const wanted = new Set(ids.map((x) => x.toLowerCase()));
let from = BigInt(fromArg);
const STEP = 10_000n;
while (from <= head) {
  const to = from + STEP > head ? head : from + STEP;
  const logs = await client.getLogs({ address: ESCROWS, event, fromBlock: from, toBlock: to });
  for (const log of logs) {
    const id = log.args.id.toLowerCase();
    if (wanted.size > 0 && !wanted.has(id)) continue;
    console.log(id, log.transactionHash, log.blockNumber.toString(), log.address);
  }
  from = to + 1n;
}
