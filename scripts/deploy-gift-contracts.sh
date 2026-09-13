#!/usr/bin/env bash
# Deploys the second version of both gift contracts to Base mainnet with the deployer key in .env,
# verifies them on Basescan and records the new GiftPool address in .env.
#
#   bash scripts/deploy-gift-contracts.sh
#
# Needs in .env: BASE_RPC_URL, PRIVATE_KEY (deployer, pays gas), optionally ETHERSCAN_API_KEY. Neither
# contract takes constructor arguments (each derives its EIP-712 domain from the chain id and its own
# address). The key is only ever handed to forge and cast, never echoed.
#
# Why a redeploy: both contracts are ownerless and cannot be upgraded, so a fix is a new address.
#   GiftEscrow v1 0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55 accepted the zero address as a claim
#                 recipient and let a spent claim key be created again (signature replay).
#   GiftPool   v1 0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10 left `withdraw` without its own
#                 reentrancy guard (harmless in practice, fixed by construction in v2).
# The old contracts keep paying out the gifts and pools that already live on them.
#
# Output: two lines on stdout, GIFT_ESCROW_ADDRESS=0x... and GIFT_POOL_ADDRESS=0x...; progress goes
# to stderr. Keep this file with LF line endings (Git Bash trips over CRLF).
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1090
. <(sed 's/\r$//' .env)
set +a
: "${BASE_RPC_URL:?BASE_RPC_URL missing in .env}"
: "${PRIVATE_KEY:?PRIVATE_KEY missing in .env}"

LEGACY_ESCROW=0x8D9fE4b3Ab9BecbE1181d15d51FB9724561C7f55
LEGACY_POOL=0xBD23ABB61D80B88DacB1Dc56DC2641e4Bfb76E10
DEPLOYER=$(cast wallet address --private-key "$PRIVATE_KEY")
TODAY=$(date -u +%Y-%m-%d)
echo "deployer $DEPLOYER" >&2

# deploy <src/File.sol:Contract>  (no constructor args) -> prints the new address on stdout
deploy() {
  local out addr
  # `|| true` so a failed broadcast reaches the diagnostics below instead of tripping `set -e` silently.
  out=$(cd contracts && forge create "$1" --rpc-url "$BASE_RPC_URL" --private-key "$PRIVATE_KEY" --broadcast 2>&1) || true
  echo "$out" | grep -E "Deployed to|Transaction hash" >&2 || true
  addr=$(echo "$out" | grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" | awk '{print $3}')
  if [ -z "$addr" ]; then
    echo "deployment of $1 failed:" >&2
    echo "$out" | tail -20 >&2
    exit 1
  fi
  echo "$addr"
}

echo ":: deploying GiftEscrow..." >&2
ESCROW=$(deploy src/GiftEscrow.sol:GiftEscrow)
echo ":: deploying GiftPool..." >&2
POOL=$(deploy src/GiftPool.sol:GiftPool)

# .env bookkeeping. The pool address is read by the app (NEXT_PUBLIC_GIFT_POOL_ADDRESS); the escrow
# address is a constant in src/lib/escrow/index.ts, so it is only noted here. Line endings follow
# whatever .env already uses, so a CRLF file does not end up mixed.
NL=$'\n'
if grep -q $'\r$' .env; then NL=$'\r\n'; fi
if grep -q "^NEXT_PUBLIC_GIFT_POOL_ADDRESS=" .env; then
  sed -i "s/^\(NEXT_PUBLIC_GIFT_POOL_ADDRESS=\)[0-9A-Za-z]*/\1$POOL/" .env
else
  printf '%s# GiftPool on Base mainnet (deployed %s by %s)%sNEXT_PUBLIC_GIFT_POOL_ADDRESS=%s%s' "$NL" "$TODAY" "$DEPLOYER" "$NL" "$POOL" "$NL" >> .env
fi
printf '# LEGACY_NOTE %s: GiftEscrow v1 %s superseded by %s (v1 keeps paying out its live gifts)%s' "$TODAY" "$LEGACY_ESCROW" "$ESCROW" "$NL" >> .env
printf '# LEGACY_NOTE %s: GiftPool v1 %s superseded by %s (v1 keeps paying out its live pools)%s' "$TODAY" "$LEGACY_POOL" "$POOL" "$NL" >> .env
echo "   .env updated: NEXT_PUBLIC_GIFT_POOL_ADDRESS=$POOL plus two LEGACY_NOTE lines" >&2

if [ -n "${ETHERSCAN_API_KEY:-}" ]; then
  echo ":: verifying on Basescan..." >&2
  (cd contracts && forge verify-contract "$ESCROW" src/GiftEscrow.sol:GiftEscrow --chain 8453 --etherscan-api-key "$ETHERSCAN_API_KEY" --watch) >&2 \
    || echo "   GiftEscrow verification did not go through; retry later: forge verify-contract $ESCROW src/GiftEscrow.sol:GiftEscrow --chain 8453 --watch" >&2
  (cd contracts && forge verify-contract "$POOL" src/GiftPool.sol:GiftPool --chain 8453 --etherscan-api-key "$ETHERSCAN_API_KEY" --watch) >&2 \
    || echo "   GiftPool verification did not go through; retry later: forge verify-contract $POOL src/GiftPool.sol:GiftPool --chain 8453 --watch" >&2
else
  echo "   ETHERSCAN_API_KEY not set: skipping Basescan verification" >&2
fi

echo "GIFT_ESCROW_ADDRESS=$ESCROW"
echo "GIFT_POOL_ADDRESS=$POOL"
{
  echo
  echo "next: point GIFT_ESCROW_ADDRESS in src/lib/escrow/index.ts at $ESCROW and regenerate the two ABIs;"
  echo "      set NEXT_PUBLIC_GIFT_POOL_ADDRESS=$POOL on Vercel and redeploy; note both addresses in docs/;"
  echo "      gifts and pools created on v1 stay claimable and reclaimable at the old addresses."
} >&2
