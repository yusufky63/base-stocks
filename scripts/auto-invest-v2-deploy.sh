#!/usr/bin/env bash
# Deploys the second AutoInvest to Base mainnet with the deployer key in .env, registers every stock's
# Chainlink feed on it (one transaction per stock, explicit nonces) and verifies the source on Basescan.
#
#   bash scripts/auto-invest-v2-deploy.sh [app url, default https://basestocks.finance]
#
# Unlike auto-invest-deploy.sh this does NOT touch NEXT_PUBLIC_AUTO_INVEST_ADDRESS in .env: v1
# (0xc767844F2D65ba241DBe2c04f9c01d05cCD9b60E) keeps running the plans that exist on it until the app
# is switched over deliberately. The new address is printed on stdout as AUTO_INVEST_ADDRESS=0x...;
# progress goes to stderr.
#
# Needs in .env: BASE_RPC_URL, PRIVATE_KEY (deployer, pays gas, becomes the contract owner),
# AUTOMATION_KEEPER_KEY (its address becomes the keeper), optionally ETHERSCAN_API_KEY. Override the
# initial allow-list with AUTO_INVEST_ROUTERS / AUTO_INVEST_SPENDERS ("[0x...,0x...]"); the defaults are
# the routes v1 was deployed with (`node scripts/auto-invest-routes.mjs`, live quotes of 2026-09-05).
# Keys are only ever handed to forge, cast and viem, never echoed.
#
# Why v2: quoteFloor divided by the B20 multiplier although the Coinbase feeds are total-return (USD per
# raw token), so the floor would have gone loose by the multiplier after the first split; and a leg
# whose stock has a feed registered now refuses to run while that feed is unusable (FloorUnavailable)
# instead of letting the keeper's minOut decide alone.
# Keep this file with LF line endings (Git Bash trips over CRLF).
set -euo pipefail
APP="${1:-https://basestocks.finance}"
APP="${APP%/}"
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
echo "deployer $DEPLOYER (owner) / keeper $KEEPER" >&2
echo "routers  $ROUTERS" >&2
echo "spenders $SPENDERS" >&2

# Read the feed list before spending any gas, so an unreachable app cannot leave a deployment behind
# with no floors registered.
FEEDS=$(mktemp)
trap 'rm -f "$FEEDS"' EXIT
node -e 'fetch(process.argv[1]+"/api/assets").then(r=>{if(!r.ok)throw new Error("HTTP "+r.status);return r.json()}).then(j=>{for(const a of j.assets){if(a.oracle&&a.oracle.feed)console.log(a.address,a.oracle.feed,a.underlying)}}).catch(e=>{console.error("could not read /api/assets from "+process.argv[1]+": "+e.message);process.exit(1)})' "$APP" > "$FEEDS"
FEED_COUNT=$(grep -c . "$FEEDS" || true)
if [ "$FEED_COUNT" -eq 0 ]; then
  echo "no stock with a Chainlink feed in $APP/api/assets; refusing to deploy a floorless contract" >&2
  exit 1
fi
echo "feeds    $FEED_COUNT stocks from $APP/api/assets (13 as of 2026-09-13)" >&2

echo ":: deploying AutoInvest v2..." >&2
# `|| true` so a failed broadcast reaches the diagnostics below instead of tripping `set -e` silently.
OUT=$(cd contracts && forge create src/AutoInvest.sol:AutoInvest --rpc-url "$BASE_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast --constructor-args "$USDC" "$KEEPER" "$ROUTERS" "$SPENDERS" 2>&1) || true
echo "$OUT" | grep -E "Deployed to|Transaction hash" >&2 || true
ADDR=$(echo "$OUT" | grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" | awk '{print $3}')
if [ -z "$ADDR" ]; then
  echo "deployment failed:" >&2
  echo "$OUT" | tail -20 >&2
  exit 1
fi

echo ":: registering Chainlink feeds (explicit nonces, one transaction per stock)..." >&2
NONCE=$(cast nonce "$DEPLOYER" --rpc-url "$BASE_RPC_URL")
FAILED=0
while read -r asset feed sym; do
  [ -n "$asset" ] || continue
  if cast send "$ADDR" "setFeed(address,address)" "$asset" "$feed" --rpc-url "$BASE_RPC_URL" --private-key "$PRIVATE_KEY" --nonce "$NONCE" >/dev/null; then
    echo "   feed set: $sym -> $feed (nonce $NONCE)" >&2
    NONCE=$((NONCE + 1))
  else
    echo "   feed FAILED: $sym (rerun later: NEXT_PUBLIC_AUTO_INVEST_ADDRESS=$ADDR bash scripts/auto-invest-feeds.sh $APP)" >&2
    FAILED=$((FAILED + 1))
  fi
done < "$FEEDS"
if [ "$FAILED" -ne 0 ]; then
  echo "   $FAILED feed(s) not registered; auto-invest-feeds.sh is idempotent, rerun it against $ADDR" >&2
fi

if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  echo ":: verifying on Basescan..." >&2
  ARGS=$(cast abi-encode "constructor(address,address,address[],address[])" "$USDC" "$KEEPER" "$ROUTERS" "$SPENDERS")
  (cd contracts && forge verify-contract "$ADDR" src/AutoInvest.sol:AutoInvest --chain 8453 --etherscan-api-key "$ETHERSCAN_API_KEY" --constructor-args "$ARGS" --watch) >&2 \
    || echo "   verification did not go through; retry later with the same forge verify-contract command" >&2
else
  echo "   ETHERSCAN_API_KEY not set: skipping Basescan verification" >&2
fi

echo "AUTO_INVEST_ADDRESS=$ADDR"
{
  echo
  echo "next: dry-run it on mainnet state (SIMULATE_MAINNET=1, see docs/AUTO_INVEST.md); when the app is ready,"
  echo "      set NEXT_PUBLIC_AUTO_INVEST_ADDRESS=$ADDR in .env and on Vercel and redeploy. Plans do not migrate:"
  echo "      v1 at 0xc767844F2D65ba241DBe2c04f9c01d05cCD9b60E keeps serving its plans, new plans land on v2."
  echo "      .env was not changed by this script."
} >&2
