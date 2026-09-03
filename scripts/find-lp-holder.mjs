import { createPublicClient, http, parseAbi, parseAbiItem } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const NPM = "0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53";
const abi = parseAbi(["function positions(uint256) view returns (uint96, address, address, address, int24, int24, int24, uint128, uint256, uint256, uint128, uint128)", "function ownerOf(uint256) view returns (address)"]);
const stocks = new Set(["0xb20000000000000000000078ee7ce2fe4908108c", "0xb200000000000000000000c2e324d24d7eecd1fb", "0xb2000000000000000000002d0ba3164cc74f58b7", "0xb2000000000000000000008bc8786b856e61707c"]);
const latest = await client.getBlockNumber();
const ev = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const found = [];
for (let to = latest, i = 0; i < 8 && found.length < 3; i++) {
  const from = to - 4_999n;
  const logs = await client.getLogs({ address: NPM, event: ev, args: { from: "0x0000000000000000000000000000000000000000" }, fromBlock: from, toBlock: to }).catch(() => []);
  for (const l of logs.slice(-40)) {
    const p = await client.readContract({ address: NPM, abi, functionName: "positions", args: [l.args.tokenId] }).catch(() => null);
    if (p && (stocks.has(p[2].toLowerCase()) || stocks.has(p[3].toLowerCase())) && p[7] > 0n) { const owner = await client.readContract({ address: NPM, abi, functionName: "ownerOf", args: [l.args.tokenId] }).catch(() => null); if (owner) { found.push({ tokenId: String(l.args.tokenId), owner, token0: p[2], token1: p[3], ts: Number(p[4]), liq: String(p[7]) }); if (found.length >= 3) break; } }
  }
  to = from - 1n;
}
console.log(JSON.stringify(found, null, 1));
