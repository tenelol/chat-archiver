# Chat Archiver

ChatGPT・Claude・Grok の会話履歴を Markdown にして、自分の GitHub リポジトリへ自動でコミットするブラウザ拡張です。Chrome 系ブラウザ（Chrome・Edge・Arc・Dia など）と Firefox で動きます。

| 対象 | いつコミットされるか |
|---|---|
| ChatGPT（chatgpt.com） | **返信が終わるたび** ＋ 定期巡回 |
| Claude（claude.ai） | **返信が終わるたび** ＋ 定期巡回 |
| Grok（grok.com） | **返信が終わるたび** ＋ 定期巡回 |
| Claude Code（任意） | Stop hook で返信が終わるたび |

スマホアプリやデスクトップアプリで話した分も、PC のブラウザが起動していれば次の定期巡回で取り込まれます。

> [!WARNING]
> 各サービスの **Web 画面が内部で使っている非公開 API** を、ログイン中の自分のセッションで呼び出しています。OpenAI・Anthropic・xAI とは無関係の非公式ツールです。
> - サービス側の仕様変更で、予告なく動かなくなることがあります。
> - 各サービスの利用規約には、自動化された手段でのデータ取得を制限する条項があります。使う前に規約を確認し、自己責任で使ってください。
> - 公式に用意された方法としては、各サービスの「データをエクスポート」があります。

## 使う前に必要なもの

| 必要なもの | 説明 |
|---|---|
| ブラウザ | Chrome 系（Chrome・Edge・Arc・Dia など）か Firefox 140 以降 |
| GitHub アカウント | 無料で作れます |
| 保存先の **Private** リポジトリ | 会話を保存する場所。自分で1つ作ります（[手順1](#1-保存先リポジトリを作る)） |
| **GitHub のトークン** | 拡張があなたのリポジトリに書き込むための「鍵」です（[手順2](#2-github-のトークンを発行する)） |
| 各サービスへのログイン | ChatGPT・Claude・Grok に、そのブラウザでログインしておく |

> [!IMPORTANT]
> **GitHub のトークンがないと動きません。** 拡張は会話を GitHub に保存するとき、あなたの代わりにリポジトリへ書き込みます。そのための許可証がトークンです。パスワードの代わりになる大事なものなので、他人に渡したりチャットに貼ったりしないでください。

## 仕組み

```
chatgpt.com / claude.ai / grok.com のタブ
  └ 返信を生成する通信が終わったことを、拡張側（webRequest）で検知（ページには何も入れない）
      └ background.js がその会話を取得 → Markdown 化 → GitHub API で1コミット
定期巡回（alarms）
  └ 会話一覧を更新順に読み、前回から変わった会話だけコミット
```

- 取得はログイン中の Cookie をそのまま使うので、API キーは要りません。サイトのタブが開いていればその中から取得します。
- ChatGPT はタブがないと拡張からの直接取得を弾くことがあります。そのときだけ裏で chatgpt.com のタブを開いて使い、巡回が終わったら閉じます。
- コミットは GitHub の Git Data API で直接行います。ローカルの git や clone は要りません。
- 取得した会話の送り先は、設定した GitHub リポジトリ（`api.github.com`）だけです。

## 保存されるファイル

```
<保存先フォルダ>/
├── 2026/11/2026-11-09_1403_chatgpt_京都旅行の計画_6730a1b2.md
├── 2026/11/2026-11-09_2100_claude_ピアノの選び方_11111111.md
└── 2026/11/2026-11-10_1124_grok_旅行の持ち物_aaaaaaaa.md
```

- サービスでフォルダを分けず、会話を始めた日時の順に並びます。
- 先頭の YAML にタイトル・サービス・URL・モデル・作成／更新日時が入ります。
- 思考・ツール呼び出し・検索の参照先・貼り付けたテキストは `<details>` に折りたたみます。
- 編集や再生成で枝分かれした会話は、画面に表示されているブランチだけを保存します。
- 会話を続けると同じファイルが更新され、タイトルが変わるとファイル名も付け替えます。

---

## セットアップ

### 1. 保存先リポジトリを作る

GitHub で **Private** リポジトリを作ります（例：`chat-archive`）。空のままで大丈夫です。

> 会話には個人的な内容が入るので、**Public にはしないでください**。

### 2. GitHub のトークンを発行する

拡張がリポジトリに書き込むための「鍵」を作ります。**手順1で作ったリポジトリにだけ、ファイルの読み書きができる鍵** にするのがポイントです。

1. GitHub にログインした状態で [Fine-grained personal access tokens の発行ページ](https://github.com/settings/personal-access-tokens/new) を開く
   （画面からたどる場合：右上のアイコン → Settings → 左下の Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token）
2. 次のように入力する

   | 項目 | 設定 |
   |---|---|
   | Token name | 何でもよい（例：`chat-archiver`） |
   | Expiration | 有効期限。お好みで（例：1年）。切れたら作り直す |
   | Repository access | **Only select repositories** を選び、手順1のリポジトリ **だけ** を選ぶ |
   | Permissions | Repository permissions の **Contents** を **Read and write** にする（Metadata: Read-only は自動で付く） |

3. 一番下の **Generate token** を押す
4. 表示された `github_pat_...` で始まる文字列をコピーする（**この画面を離れると二度と表示されません**）
5. すぐに拡張の設定画面（[手順4](#4-設定する)）の「Personal Access Token」欄に貼り付ける
   （⌘V / Ctrl+V で貼れないブラウザでは欄の横の **貼り付け** ボタンを使います。別のブラウザに同じトークンを入れたいときは、設定済みのブラウザで **コピー** ボタンを押して持っていけます）

> [!CAUTION]
> - **All repositories（全リポジトリ）や Classic token は使わないでください。** 漏れたときに、ほかのリポジトリまで書き換えられてしまいます。
> - トークンは他人に渡さない・チャットやスクリーンショットに載せないでください。載せてしまったら、同じページの **Regenerate token** で作り直し、設定画面に貼り直します。
> - トークンはブラウザの拡張用ストレージに暗号化されずに保存されます。共用の PC では使わないでください。
> - 期限が切れると設定画面の状態欄に `GitHub 401` と出ます。作り直して貼り直せば元どおり動きます。

### 3. 拡張を入れる

[Releases](../../releases) から Chrome 用の zip（展開して使う）か Firefox 用の xpi をダウンロードするか、このリポジトリを clone して `./scripts/build.sh` を実行します（`dist/chrome/` と `dist/firefox/` ができます）。

**Chrome 系（Chrome・Edge・Arc・Dia など）**

1. 拡張機能の管理画面（`chrome://extensions`。Dia は `dia://extensions`）を開き、**デベロッパーモード** をオン
2. **パッケージ化されていない拡張機能を読み込む** → `dist/chrome/`（clone した場合は `extension/` でも可）を選ぶ

**Firefox（140 以降）**

Firefox は署名のない拡張をそのままでは常用できません。次のどちらかです。

- お試し：`about:debugging#/runtime/this-firefox` → **一時的なアドオンを読み込む** → `dist/firefox/manifest.json` を選ぶ（Firefox を再起動すると外れます）
- 常用：Firefox Developer Edition・Nightly・ESR で `about:config` の `xpinstall.signatures.required` を `false` にし、`about:addons` の歯車 → **ファイルからアドオンをインストール** で `chat-archiver-firefox-*.xpi` を選ぶ

インストール時に、開いているサイトの内容を外部（設定した GitHub）へ送ることへの同意を求められます。

### 4. 設定する

拡張のアイコンから設定画面を開き、トークン・オーナー名・リポジトリ名を入れて **保存** → **接続テスト** で「書き込めます」と出れば OK です。

| 項目 | 説明 |
|---|---|
| 保存先フォルダ | リポジトリ内のフォルダ（空ならルート） |
| ChatGPT / Claude / Grok を保存する | 対象にするサービス |
| 返信が終わるたびにコミットする | オフにすると定期巡回のときだけコミット |
| 巡回間隔（分） | スマホアプリなどで話した分を拾う間隔（既定15分、0で無効） |

### 5. 初回の取り込み

chatgpt.com・claude.ai・grok.com を開いてログインした状態で **今すぐ同期** を押します。

- 過去の会話を全部取り込むので時間がかかります。ChatGPT は回数制限が厳しく、1分に25件ほどです。
- 混雑（429）で止まっても、10分後に自動で続きから再開します。
- 取得に失敗した会話は「次回やり直す会話」として残り、次の巡回で取り直されます。

以降は自動です。

---

## 注意・制限

- 定期巡回は **ブラウザが起動しているときだけ** 動きます。ブラウザを起動すると約1分後にも1回巡回します。
- ChatGPT のタブを開いていなくても動きます。必要なときだけ、巡回中に chatgpt.com のタブが裏で一時的に開きます。
- 画像・生成ファイルの中身は保存しません（`*[画像]*` や `📎 ファイル名` として記録）。claude.ai に貼り付けたテキストは中身も保存します。
- 一時チャット（ChatGPT の Temporary chat、Claude の Incognito、Grok の一時チャット）は保存されません。
- 会話を削除しても GitHub 上のファイルは消えません（履歴として残ります）。
- 状態欄の「同期履歴をリセット」を押すと、次の同期で全件を取り込み直します。

## トラブルシュート

| 症状 | 対処 |
|---|---|
| 「ログインしていません」 | 該当サイトをタブで開いてログインし直す |
| `GitHub 401` | トークンの期限切れ。再発行して貼り直す |
| `GitHub 403/404` | トークンの対象リポジトリと Contents 権限を確認 |
| `API 403`（ChatGPT） | chatgpt.com をタブで開き、ログインし直す（裏で開いたタブでも弾かれた場合に出ます） |
| 「混雑か通信エラーのため中断」 | 何もしなくてよい（10分後に自動で再開） |
| 拡張を更新したのに変わらない | 拡張の管理画面で再読み込みし、開いているサイトのタブも再読み込み |

---

## 開発

```
extension/
  manifest.json        Manifest V3（Chrome 用。Firefox 用は build.sh が生成）
  background.js        巡回・即時同期・再試行・コミットの制御
  lib/sources.js       ChatGPT / claude.ai / Grok の API アダプタ（仕様変更時はここ）
  lib/convert.js       会話データ → Markdown（仕様変更時はここ）
  lib/github.js        GitHub Git Data API（複数ファイルを1コミット）
  lib/detect.js        返信完了の検知に使う URL の判定
  options.html/.js     設定画面
scripts/build.sh       dist/ に Chrome 版・Firefox 版と zip を作る
test/run.mjs           変換・コミット処理のテスト
claude-code-hook/      Claude Code の Stop hook（任意）
```

依存ライブラリもビルドツールも要りません。

```bash
node test/run.mjs     # テスト
./scripts/build.sh    # 配布物を dist/ に作る
```

### Claude Code の会話も保存する（任意）

保存先リポジトリをローカルに clone し、`~/.claude/settings.json` に Stop hook を登録します（`claude-code-hook/settings.example.json` と同じ内容）。

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "CHAT_ARCHIVE_REPO=\"$HOME/chat-archive\" python3 \"$HOME/chat-archiver/claude-code-hook/archive_claude_code.py\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

返信が終わるたびにセッション全体を `claude-code/<プロジェクト名>/` に Markdown で保存してコミットし、裏で `pull --rebase` と push を行います。push したくない場合は `CHAT_ARCHIVE_PUSH=0` を付けます。

## ライセンス

[MIT](LICENSE)
