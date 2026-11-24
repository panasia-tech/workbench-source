#!/usr/bin/env bash
set -euo pipefail
ROOT_STUDIO="/Users/user/explainer-studio"
BASE="/Users/user/Documents/ChatGPT/行政管理/outputs/外部客服V3-独立节点教程与源码-20261124"
PROJ="cs_01_onboard"
NODE_ID="CS-ONBOARD-01"
/Users/user/VoiceTTS/.venv/bin/python "$BASE/scripts/gen_tts_serena.py" "$BASE/projects/$PROJ/vo/main"
cd "$ROOT_STUDIO"
node engine/vo/trim.mjs "projects/$PROJ/vo/main"
node engine/vo/layout.mjs "projects/$PROJ/vo/main"
node engine/vo/build_zh.mjs "projects/$PROJ/vo/main"
node engine/render.mjs sheet 4 --project "$PROJ"
node engine/make.mjs --project "$PROJ" --format landscape --jobs 3 --fps 24 --skip-vo
cp "$ROOT_STUDIO/out/$PROJ/main/final-16x9.mp4" "$BASE/mp4/$NODE_ID.mp4"
