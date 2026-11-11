#!/usr/bin/env bash
# extension/ から配布用の Chrome 版と Firefox 版を dist/ に作る。
# コードは共通で、Firefox 版は manifest.json だけを書き換える:
#   - Firefox は background.service_worker に未対応なので background.scripts にする
#   - アドオン ID と、Firefox 140 以降で必須のデータ送信の申告(data_collection_permissions)を足す
#   - オプションページは options_ui で開く
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$root/dist"
version="$(node -p "require('$root/extension/manifest.json').version")"

rm -rf "$dist"
mkdir -p "$dist/chrome" "$dist/firefox"
cp -R "$root/extension/." "$dist/chrome/"
cp -R "$root/extension/." "$dist/firefox/"
find "$dist" -name .DS_Store -delete

node - "$dist/firefox/manifest.json" <<'EOF'
const fs = require('node:fs');
const file = process.argv[2];
const m = JSON.parse(fs.readFileSync(file, 'utf8'));
m.background = { scripts: [m.background.service_worker], type: 'module' };
m.options_ui = { page: m.options_page, open_in_tab: true };
delete m.options_page;
m.browser_specific_settings = {
  gecko: {
    id: 'chat-archiver@tenelol.github.io',
    // world: "MAIN" の content script は 128、data_collection_permissions は 140 から
    strict_min_version: '140.0',
    // 開いているサイト(ChatGPT・Claude・Grok)の会話を、利用者が指定した GitHub リポジトリへ送る
    data_collection_permissions: { required: ['websiteContent'] },
  },
  // Android 版は data_collection_permissions に 142 から対応
  gecko_android: { strict_min_version: '142.0' },
};
fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
EOF

(cd "$dist/chrome" && zip -qr "$dist/chat-archiver-chrome-$version.zip" .)
# Firefox の「ファイルからアドオンをインストール」で選べるよう .xpi(中身は zip)にする
(cd "$dist/firefox" && zip -qr "$dist/chat-archiver-firefox-$version.xpi" .)
echo "built: $(ls "$dist"/*.zip "$dist"/*.xpi | xargs -n1 basename | tr '\n' ' ')"
