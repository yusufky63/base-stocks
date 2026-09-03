// CoW Protocol order book on Base: quote shapes, appData registration, validity ceiling.
// Read-only; nothing is signed or sent. Run: node scripts/verify-cow.mjs
import { keccak256, toHex } from "viem";

const API = "https://api.cow.fi/base/api/v1";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NVDA = "0xb20000000000000000000078ee7ce2fE4908108C";
const FROM = "0x1111111111111111111111111111111111111111";

const doc = JSON.stringify({ version: "1.3.0", appCode: "BStocks", metadata: { orderClass: { orderClass: "market" }, quote: { slippageBips: 100 } } });
const hash = keccak256(toHex(doc));

async function call(method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data };
}

console.log("version", (await call("GET", "/version")).data);
console.log("app_data PUT", (await call("PUT", `/app_data/${hash}`, { fullAppData: doc })).status, hash);

for (const [label, sellToken, buyToken, amount] of [
  ["buy NVDA with 10 USDC", USDC, NVDA, "10000000"],
  ["sell 0.04 NVDA", NVDA, USDC, "4000000"],
]) {
  const { status, data } = await call("POST", "/quote", { sellToken, buyToken, from: FROM, kind: "sell", sellAmountBeforeFee: amount, validFor: 1800, appData: doc, appDataHash: hash, priceQuality: "optimal", timeout: 2500 });
  if (status !== 200) console.log(label, "->", status, data?.errorType, data?.description);
  else console.log(label, "-> sell", data.quote.sellAmount, "+ fee", data.quote.feeAmount, "→ buy", data.quote.buyAmount, "| id", data.id, "verified", data.verified, "protocolFeeBps", data.protocolFeeBps);
}

for (const hours of [3, 6]) {
  const { status, data } = await call("POST", "/quote", { sellToken: USDC, buyToken: NVDA, from: FROM, kind: "sell", sellAmountBeforeFee: "10000000", validFor: hours * 3600, priceQuality: "fast" });
  console.log(`validFor ${hours}h ->`, status, status === 400 ? data?.errorType : "ok");
}

const eth = await call("POST", "/quote", { sellToken: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", buyToken: NVDA, from: FROM, kind: "sell", sellAmountBeforeFee: "1000000000000000", validFor: 1800 });
console.log("native ETH sell ->", eth.status, eth.data?.errorType);
