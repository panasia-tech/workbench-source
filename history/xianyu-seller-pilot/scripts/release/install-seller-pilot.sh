#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
PROJECT_ROOT="${SCRIPT_DIR:h:h}"
MIGRATOR="$SCRIPT_DIR/migrate-seller-user-data.mjs"
EXPECTED_LABEL="com.erp.xianyu.sellerpilot.autostart"
EXPECTED_NAME="闲鱼卖家巡航台.app"
SANDBOX=0
MANIFEST=""

while (( $# > 0 )); do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --sandbox) SANDBOX=1; shift ;;
    *) print -u2 "unknown option: $1"; exit 1 ;;
  esac
done

[[ -n "$MANIFEST" ]] || { print -u2 "--manifest is required"; exit 1; }
MANIFEST="$(cd "${MANIFEST:h}" && pwd -P)/${MANIFEST:t}"
[[ -f "$MANIFEST" ]] || { print -u2 "manifest not found: $MANIFEST"; exit 1; }

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
STARTER="$USER_DATA/start-seller-pilot.sh"
STATE="$USER_DATA/.seller-pilot-install-state.json"
REPORT="$USER_DATA/migration-report.json"
BACKUP_ROOT="${SELLER_PILOT_BACKUP_ROOT:-$SUPPORT_ROOT/闲鱼卖家巡航台 Migration Backups}"
OLD_CRAWLER="$APPLICATIONS_ROOT/闲鱼行情爬虫.app"
OLD_WORKBENCH="$APPLICATIONS_ROOT/闲鱼行情工作台.app"

[[ "$BACKUP_ROOT" = /* ]] || { print -u2 "seller-pilot backup root must be absolute"; exit 1; }
BACKUP_ROOT="${BACKUP_ROOT:A}"
[[ "$BACKUP_ROOT" != "$USER_DATA" && "$BACKUP_ROOT" != "$USER_DATA"/* ]] || { print -u2 "seller-pilot backup root must be outside userData"; exit 1; }

manifest_value() {
  /usr/bin/env node -e 'const fs=require("fs"); const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); let v=m; for(const k of process.argv[2].split(".")) v=v?.[k]; if(v===undefined||v===null) process.exit(2); process.stdout.write(String(v))' "$MANIFEST" "$1"
}

bundle_hash() {
  local app="$1"
  if [[ ! -d "$app" ]]; then print -r -- "absent"; return; fi
  (
    cd "$app"
    find . -type f -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' file; do
      print -rn -- "$file\0"
      /usr/bin/shasum -a 256 "$file" | /usr/bin/awk '{print $1}'
    done
  ) | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}'
}

CANDIDATE="$(manifest_value candidateAppPath)"
MANIFEST_TARGET="$(manifest_value identity.bundlePath)"
MANIFEST_USER_DATA="$(manifest_value identity.userDataPath)"
MANIFEST_LABEL="$(manifest_value identity.launchAgentLabel)"
MANIFEST_APP_ID="$(manifest_value identity.appId)"
MANIFEST_SCHEMA="$(manifest_value schemaVersion)"
MANIFEST_KIND="$(manifest_value releaseKind)"
MANIFEST_ASAR_HASH="$(manifest_value components.asar.archiveSha256)"
MANIFEST_BUNDLE_HASH="$(manifest_value components.bundle.sha256)"

[[ "$CANDIDATE" = /* && -d "$CANDIDATE" ]] || { print -u2 "manifest candidateAppPath is not an existing absolute app"; exit 1; }
[[ "${CANDIDATE:t}" == "$EXPECTED_NAME" ]] || { print -u2 "manifest candidate name mismatch"; exit 1; }
if (( SANDBOX )); then
  [[ "$MANIFEST_TARGET" == "/Applications/$EXPECTED_NAME" ]] || { print -u2 "manifest bundle target mismatch"; exit 1; }
  [[ "$MANIFEST_USER_DATA" == "$HOME/Library/Application Support/闲鱼卖家巡航台" ]] || { print -u2 "manifest userData mismatch"; exit 1; }
else
  [[ "$TARGET" == "$MANIFEST_TARGET" ]] || { print -u2 "resolved target differs from manifest"; exit 1; }
  [[ "$USER_DATA" == "$MANIFEST_USER_DATA" ]] || { print -u2 "resolved userData differs from manifest"; exit 1; }
fi
[[ "$MANIFEST_LABEL" == "$EXPECTED_LABEL" ]] || { print -u2 "manifest LaunchAgent label mismatch"; exit 1; }
[[ "$MANIFEST_APP_ID" == "com.erp.xianyu.sellerpilot" ]] || { print -u2 "manifest appId mismatch"; exit 1; }
[[ "$MANIFEST_SCHEMA" == "2" ]] || { print -u2 "unsupported release manifest schema"; exit 1; }
if (( SANDBOX )); then
  [[ "$MANIFEST_KIND" == "seller-pilot-candidate" || "$MANIFEST_KIND" == "seller-pilot-sandbox-draft" ]] || { print -u2 "invalid sandbox release manifest kind"; exit 1; }
else
  [[ "$MANIFEST_KIND" == "seller-pilot-candidate" ]] || { print -u2 "production install requires a final seller-pilot candidate manifest"; exit 1; }
fi
[[ "$MANIFEST_ASAR_HASH" =~ ^[0-9a-f]{64}$ ]] || { print -u2 "invalid manifest asar hash"; exit 1; }
[[ "$MANIFEST_BUNDLE_HASH" =~ ^[0-9a-f]{64}$ ]] || { print -u2 "invalid manifest bundle hash"; exit 1; }
[[ "$TARGET" != "$OLD_CRAWLER" && "$TARGET" != "$OLD_WORKBENCH" ]] || { print -u2 "target collides with an existing app"; exit 1; }
[[ ! -e "$TARGET" && ! -L "$TARGET" ]] || { print -u2 "refusing to overwrite pre-existing target: $TARGET"; exit 3; }
[[ ! -e "$PLIST" && ! -L "$PLIST" ]] || { print -u2 "refusing to overwrite pre-existing LaunchAgent: $PLIST"; exit 3; }

CANDIDATE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CANDIDATE/Contents/Info.plist")"
[[ "$CANDIDATE_ID" == "$MANIFEST_APP_ID" ]] || { print -u2 "candidate bundle identifier mismatch"; exit 1; }
ACTUAL_ASAR_HASH="$(/usr/bin/shasum -a 256 "$CANDIDATE/Contents/Resources/app.asar" | /usr/bin/awk '{print $1}')"
[[ "$ACTUAL_ASAR_HASH" == "$MANIFEST_ASAR_HASH" ]] || { print -u2 "candidate app.asar differs from release manifest"; exit 1; }

if (( ! SANDBOX )); then
  /usr/bin/env node "$PROJECT_ROOT/scripts/test/verify-seller-release.mjs" --candidate-manifest "$MANIFEST" --installation-preflight >/dev/null
fi

mkdir -p "$APPLICATIONS_ROOT" "$SUPPORT_ROOT" "$LAUNCH_AGENTS_ROOT"
OLD_CRAWLER_BEFORE="$(bundle_hash "$OLD_CRAWLER")"
OLD_WORKBENCH_BEFORE="$(bundle_hash "$OLD_WORKBENCH")"

TARGET_CREATED=0
PLIST_CREATED=0
INSTALL_COMMITTED=0
cleanup_partial_install() {
  local exit_code=$?
  if (( exit_code != 0 && ! INSTALL_COMMITTED )); then
    if (( ! SANDBOX )); then /bin/launchctl bootout "gui/$(/usr/bin/id -u)/$EXPECTED_LABEL" >/dev/null 2>&1 || true; fi
    if (( PLIST_CREATED )) && [[ -e "$PLIST" || -L "$PLIST" ]]; then rm -f -- "$PLIST"; fi
    if (( TARGET_CREATED )) && [[ -e "$TARGET" || -L "$TARGET" ]]; then rm -rf -- "$TARGET"; fi
  fi
  return $exit_code
}
trap cleanup_partial_install EXIT

TARGET_CREATED=1
if (( SANDBOX )); then
  cp -R "$CANDIDATE" "$TARGET"
  SOURCES=("$SUPPORT_ROOT/xianyu-electron")
else
  /usr/bin/ditto --noqtn "$CANDIDATE" "$TARGET"
  SOURCES=("$HOME/Library/Application Support/xianyu-electron" "$HOME/Library/Application Support/闲鱼行情工作台")
fi

INSTALLED_ASAR_HASH="$(/usr/bin/shasum -a 256 "$TARGET/Contents/Resources/app.asar" | /usr/bin/awk '{print $1}')"
[[ "$INSTALLED_ASAR_HASH" == "$MANIFEST_ASAR_HASH" ]] || { print -u2 "installed app hash mismatch"; exit 1; }
if (( SANDBOX )); then
  SELLER_PILOT_VERIFY_SANDBOX_ROOT="$SANDBOX_ROOT" /usr/bin/env node "$PROJECT_ROOT/scripts/test/verify-seller-release.mjs" --candidate-manifest "$MANIFEST" --installed "$TARGET" >/dev/null
else
  /usr/bin/env node "$PROJECT_ROOT/scripts/test/verify-seller-release.mjs" --candidate-manifest "$MANIFEST" --installed "$TARGET" >/dev/null
fi

MIGRATION_ARGS=(apply --destination "$USER_DATA" --backup-root "$BACKUP_ROOT" --report "$REPORT")
for source in "${SOURCES[@]}"; do MIGRATION_ARGS+=(--source "$source"); done
/usr/bin/env node "$MIGRATOR" "${MIGRATION_ARGS[@]}" >/dev/null
VERIFY_ARGS=(verify --destination "$USER_DATA" --backup-root "$BACKUP_ROOT" --report "$REPORT")
for source in "${SOURCES[@]}"; do VERIFY_ARGS+=(--source "$source"); done
/usr/bin/env node "$MIGRATOR" "${VERIFY_ARGS[@]}" >/dev/null

/usr/bin/env node - "$STARTER" "$TARGET" "$USER_DATA" <<'NODE'
const fs = require('fs')
const [starter, target, userData] = process.argv.slice(2)
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`
const binary = `${target}/Contents/MacOS/闲鱼卖家巡航台`
const progress = `${userData}/seller-progress.jsonl`
const job = `${userData}/xianyu-seller-crawl.json`
const events = `${userData}/seller-events`
const staleSeconds = 600
const script = `#!/bin/zsh
set -u
/usr/bin/open -gj ${quote(target)}
sleep 2
/usr/bin/osascript -e 'tell application "System Events" to tell application process "闲鱼卖家巡航台" to set visible to false' >/dev/null 2>&1 || true

# Restart a live renderer only after ten minutes without a durable seller
# heartbeat. This preserves the account/rate safety policy while recovering
# from a virtualized seller page that has stopped making progress.
while /usr/bin/pgrep -f ${quote(binary)} >/dev/null 2>&1; do
  running=$(/usr/bin/plutil -extract job.running raw -o - ${quote(job)} 2>/dev/null || print false)
  if [[ "$running" == "true" ]]; then
    now=$(/bin/date +%s)
    mtime=$(/usr/bin/stat -f %m ${quote(progress)} 2>/dev/null || print 0)
    if [[ "$mtime" =~ '^[0-9]+$' ]] && (( mtime > 0 && now - mtime > ${staleSeconds} )); then
      mkdir -p ${quote(events)}
      event_file="${events}/seller-events-$(/bin/date -u +%Y-%m-%d).jsonl"
      at=$(/bin/date -u +%Y-%m-%dT%H:%M:%S.000Z)
      run_id=$(/usr/bin/plutil -extract job.runId raw -o - ${quote(job)} 2>/dev/null || print '')
      if [[ "$run_id" =~ '^[A-Za-z0-9:_-]{1,160}$' ]]; then
        print -r -- '{"type":"seller-watchdog-restart","runId":"'"$run_id"'","reasonCode":"HEARTBEAT_STALE","at":"'"$at"'"}' >> "$event_file"
      else
        print -r -- '{"type":"seller-watchdog-restart","reasonCode":"HEARTBEAT_STALE","at":"'"$at"'"}' >> "$event_file"
      fi
      pid=$(/usr/bin/pgrep -f ${quote(binary)} | /usr/bin/head -1)
      if [[ -n "$pid" ]]; then /bin/kill -TERM "$pid" 2>/dev/null || true; fi
      sleep 10
      pid=$(/usr/bin/pgrep -f ${quote(binary)} | /usr/bin/head -1)
      if [[ -n "$pid" ]]; then /bin/kill -KILL "$pid" 2>/dev/null || true; fi
      break
    fi
  fi
  sleep 30
done
exit 1
`
fs.writeFileSync(starter, script, { mode: 0o700 })
NODE
chmod 700 "$STARTER"

PLIST_CREATED=1
/usr/bin/env node - "$PLIST" "$EXPECTED_LABEL" "$STARTER" "$SUPPORT_ROOT" <<'NODE'
const fs = require('fs')
const path = require('path')
const [plist, label, starter, supportRoot] = process.argv.slice(2)
const logRoot = path.resolve(supportRoot, '..', 'Logs')
const value = {
  Label: label,
  ProgramArguments: [starter],
  KeepAlive: { SuccessfulExit: false },
  RunAtLoad: true,
  ProcessType: 'Background',
  ThrottleInterval: 30,
  StandardOutPath: path.join(logRoot, 'seller-pilot-autostart.log'),
  StandardErrorPath: path.join(logRoot, 'seller-pilot-autostart.error.log')
}
fs.writeFileSync(plist, JSON.stringify(value), { mode: 0o600 })
NODE
/usr/bin/plutil -convert xml1 "$PLIST"
chmod 600 "$PLIST"
/usr/bin/plutil -lint "$PLIST" >/dev/null

OLD_CRAWLER_AFTER="$(bundle_hash "$OLD_CRAWLER")"
OLD_WORKBENCH_AFTER="$(bundle_hash "$OLD_WORKBENCH")"
[[ "$OLD_CRAWLER_BEFORE" == "$OLD_CRAWLER_AFTER" ]] || { print -u2 "old crawler app changed; installation aborted"; exit 1; }
[[ "$OLD_WORKBENCH_BEFORE" == "$OLD_WORKBENCH_AFTER" ]] || { print -u2 "old workbench app changed; installation aborted"; exit 1; }

/usr/bin/env node - "$STATE" "$MANIFEST" "$CANDIDATE" "$TARGET" "$USER_DATA" "$PLIST" "$MANIFEST_ASAR_HASH" "$MANIFEST_BUNDLE_HASH" "$OLD_CRAWLER_BEFORE" "$OLD_WORKBENCH_BEFORE" <<'NODE'
const fs = require('fs')
const [state, manifest, candidate, target, userData, plist, asarSha256, bundleSha256, oldCrawlerSha256, oldWorkbenchSha256] = process.argv.slice(2)
const temp = `${state}.tmp-${process.pid}`
fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 2, manifest, candidate, target, userData, plist, asarSha256, bundleSha256, oldCrawlerSha256, oldWorkbenchSha256 }, null, 2) + '\n', { mode: 0o600 })
fs.renameSync(temp, state)
NODE

if (( ! SANDBOX )); then
  DOMAIN="gui/$(/usr/bin/id -u)"
  /bin/launchctl bootstrap "$DOMAIN" "$PLIST"
  sleep 4
  /bin/launchctl print "$DOMAIN/$EXPECTED_LABEL" >/dev/null
  MAIN_COUNT="$(/usr/bin/pgrep -f "$TARGET/Contents/MacOS/闲鱼卖家巡航台" | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
  [[ "$MAIN_COUNT" == "1" ]] || { print -u2 "expected one seller-pilot main process, found $MAIN_COUNT"; exit 1; }
fi

INSTALL_COMMITTED=1

print -r -- "seller-pilot install PASS"
print -r -- "target=$TARGET"
print -r -- "candidateAsarSha256=$MANIFEST_ASAR_HASH"
print -r -- "oldCrawlerBundleSha256=$OLD_CRAWLER_BEFORE"
print -r -- "oldWorkbenchBundleSha256=$OLD_WORKBENCH_BEFORE"
