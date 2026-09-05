#!/usr/bin/env bash
# Deploys AutoInvest to Base mainnet with the deployer key in .env, registers every stock's Chainlink
# feed, verifies the source on Basescan and records the address in .env.
#
#   bash scripts/auto-invest-deploy.sh [app url, default http://localhost:3000]
#
# Needs in .env: BASE_RPC_URL, PRIVATE_KEY (deployer, pays gas), AUTOMATION_KEEPER_KEY (the keeper's
# key; its address becomes the contract's keeper), optionally ETHERSCAN_API_KEY. Override the initial
# allow-list with AUTO_INVEST_ROUTERS / AUTO_INVEST_SPENDERS ("[0x…,0x…]") — the defaults are what
# `node scripts/auto-invest-routes.mjs` printed from live quotes on 2026-09-05.
set -euo pipefail
APP="${1:-http://localhost:3000}"
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1090
. <(sed 's/\r$//' .env)
set +a
: "${BASE_RPC_URL:?BASE_RPC_URL missing in .env}"
: "${PRIVATE_KEY:?PRIVATE_KEY missing in .env}"
: "${AUTOMATION_KEEPER_KEY:?AUTOMATION_KEEPER_KEY missing in .env (cast wallet new)}"

USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
KEEPER=$(node -e 'const {privateKeyToAccount}=require("viem/accounts");console.log(privateKeyToAccount(process.env.AUTOMATION_KEEPER_KEY).address)')
ROUTERS="${AUTO_INVEST_ROUTERS:-[0x6131b5fae19ea4f9d964eac0408e4408b66337b5,0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43,0x67d03631fe51b741c0c00c4e16eb662ac84381df]}"
SPENDERS="${AUTO_INVEST_SPENDERS:-[0x6131b5fae19ea4f9d964eac0408e4408b66337b5,0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43,0x57df6092665eb6058de53939612413ff4b09114e]}"
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "deployer $DEPLOYER · keeper $KEEPER"
echo "routers  $ROUTERS"
echo "spenders $SPENDERS"

echo "— deploying AutoInvest…"
OUT=$(cd contracts && forge create src/AutoInvest.sol:AutoInvest --rpc-url "$BASE_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --constructor-args "$USDC" "$KEEPER" "$ROUTERS" "$SPENDERS")
echo "$OUT" | grep -E "Deployed to|Transaction hash" || true
ADDR=$(echo "$OUT" | grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" | awk '{print $3}')
if [ -z "$ADDR" ]; then
  echo "deployment failed:"
  echo "$OUT" | tail -20
  exit 1
fi
if grep -q "^NEXT_PUBLIC_AUTO_INVEST_ADDRESS=" .env; then
  sed -i "s/^NEXT_PUBLIC_AUTO_INVEST_ADDRESS=.*/NEXT_PUBLIC_AUTO_INVEST_ADDRESS=$ADDR/" .env
else
  printf '\n# AutoInvest on Base mainnet (deployed %s by %s)\nNEXT_PUBLIC_AUTO_INVEST_ADDRESS=%s\n' "$(date -u +%Y-%m-%d)" "$DEPLOYER" "$ADDR" >> .env
fi

echo "— registering Chainlink feeds (one transaction per stock)…"
node -e 'fetch(process.argv[1]+"/api/assets").then(r=>r.json()).then(j=>{for(const a of j.assets){if(a.oracle&&a.oracle.feed)console.log(a.address,a.oracle.feed,a.underlying)}}).catch(e=>{console.error("could not read /api/assets from "+process.argv[1]+": "+e.message);process.exit(1)})' "$APP" |
  while read -r asset feed sym; do
    if cast send "$ADDR" "setFeed(address,address)" "$asset" "$feed" --rpc-url "$BASE_RPC_URL" --private-key "$PRIVATE_KEY" >/dev/null; then
      echo "  feed set: $sym → $feed"
    else
      echo "  feed FAILED: $sym (rerun: cast send $ADDR \"setFeed(address,address)\" $asset $feed …)"
    fi
  done

if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  echo "— verifying on Basescan…"
  ARGS=$(cast abi-encode "constructor(address,address,address[],address[])" "$USDC" "$KEEPER" "$ROUTERS" "$SPENDERS")
  (cd contracts && forge verify-contract "$ADDR" src/AutoInvest.sol:AutoInvest --chain 8453 --etherscan-api-key "$ETHERSCAN_API_KEY" --constructor-args "$ARGS" --watch) || echo "  verification did not go through; retry later with the same forge verify-contract command"
fi

echo
echo "AutoInvest deployed at $ADDR"
echo "next: fund the keeper $KEEPER with a little ETH; set NEXT_PUBLIC_AUTO_INVEST_ADDRESS and AUTOMATION_KEEPER_KEY on Vercel; add the CRON_SECRET secret on GitHub."
