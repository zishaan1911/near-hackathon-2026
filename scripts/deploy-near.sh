#!/usr/bin/env bash
#
# Deploys contracts/near/silica (and optionally contracts/near/mock-ft as the
# collateral token), initialises it and creates the SCI-1H market.
#
#   OWNER_ID=me.testnet CONTRACT_ID=silica.me.testnet TOKEN_ID=tusdc.me.testnet \
#   PUBLISHER_ID=pub.me.testnet \
#   DEPLOY_MOCK_TOKEN=true ./scripts/deploy-near.sh
#
# Environment:
#   NEAR_NETWORK        testnet (default) | mainnet
#   OWNER_ID            account that owns the contract; must already be in the
#                       near CLI keychain and hold enough NEAR to fund the rest
#   CONTRACT_ID         Silica contract account (created if missing)
#   TOKEN_ID            collateral token account (created if missing and
#                       DEPLOY_MOCK_TOKEN=true; otherwise an existing NEP-141)
#   PUBLISHER_ID        account allowed to call update_price (the cron tick signs
#                       as this account; match_orders is permissionless)
#   DEPLOY_MOCK_TOKEN   true to build and deploy contracts/near/mock-ft
#   SILICA_WASM / TOKEN_WASM  paths to prebuilt wasm files (skips cargo-near)
#   TOKEN_FUNDING / CONTRACT_FUNDING  NEAR for newly created accounts
#   MARKET_EXPIRY_MS    override the expiry (default: next full hour)
#   MAX_STALENESS_MS    oracle staleness bound (default 120000)
#   MAX_PRICE           oracle price ceiling (default 1000, the index scale)
#
# Requires: near-cli-rs (the `near` binary, v0.17 or newer), cargo-near
# (`cargo install cargo-near`) and a Rust toolchain with wasm32-unknown-unknown.
# The script never prints keys; signing uses the CLI keychain.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NEAR_NETWORK="${NEAR_NETWORK:-testnet}"
DEPLOY_MOCK_TOKEN="${DEPLOY_MOCK_TOKEN:-false}"
MAX_STALENESS_MS="${MAX_STALENESS_MS:-120000}"
MAX_PRICE="${MAX_PRICE:-1000}"

# Market economics: notional = price * quantity * multiplier, and the margin
# is margin_bps of that (see docs/near-abi.md).
UNDERLYING="SCI-1H"
MULTIPLIER=10000
TICK=1
MARGIN_BPS=1000

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

for var in OWNER_ID CONTRACT_ID TOKEN_ID PUBLISHER_ID; do
  [ -n "${!var:-}" ] || die "$var is required"
done
command -v near  >/dev/null 2>&1 || die "near CLI (near-cli-rs) not found. Install: https://github.com/near/near-cli-rs"
if [ -z "${SILICA_WASM:-}" ] || { [ "$DEPLOY_MOCK_TOKEN" = "true" ] && [ -z "${TOKEN_WASM:-}" ]; }; then
  cargo near --version >/dev/null 2>&1 || die "cargo-near not found. Install it, or set SILICA_WASM / TOKEN_WASM to prebuilt wasm files"
fi

if [ "$NEAR_NETWORK" = "mainnet" ] && [ "${ALLOW_MAINNET:-}" != "true" ]; then
  die "NEAR_NETWORK is mainnet; re-run with ALLOW_MAINNET=true if you mean it."
fi

account_exists() {   # account id
  near account view-account-summary "$1" network-config "$NEAR_NETWORK" now >/dev/null 2>&1
}

# call <contract> <method> <json> <gas> <deposit> -- change call signed by the owner.
call() {
  near contract call-function as-transaction "$1" "$2" json-args "$3" \
    prepaid-gas "$4" attached-deposit "$5" \
    sign-as "$OWNER_ID" network-config "$NEAR_NETWORK" sign-with-keychain send >/dev/null
}

# build_wasm <crate dir> -- prints the path of the built wasm.
build_wasm() {
  local dir="$1"
  ( cd "$dir" && cargo near build non-reproducible-wasm ) >&2
  local wasm
  wasm="$(ls -t "$dir"/target/near/*.wasm 2>/dev/null | head -n1 || true)"
  [ -n "$wasm" ] || die "no wasm found under $dir/target/near after build"
  echo "$wasm"
}

# create_account <id> <NEAR amount> -- skipped when the account exists.
create_account() {
  if account_exists "$1"; then
    ok "account exists: $1"
    return
  fi
  near account create-account fund-myself "$1" "$2" autogenerate-new-keypair save-to-keychain \
    sign-as "$OWNER_ID" network-config "$NEAR_NETWORK" sign-with-keychain send >/dev/null
  ok "account created: $1"
}

# deploy <id> <wasm> <init method> <json args> -- deploys with an init call.
deploy() {
  near contract deploy "$1" use-file "$2" with-init-call "$3" json-args "$4" \
    prepaid-gas '100 Tgas' attached-deposit '0 NEAR' \
    network-config "$NEAR_NETWORK" sign-with-keychain send >/dev/null
}

# ---------------------------------------------------------------------------
say "Network: $NEAR_NETWORK, owner: $OWNER_ID"
# ---------------------------------------------------------------------------

account_exists "$OWNER_ID" || die "owner account $OWNER_ID not found on $NEAR_NETWORK"

# ---------------------------------------------------------------------------
say "Collateral token"
# ---------------------------------------------------------------------------

if [ "$DEPLOY_MOCK_TOKEN" = "true" ]; then
  if account_exists "$TOKEN_ID" && near contract call-function as-read-only "$TOKEN_ID" ft_metadata \
      json-args '{}' network-config "$NEAR_NETWORK" now >/dev/null 2>&1; then
    ok "mock token already deployed at $TOKEN_ID"
  else
    TOKEN_WASM="${TOKEN_WASM:-$(build_wasm "$REPO_ROOT/contracts/near/mock-ft")}"
    ok "built $TOKEN_WASM"
    create_account "$TOKEN_ID" "${TOKEN_FUNDING:-5 NEAR}"
    # mock-ft's `new` takes no arguments; balances come from its public faucet.
    deploy "$TOKEN_ID" "$TOKEN_WASM" new '{}'
    ok "mock token deployed: $TOKEN_ID"
  fi
else
  ok "using existing token: $TOKEN_ID"
fi

# ---------------------------------------------------------------------------
say "Silica contract"
# ---------------------------------------------------------------------------

if account_exists "$CONTRACT_ID" && near contract call-function as-read-only "$CONTRACT_ID" get_oracle \
    json-args '{}' network-config "$NEAR_NETWORK" now >/dev/null 2>&1; then
  ok "contract already initialised at $CONTRACT_ID (skipping deploy and new)"
else
  SILICA_WASM="${SILICA_WASM:-$(build_wasm "$REPO_ROOT/contracts/near/silica")}"
  ok "built $SILICA_WASM"
  create_account "$CONTRACT_ID" "${CONTRACT_FUNDING:-10 NEAR}"
  deploy "$CONTRACT_ID" "$SILICA_WASM" new \
    "{\"owner\":\"$OWNER_ID\",\"collateral_token\":\"$TOKEN_ID\",\"publisher\":\"$PUBLISHER_ID\",\"max_staleness_ms\":$MAX_STALENESS_MS,\"max_price\":$MAX_PRICE}"
  ok "contract deployed and initialised: $CONTRACT_ID"
fi

# ---------------------------------------------------------------------------
say "Registering the contract on the token"
# ---------------------------------------------------------------------------

# storage_deposit is idempotent on NEP-145 tokens (registration_only avoids
# refund churn). 0.00125 NEAR is the usual minimum balance.
call "$TOKEN_ID" storage_deposit \
  "{\"account_id\":\"$CONTRACT_ID\",\"registration_only\":true}" '30 Tgas' '0.00125 NEAR'
ok "$CONTRACT_ID registered on $TOKEN_ID"

# ---------------------------------------------------------------------------
say "Creating the $UNDERLYING market"
# ---------------------------------------------------------------------------

EXPIRY_MS="${MARKET_EXPIRY_MS:-$(( ($(date +%s) / 3600 + 1) * 3600 * 1000 ))}"

CURRENT_MARKET="$(near contract call-function as-read-only "$CONTRACT_ID" get_market \
  json-args '{}' network-config "$NEAR_NETWORK" now 2>/dev/null || true)"
if echo "$CURRENT_MARKET" | grep -q "\"underlying\"" && echo "$CURRENT_MARKET" | grep -q "\"settled\": false"; then
  ok "an unsettled market already exists; not creating another"
else
  call "$CONTRACT_ID" create_market \
    "{\"underlying\":\"$UNDERLYING\",\"expiry_ms\":$EXPIRY_MS,\"contract_multiplier\":$MULTIPLIER,\"tick_size\":$TICK,\"margin_ratio_bps\":$MARGIN_BPS}" \
    '30 Tgas' '0 NEAR'
  ok "market created, expires at $EXPIRY_MS ms"
fi

# ---------------------------------------------------------------------------
say "Done"
# ---------------------------------------------------------------------------

cat <<EOF

Put these in .env / the Vercel environment (the publisher's private key is NOT
written here; take it from the near CLI keychain and set it yourself, e.g. with
scripts/setup-vercel-secrets.ps1):

SILICA_NEAR_NETWORK=$NEAR_NETWORK
SILICA_NEAR_CONTRACT_ID=$CONTRACT_ID
SILICA_NEAR_COLLATERAL_TOKEN=$TOKEN_ID
SILICA_NEAR_DEV_MARKET=false
SILICA_NEAR_PUBLISHER_ACCOUNT_ID=$PUBLISHER_ID
SILICA_NEAR_PUBLISHER_PRIVATE_KEY=<publisher key>
CRON_SECRET=<shared secret>

The cron tick (publish, settle, roll, match) then runs from /api/v1/cron/tick.

EOF