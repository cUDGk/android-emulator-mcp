# Android Emulator MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

ADB経由でAndroidエミュレータを操作するMCP (Model Context Protocol) サーバー。スクリーンショットの代わりに構造化テキストでUI階層を取得し、トークン消費を約60分の1に削減します。

## なぜ必要か

AIアシスタントがAndroidエミュレータを操作する場合、通常はスクリーンショットで画面を「見て」います。1枚あたり約10万トークン消費します。このMCPサーバーは画面状態を構造化テキスト（約3-4千トークン）で提供し、「このボタンを探してタップ」を1回の呼び出しで完結させます。

| 方式 | トークン/操作 | ツール呼び出し |
|------|-------------|-------------|
| スクリーンショット | ~245,000 | 4回 |
| このMCP | ~4,000 | 1回 |

## ツール一覧

| ツール | 説明 |
|--------|------|
| `get_ui_tree` | 画面状態を構造化テキストで取得（スクショの代替） |
| `find_and_tap` | テキスト/ID/説明で要素を探してタップ、タップ後のUIも返す |
| `tap` | 座標指定でタップ |
| `type_text` | テキスト入力（ASCII + 日本語等はクリップボード経由） |
| `press_key` | キー押下（BACK, HOME, ENTER等） |
| `swipe` | 方向プリセットまたは座標指定でスワイプ |
| `screenshot` | 圧縮JPEGスクリーンショット（UIツリーで不十分な場合のみ） |
| `wait_for_element` | 要素が出現するまでポーリング |
| `device` | エミュレータ管理：起動/停止、APKインストール、アプリ起動 |
| `shell` | 任意のADBシェルコマンド実行 |
| `batch` | 複数アクションを1回の呼び出しで一括実行（高速） |

## 必要環境

- Node.js >= 18
- ADB（Android SDK Platform Tools）
- Androidエミュレータまたは実機
- ffmpeg（任意、スクリーンショット圧縮用）

## セットアップ

### 1. インストール

```bash
npm install -g android-emulator-mcp
```

またはクローンしてビルド：

```bash
git clone https://github.com/cUDGk/android-emulator-mcp.git
cd android-emulator-mcp
npm install
npm run build
```

### 2. MCP設定

Claude Codeの設定ファイル（`~/.claude.json`）に追加：

```json
{
  "mcpServers": {
    "android": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/android-emulator-mcp/dist/index.js"],
      "env": {
        "ADB_PATH": "/path/to/adb",
        "EMULATOR_PATH": "/path/to/emulator",
        "DEFAULT_DEVICE": "emulator-5554"
      }
    }
  }
}
```

`adb` と `emulator` がPATHに通っていれば、環境変数は省略可能です。

## UIツリー出力

スクリーンショットの代わりに `get_ui_tree` が構造化テキストを返します：

```
[activity=com.android.chrome/.ChromeTabbedActivity]

FrameLayout #content [0,42][720,1238]
  WebView t="Wikipedia" [S] [0,140][720,1155]
    Button #searchIcon t="検索" [C] [600,200][680,260]
  FrameLayout #toolbar_container [0,42][720,140]
    EditText #url_bar t="ja.wikipedia.org" [C][F] [52,56][668,98]

[436 nodes -> 89 shown, filter=visible]
```

フラグ: `[C]`=クリック可, `[S]`=スクロール可, `[F]`=フォーカス中, `[K]`=チェック済, `[X]`=選択中, `[!E]`=無効, `[P]`=パスワード

### フィルターモード

- `visible`（デフォルト）: bounds が [0,0][0,0] のノードと空コンテナを除外
- `interactive`: クリック可/スクロール可/フォーカス可の要素のみ
- `all`: 全ノード表示

## 使用例

### ボタンを探してタップ

```
find_and_tap(by="text", value="ログイン")
```

### 検索欄に入力

```
find_and_tap(by="id", value="search_bar")
type_text(text="hello world", submit=true)
```

### スクロール

```
swipe(direction="up")
```

### 複数操作を一括実行

```
batch(actions=[
  {"action":"find_and_tap", "by":"text", "value":"Chrome"},
  {"action":"sleep", "ms":500},
  {"action":"find_and_tap", "by":"id", "value":"url_bar"},
  {"action":"type", "text":"ノネコ wikipedia", "submit":true}
])
```

### エミュレータ起動

```
device(action="start_emulator", avd_name="claude_lite")
```

## ライセンス

MIT
