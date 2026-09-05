#!/usr/bin/env bash
# Registers (or re-registers) every stock's Chainlink feed on the deployed AutoInvest, one transaction
# at a time with explicit nonces, skipping feeds that are already set. Idempotent; rerun any time a
# stock is added. Needs BASE_RPC_URL, PRIVATE_KEY (the contract owner) and NEXT_PUBLIC_AUTO_INVEST_ADDRESS in .env.
#
#   bash scripts/auto-invest-feeds.sh [app url, default http://localhost:3000]
set -euo pipefail
APP="${1:-http://localhost:3000}"
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1090
. <(sed 's/\r$//' .env)
set +a
: "${BASE_RPC_URL:?}"
: "${PRIVATE_KEY:?}"
ADDR="${NEXT_PUBLIC_AUTO_INVEST_ADDRESS:?NEXT_PUBLIC_AUTO_INVEST_ADDRESS missing in .env}"
OWNER=$(cast wallet address --private-key "$PRIVATE_KEY")
NONCE=$(cast nonce "$OWNER" --rpc-url "$BASE_RPC_URL")
lower() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

node -e 'fetch(process.argv[1]+"/api/assets").then(r=>r.json()).then(j=>{for(const a of j.assets){if(a.oracle&&a.oracle.feed)console.log(a.address,a.oracle.feed,a.underlying)}})' "$APP" > /tmp/auto-invest-feeds.txt
while read -r asset feed sym; do
  current=$(cast call "$ADDR" "feeds(address)(address)" "$asset" --rpc-url "$BASE_RPC_URL")
  if [ "$(lower "$current")" = "$(lower "$feed")" ]; then
    echo "  already set: $sym"
    continue
  fi
  if cast send "$ADDR" "setFeed(address,address)" "$asset" "$feed" --rpc-url "$BASE_RPC_URL" --private-key "$PRIVATE_KEY" --nonce "$NONCE" >/dev/null; then
    echo "  feed set:    $sym → $feed (nonce $NONCE)"
    NONCE=$((NONCE + 1))
  else
    echo "  FAILED:      $sym — rerun this script"
  fi
done < /tmp/auto-invest-feeds.txt
