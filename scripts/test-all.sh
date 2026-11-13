#!/usr/bin/env bash
# Runs all test suites, or one selected suite:
#   - contracts/near          (Rust, cargo test)
#   - blockchain/near         (TypeScript)
#   - server                  (TypeScript)
#   - frontend                (TypeScript)
#
# Usage:
#   ./scripts/test-all.sh
#   ./scripts/test-all.sh all
#   ./scripts/test-all.sh typescript
#   ./scripts/test-all.sh frontend
#   ./scripts/test-all.sh contracts
#
# Requires: cargo (Rust) and Node.js >= 18 + npm for the TypeScript stacks.
#
# server/ depends on blockchain/near being built first (its dist/ must
# exist), so the TypeScript suite builds it first.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELECTED_SUITE="${1:-all}"
FAILED=0

usage() {
  echo "Usage: ./scripts/test-all.sh [all|typescript|frontend|contracts]"
}

case "$SELECTED_SUITE" in
  all|typescript|frontend|contracts)
    ;;
  *)
    echo "Unknown test suite: $SELECTED_SUITE"
    usage
    exit 2
    ;;
esac

run_contracts() {
  local failed=0
  local crate
  for crate in contracts/near/silica contracts/near/mock-ft; do
    echo
    echo "==> $crate (Rust)"
    if ! command -v cargo >/dev/null 2>&1; then
      echo "!! cargo not found on PATH — skipping contract tests"
      return 1
    fi
    if (cd "$REPO_ROOT/$crate" && cargo test); then
      echo "-- $crate tests passed"
    else
      echo "!! $crate tests FAILED"
      failed=1
    fi
  done
  return "$failed"
}

install_node_dependencies() {
  local project_dir="$1"

  if [ "${CI:-}" = "true" ]; then
    (
      cd "$project_dir" &&
      npm ci
    )
  elif [ ! -d "$project_dir/node_modules" ]; then
    echo "-- node_modules missing, running npm install first"
    (
      cd "$project_dir" &&
      npm install
    )
  fi
}

run_ts_project() {
  local project_path="$1"
  local project_name="$2"
  local should_build="$3"
  local project_dir="$REPO_ROOT/$project_path"

  echo
  echo "==> $project_path (TypeScript)"

  if ! install_node_dependencies "$project_dir"; then
    echo "!! $project_name dependency installation FAILED"
    return 1
  fi

  if [ "$should_build" = "true" ]; then
    if (
      cd "$project_dir" &&
      npm run typecheck &&
      npm run build &&
      npm test
    ); then
      echo "-- $project_name tests passed"
      return 0
    fi
  else
    if (
      cd "$project_dir" &&
      npm run typecheck &&
      npm test
    ); then
      echo "-- $project_name tests passed"
      return 0
    fi
  fi

  echo "!! $project_name tests FAILED"
  return 1
}

run_typescript() {
  local typescript_failed=0

  if ! command -v npm >/dev/null 2>&1; then
    echo "!! npm not found on PATH — skipping TypeScript tests"
    echo "   Node.js >= 18 and npm are required."
    return 1
  fi

  # Build the adapter first because the server imports its dist output.
  if ! run_ts_project \
    "blockchain/near" \
    "NEAR adapter" \
    "true"; then
    typescript_failed=1
  fi

  if ! run_ts_project \
    "server" \
    "API server" \
    "false"; then
    typescript_failed=1
  fi

  return "$typescript_failed"
}

run_frontend() {
  if ! command -v npm >/dev/null 2>&1; then
    echo "!! npm not found on PATH — skipping frontend tests"
    echo "   Node.js >= 18 and npm are required."
    return 1
  fi

  if [ ! -f "$REPO_ROOT/frontend/package.json" ]; then
    echo "!! frontend/package.json not found"
    return 1
  fi

  run_ts_project \
    "frontend" \
    "Frontend" \
    "false"
}

run_and_record() {
  if ! "$@"; then
    FAILED=1
  fi
}

case "$SELECTED_SUITE" in
  all)
    run_and_record run_contracts
    run_and_record run_typescript
    run_and_record run_frontend
    ;;
  contracts)
    run_and_record run_contracts
    ;;
  typescript)
    run_and_record run_typescript
    ;;
  frontend)
    run_and_record run_frontend
    ;;
esac

echo

if [ "$FAILED" -eq 0 ]; then
  echo "ALL REQUESTED SUITES PASSED"
else
  echo "ONE OR MORE REQUESTED SUITES FAILED — see output above"
fi

exit "$FAILED"
