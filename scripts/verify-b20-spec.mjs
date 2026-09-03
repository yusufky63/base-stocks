import { createPublicClient, http, parseAbi } from "viem";
import { base } from "viem/chains";
const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const abi = parseAbi([
  "function contractURI() view returns (string)",
  "function extraMetadata(string key) view returns (string)",
  "function multiplier() view returns (uint256)",
  "function supplyCap() view returns (uint128)",
  "function name() view returns (string)",
  "function symbol() view returns (string)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)", "function description() view returns (string)"]);
for (const fn of ["name", "symbol", "contractURI", "multiplier"]) { try { console.log(fn, String(await client.readContract({ address: NVDA, abi, functionName: fn }))); } catch (e) { console.log(fn, "ERR", e.shortMessage || e.message); } }
for (const key of ["ISIN", "isin", "CUSIP", "cusip", "underlying", "ticker", "issuer", "prospectus", "website"]) { try { const v = await client.readContract({ address: NVDA, abi, functionName: "extraMetadata", args: [key] }); console.log("extraMetadata", key, "=", JSON.stringify(v)); } catch (e) { console.log("extraMetadata", key, "ERR", (e.shortMessage || e.message).slice(0, 80)); } }
const feeds = { NVDA: "0x04689a41629776563E6822F76f2e57D148d28513", AAPL: "0x787f13dEa48Db0897CbCDD985de77809D837F988", COIN: "0x408e44f504A7371a345F03a73dDC96A4b48e8aa7", TSLA: "0xFaf869185383a24F8cb00e27BdA6b63B9905DCb4" };
const now = Math.floor(Date.now() / 1000);
for (const [t, f] of Object.entries(feeds)) {
  const [d, r] = await Promise.all([client.readContract({ address: f, abi: feedAbi, functionName: "description" }), client.readContract({ address: f, abi: feedAbi, functionName: "latestRoundData" })]);
  console.log(t, d, "answer", (Number(r[1]) / 1e8).toFixed(2), "updatedAt age(min)", ((now - Number(r[3])) / 60).toFixed(0), "roundId", String(r[0]));
}
