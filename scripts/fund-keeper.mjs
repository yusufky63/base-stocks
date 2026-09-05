#!/usr/bin/env node
/**
 * Send a little ETH from the deployer wallet (.env PRIVATE_KEY) to the AutoInvest keeper so it can
 * pay gas for plan runs. Works from PowerShell, cmd or bash — no cast, no shell tricks.
 *
 *   node scripts/fund-keeper.mjs            # shows balances, sends nothing
 *   node scripts/fund-keeper.mjs 0.002      # sends 0.002 ETH to the keeper and waits for the receipt
 *
 * The keeper address is derived from AUTOMATION_KEEPER_KEY in .env (the key itself is never printed).
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);
const need = (k) => {
  if (!env[k]) {
    console.error(`${k} is missing in .env`);
    process.exit(1);
  }
  return env[k];
};

/** cast accepts a bare 64-hex key; viem wants the 0x prefix. */
const hexKey = (v) => (v.startsWith("0x") ? v : `0x${v}`);
const rpc = need("BASE_RPC_URL");
const deployer = privateKeyToAccount(hexKey(need("PRIVATE_KEY")));
const keeper = privateKeyToAccount(hexKey(need("AUTOMATION_KEEPER_KEY"))).address;
const amount = process.argv[2];
const client = createPublicClient({ chain: base, transport: http(rpc) });

const show = async (label) => {
  const [d, k] = await Promise.all([client.getBalance({ address: deployer.address }), client.getBalance({ address: keeper })]);
  console.log(`${label}\n  deployer ${deployer.address}: ${formatEther(d)} ETH\n  keeper   ${keeper}: ${formatEther(k)} ETH`);
};

// No process.exit on the happy path: on Windows, exiting while the RPC socket is still closing
// prints a libuv assertion that looks like a failure and is not one.
async function main() {
  await show("Balances");
  if (!amount) {
    console.log("\nNothing sent. Pass an amount to fund the keeper, e.g.  node scripts/fund-keeper.mjs 0.002");
    return;
  }
  const value = parseEther(amount);
  const wallet = createWalletClient({ account: deployer, chain: base, transport: http(rpc) });
  console.log(`\nSending ${amount} ETH to the keeper…`);
  const hash = await wallet.sendTransaction({ to: keeper, value });
  console.log(`  tx ${hash}\n  https://basescan.org/tx/${hash}`);
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`  ${receipt.status === "success" ? "confirmed" : "FAILED"} in block ${receipt.blockNumber}`);
  await show("\nBalances after");
}

await main();
