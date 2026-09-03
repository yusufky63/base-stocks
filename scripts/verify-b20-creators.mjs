import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const FACTORY = "0xB20f000000000000000000000000000000000000";
const abi = parseAbi(["event B20Created(address indexed token, uint8 indexed variant, string name, string symbol, uint8 decimals, bytes variantEventParams)"]);
const regAbi = parseAbi(["function getOracleParams(address token) view returns (uint256 multiplier, bool paused)"]);
const curated = ["0xb200000000000000000000C2e324d24d7eEcd1fb","0xb200000000000000000000d9192b6B456483C2E8","0xb200000000000000000000c85a31389D71F3ecfb","0xB20000000000000000000019f6E7C675b73C2e4D","0xb2000000000000000000002D0BA3164cc74f58B7","0xB2000000000000000000004AFF16039bA04bdFBc","0xb2000000000000000000008bC8786B856E61707C","0xB200000000000000000000Ab99cFa739E253872B","0xb2000000000000000000004884b426556b92883d","0xb20000000000000000000078ee7ce2fE4908108C","0xb200000000000000000000397293Cb8cda9a10c5","0xb2000000000000000000007b9fcbd005511aCBd5","0xb2000000000000000000001e800a7f5189430cD0"];
const latest = await client.getBlockNumber();
const creators = new Map(); const copycats = [];
for (let to = latest, i = 0; i < 60; i++) { const from = to - 9_999n; if (from < 0n) break;
  const logs = await client.getContractEvents({ address: FACTORY, abi, eventName: "B20Created", fromBlock: from, toBlock: to }).catch(() => []);
  for (const l of logs) {
    const isCurated = curated.some((c) => c.toLowerCase() === l.args.token.toLowerCase());
    const sym = l.args.symbol || "";
    if (isCurated || /^[A-Z0-9.]{1,7}c$/.test(sym)) {
      const tx = await client.getTransaction({ hash: l.transactionHash });
      const rec = { token: l.args.token, symbol: sym, name: (l.args.name||"").slice(0,30), from: tx.from, to: tx.to, block: Number(l.blockNumber), curated: isCurated };
      if (isCurated) creators.set(tx.from.toLowerCase(), (creators.get(tx.from.toLowerCase()) ?? 0) + 1); else copycats.push(rec);
      if (isCurated) console.log("CURATED", sym.padEnd(7), l.args.token, "creator(tx.from)", tx.from, "tx.to", tx.to, "block", Number(l.blockNumber));
    }
  }
  to = from - 1n;
}
console.log("curated creators:", JSON.stringify([...creators.entries()]));
console.log("copycat-like tokens:", copycats.length);
for (const c of copycats.slice(0, 12)) { let reg = "?"; try { const r = await client.readContract({ address: "0x3f3E8cf41cdd3b1D118c16471aB0113DfDDd5CaD", abi: regAbi, functionName: "getOracleParams", args: [c.token] }); reg = String(r[0]); } catch { reg = "ERR"; } console.log("  ", c.symbol.padEnd(7), c.token, "from", c.from, "oracleMultiplier", reg, c.name); }
