#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null
command -v cargo >/dev/null
command -v gitleaks >/dev/null || { echo 'Install gitleaks before running local CI.' >&2; exit 1; }
# Dependencies must already be bootstrapped. Do not fetch crates or use live model providers.
export CARGO_NET_OFFLINE=true
export MUSE_NO_AUTO_UPDATE=1
node scripts/check-repository.js
gitleaks git --redact=100 --no-banner --no-color --ignore-gitleaks-allow --log-opts=--all --timeout 60
git diff --check
# Tauri native checks resolve the generated runtime resource directory.
# Stage it before compiling native code, including on a clean checkout.
npm run build
npm run check
npm run check:ui
cargo test --offline --manifest-path runtime-support/Cargo.toml
cargo test --offline --manifest-path src-tauri/Cargo.toml
npm test
npm run test:ui
git diff --check
