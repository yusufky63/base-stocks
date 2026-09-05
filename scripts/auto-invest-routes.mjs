#!/usr/bin/env node
/**
 * Prints what the AutoInvest deployment needs from the running app: the routers and approval
 * targets every recipient-capable provider returns for a small buy (the initial allow-list), and
 * one `setFeed` per live stock (the reference floor).
 *
 *   node scripts/auto-invest-routes.mjs http://localhost:3000 [contractAddress]
 *
 * With a contract address the feed lines come out as ready-made `cast send` commands.
 */
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const contract = process.argv[3];
const TAKER = "0x000000000000000000000000000000000000dEaD";
const PROVIDERS = ["kyber", "velora", "aerodrome", "okx"];

const assets = await fetch(`${base}/api/assets`).then((r) => r.json());
const live = assets.assets.filter((a) => a.status === "active" && BigInt(a.totalSupply ?? "0") > 0n);
const routers = new Map();
const spenders = new Map();

for (const a of live.slice(0, 3)) {
  for (const provider of PROVIDERS) {
    const res = await fetch(`${base}/api/trade/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ side: "buy", assetAddress: a.address, sellAmount: "1000000", taker: TAKER, recipient: TAKER, orders: false, provider, strictProvider: true }),
    });
    const q = await res.json().catch(() => null);
    if (!res.ok || !q?.transaction) continue;
    routers.set(q.transaction.to.toLowerCase(), `${provider} (${a.underlying})`);
    if (q.allowanceSpender) spenders.set(q.allowanceSpender.toLowerCase(), `${provider} (${a.underlying})`);
  }
}

console.log("# Routers (transaction.to) — pass as the 3rd constructor argument");
for (const [addr, via] of routers) console.log(`${addr}  # ${via}`);
console.log(`\n# Spenders (allowanceSpender) — pass as the 4th constructor argument`);
for (const [addr, via] of spenders) console.log(`${addr}  # ${via}`);
console.log(`\n# constructor arrays`);
console.log(`"[${[...routers.keys()].join(",")}]" "[${[...spenders.keys()].join(",")}]"`);
console.log(`\n# Reference feeds (one setFeed per live stock)`);
for (const a of live) {
  const feed = a.oracle?.feed;
  if (!feed) continue;
  if (contract) console.log(`cast send ${contract} "setFeed(address,address)" ${a.address} ${feed} --rpc-url $BASE_RPC_URL --private-key $PRIVATE_KEY  # ${a.underlying}`);
  else console.log(`${a.address} ${feed}  # ${a.underlying}`);
}
