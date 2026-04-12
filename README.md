# Android Emulator MCP

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An MCP (Model Context Protocol) server that lets AI assistants control Android emulators via ADB. Replaces expensive screenshot-based interaction with efficient structured UI tree text, reducing token consumption by ~60x.

## Why

When AI assistants interact with Android emulators, they typically take screenshots to "see" the screen. Each screenshot costs ~100K tokens. This MCP server provides the screen state as structured text (~3-4K tokens) and enables one-call interactions like "find this button and tap it."

| Approach | Tokens per action | Tool calls |
|----------|------------------|------------|
| Screenshots | ~245,000 | 4 |
| This MCP | ~4,000 | 1 |

## Tools

| Tool | Description |
|------|-------------|
| `get_ui_tree` | Get screen state as structured text (replaces screenshots) |
| `find_and_tap` | Find element by text/id/desc and tap it, returns UI after |
| `tap` | Tap at coordinates |
| `type_text` | Type text (ASCII + Japanese/Unicode via clipboard) |
| `press_key` | Press keys (BACK, HOME, ENTER, etc.) |
| `swipe` | Swipe with direction presets or custom coordinates |
| `screenshot` | Compressed JPEG screenshot (when UI tree isn't enough) |
| `wait_for_element` | Poll until element appears |
| `device` | Manage emulators: start/stop, install APKs, launch apps |
| `shell` | Run arbitrary ADB shell commands |

## Requirements

- Node.js >= 18
- ADB (Android SDK Platform Tools)
- Android Emulator or physical device
- ffmpeg (optional, for screenshot compression)

## Setup

### 1. Install

```bash
npm install -g android-emulator-mcp
```

Or clone and build:

```bash
git clone https://github.com/user/android-emulator-mcp.git
cd android-emulator-mcp
npm install
npm run build
```

### 2. Configure MCP

Add to your Claude Code settings (`~/.claude.json`):

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

If `adb` and `emulator` are in your PATH, the env vars are optional.

## UI Tree Output

Instead of screenshots, `get_ui_tree` returns structured text like:

```
[activity=com.android.chrome/.ChromeTabbedActivity]

FrameLayout #content [0,42][720,1238]
  WebView t="Wikipedia" [S] [0,140][720,1155]
    Button #searchIcon t="Search" [C] [600,200][680,260]
  FrameLayout #toolbar_container [0,42][720,140]
    EditText #url_bar t="en.wikipedia.org" [C][F] [52,56][668,98]

[436 nodes -> 89 shown, filter=visible]
```

Flags: `[C]`=clickable, `[S]`=scrollable, `[F]`=focused, `[K]`=checked, `[X]`=selected, `[!E]`=disabled, `[P]`=password

### Filter modes

- `visible` (default): Hides zero-bounds nodes and empty containers
- `interactive`: Only clickable/scrollable/focusable elements
- `all`: Raw full tree

## Examples

### Find and tap a button

```
find_and_tap(by="text", value="Login")
```

### Type into search

```
find_and_tap(by="id", value="search_bar")
type_text(text="hello world", submit=true)
```

### Scroll down

```
swipe(direction="up")
```

### Start emulator

```
device(action="start_emulator", avd_name="claude_lite")
```

## License

MIT
