#!/bin/zsh
set -euo pipefail

EXPECTED_LABEL="com.erp.xianyu.sellerpilot.autostart"
EXPECTED_NAME="闲鱼卖家巡航台.app"
SANDBOX=0
[[ "${1:-}" == "--sandbox" ]] && { SANDBOX=1; shift; }
(( $# == 0 )) || { print -u2 "unknown options"; exit 1; }

if (( SANDBOX )); then
  [[ -n "${SELLER_PILOT_SANDBOX_ROOT:-}" ]] || { print -u2 "SELLER_PILOT_SANDBOX_ROOT is required"; exit 1; }
  SANDBOX_ROOT="${SELLER_PILOT_SANDBOX_ROOT:A}"
  APPLICATIONS_ROOT="${SELLER_PILOT_APPLICATIONS_ROOT:?}"
  SUPPORT_ROOT="${SELLER_PILOT_SUPPORT_ROOT:?}"
  LAUNCH_AGENTS_ROOT="${SELLER_PILOT_LAUNCH_AGENTS_ROOT:?}"
  APPLICATIONS_ROOT="${APPLICATIONS_ROOT:A}"
  SUPPORT_ROOT="${SUPPORT_ROOT:A}"
  LAUNCH_AGENTS_ROOT="${LAUNCH_AGENTS_ROOT:A}"
  for root in "$APPLICATIONS_ROOT" "$SUPPORT_ROOT" "$LAUNCH_AGENTS_ROOT"; do
    [[ "$root" == "$SANDBOX_ROOT"/* ]] || { print -u2 "sandbox path escapes SELLER_PILOT_SANDBOX_ROOT: $root"; exit 1; }
  done
else
  [[ -n "${HOME:-}" ]] || { print -u2 "HOME is required"; exit 1; }
  APPLICATIONS_ROOT="/Applications"
  SUPPORT_ROOT="$HOME/Library/Application Support"
  LAUNCH_AGENTS_ROOT="$HOME/Library/LaunchAgents"
fi

TARGET="$APPLICATIONS_ROOT/$EXPECTED_NAME"
USER_DATA="$SUPPORT_ROOT/闲鱼卖家巡航台"
PLIST="$LAUNCH_AGENTS_ROOT/$EXPECTED_LABEL.plist"
STATE="$USER_DATA/.seller-pilot-install-state.json"
SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"

[[ "$TARGET" == "$APPLICATIONS_ROOT/$EXPECTED_NAME" ]] || { print -u2 "unsafe rollback target"; exit 1; }
[[ "$PLIST" == "$LAUNCH_AGENTS_ROOT/$EXPECTED_LABEL.plist" ]] || { print -u2 "unsafe rollback plist"; exit 1; }
[[ -f "$STATE" ]] || { print -u2 "rollback refused: seller-pilot install state is missing"; exit 2; }

state_value() {
  /usr/bin/env node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); let v=s; for(const k of process.argv[2].split(".")) v=v?.[k]; if(v===undefined||v===null) process.exit(2); process.stdout.write(String(v))' "$STATE" "$1"
}

[[ "$(state_value schemaVersion)" == "2" ]] || { print -u2 "rollback refused: unsupported install state"; exit 2; }
[[ "$(state_value target)" == "$TARGET" ]] || { print -u2 "rollback refused: install-state target mismatch"; exit 2; }
[[ "$(state_value userData)" == "$USER_DATA" ]] || { print -u2 "rollback refused: install-state userData mismatch"; exit 2; }
[[ "$(state_value plist)" == "$PLIST" ]] || { print -u2 "rollback refused: install-state plist mismatch"; exit 2; }
EXPECTED_ASAR_HASH="$(state_value asarSha256)"
EXPECTED_BUNDLE_HASH="$(state_value bundleSha256)"
[[ "$EXPECTED_ASAR_HASH" =~ ^[0-9a-f]{64}$ && "$EXPECTED_BUNDLE_HASH" =~ ^[0-9a-f]{64}$ ]] || { print -u2 "rollback refused: invalid install-state hashes"; exit 2; }

[[ -d "$USER_DATA" ]] || { print -u2 "rollback invariant failed: seller-pilot userData is absent"; exit 1; }
[[ -d "$APPLICATIONS_ROOT/闲鱼行情爬虫.app" ]] || { print -u2 "rollback invariant failed: old crawler app is absent"; exit 1; }
[[ -d "$APPLICATIONS_ROOT/闲鱼行情工作台.app" ]] || { print -u2 "rollback invariant failed: old workbench app is absent"; exit 1; }

if [[ -d "$TARGET" ]]; then
  ACTUAL_ASAR_HASH="$(/usr/bin/shasum -a 256 "$TARGET/Contents/Resources/app.asar" | /usr/bin/awk '{print $1}')"
  [[ "$ACTUAL_ASAR_HASH" == "$EXPECTED_ASAR_HASH" ]] || { print -u2 "rollback refused: installed app differs from install state"; exit 2; }
  BUNDLE_JSON="$(/usr/bin/env node "$PROJECT_ROOT/scripts/test/verify-seller-release.mjs" --bundle-hash "$TARGET")"
  ACTUAL_BUNDLE_HASH="$(print -rn -- "$BUNDLE_JSON" | /usr/bin/env node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).bundle.sha256))')"
  [[ "$ACTUAL_BUNDLE_HASH" == "$EXPECTED_BUNDLE_HASH" ]] || { print -u2 "rollback refused: installed bundle checksum mismatch"; exit 2; }
fi
if [[ -f "$PLIST" ]]; then
  [[ "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PLIST")" == "$EXPECTED_LABEL" ]] || { print -u2 "rollback refused: LaunchAgent label mismatch"; exit 2; }
fi

if (( ! SANDBOX )); then
  DOMAIN="gui/$(/usr/bin/id -u)"
  /bin/launchctl bootout "$DOMAIN/$EXPECTED_LABEL" >/dev/null 2>&1 || true
  /usr/bin/pkill -f "$TARGET/Contents/MacOS/闲鱼卖家巡航台" >/dev/null 2>&1 || true
fi

[[ ! -f "$PLIST" ]] || rm -f -- "$PLIST"
[[ ! -d "$TARGET" ]] || rm -rf -- "$TARGET"

print -r -- "seller-pilot rollback PASS (userData preserved)"
