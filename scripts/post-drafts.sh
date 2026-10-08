#!/usr/bin/env bash
# 投稿案の手動生成を、remaining が 0 になるまで繰り返す（最大10回）。
# 使い方: x-agent のフォルダで `bash scripts/post-drafts.sh`
# 合言葉（ADMIN_SECRET）は .env.local から読み、画面には出さない。終了時に変数を消す。
# 注意: macOS 標準の bash 3.2 は UTF-8 のロケールで、$i回目 のように日本語に隣接した変数名を誤って読む。
#       日本語に隣接する変数は必ず ${i} のように波かっこで囲む。
set -euo pipefail
cd "$(dirname "$0")/.."

URL="${X_AGENT_URL:-https://x-agent-rust.vercel.app}/api/admin/post-drafts"
MAX_RUNS=10
trap 'unset K' EXIT

# 月〜木の 17:00〜17:55 JST は週の生成の Cron と重なるので実行しない
dow=$(TZ=Asia/Tokyo date +%u)   # 1=月 … 7=日
hm=$(TZ=Asia/Tokyo date +%H%M)
if [ "$dow" -le 4 ] && [ "$hm" -ge 1700 ] && [ "$hm" -le 1755 ]; then
  echo "月〜木の 17:00〜17:55（JST）は週の生成の Cron と重なるため、実行を止めました。18:00 以降に実行してください。"
  exit 1
fi

if [ ! -f .env.local ]; then echo ".env.local が見つかりません（x-agent のフォルダで実行してください）"; exit 1; fi
K=$(grep '^ADMIN_SECRET=' .env.local | head -1 | cut -d= -f2- | awk '{print $1}')
if [ -z "${K}" ]; then echo ".env.local に ADMIN_SECRET がありません"; exit 1; fi

total_created=0
total_failed=0
remaining=""
for i in $(seq 1 "$MAX_RUNS"); do
  resp=$(curl -sS -m 300 -X POST \
    -H "Authorization: Bearer $K" \
    -H "Content-Type: application/json" \
    -d '{}' \
    -w $'\n%{http_code}' "${URL}") || { echo "[${i}回目] 通信エラーのため止めました"; exit 1; }
  code=${resp##*$'\n'}
  body=${resp%$'\n'*}
  if [ "${code}" != "200" ]; then echo "[${i}回目] HTTP ${code}: ${body}"; exit 1; fi
  if ! jq -e . >/dev/null 2>&1 <<<"${body}"; then echo "[${i}回目] JSON でない応答: ${body}"; exit 1; fi

  created=$(jq '.created | length' <<<"$body")
  failed=$(jq '.failed | length' <<<"$body")
  remaining=$(jq '.remaining' <<<"$body")
  total_created=$((total_created + created))
  total_failed=$((total_failed + failed))
  echo "[${i}回目] 作成 ${created} 件 / 失敗 ${failed} 件 / remaining ${remaining}"
  jq -r '.failed[]? | "  失敗: " + .' <<<"$body"
  skipped=$(jq -r '.skipped // empty' <<<"$body")
  if [ -n "$skipped" ]; then echo "  skipped: $skipped"; fi

  if [ "$remaining" = "0" ]; then
    echo "完了（作成 ${total_created} 件 / 失敗 ${total_failed} 件）"
    if [ "${total_failed}" -gt 0 ]; then echo "失敗した枠は、もう一度このスクリプトを実行すると作り直します。"; fi
    exit 0
  fi
done

echo "未完了（残り ${remaining} 件）。もう一度実行してください（作成 ${total_created} 件 / 失敗 ${total_failed} 件）"
exit 2
