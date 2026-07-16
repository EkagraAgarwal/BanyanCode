# BanyanCode

> A high-performance CLI/TUI fork of OpenCode built for parallel agentic workflows, cross-session memory, tree-sitter code graphs, and free web search.

---

## Installation

BanyanCode can be installed on macOS, Linux, and Windows through three primary distribution channels.

### 1. macOS / Linux / WSL (curl)
To install BanyanCode on Unix-like systems, run the following one-liner in your terminal. This downloads the pre-built native binary for your architecture and places it in `~/.banyancode/bin/`:

```bash
curl -fsSL https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install | bash
```

### 2. Windows (PowerShell)
To install on Windows, run the following PowerShell command. This downloads the native binary, places it in `%LOCALAPPDATA%\banyancode\bin\`, and automatically adds it to your user `PATH`:

```powershell
irm https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install.ps1 | iex
```

*Note: The installer automatically detects your CPU capability and falls back to a compatible `windows-x64-baseline` binary if your CPU does not support AVX2.*

### 3. Node.js (npm)
If you have Node.js installed, you can install BanyanCode globally on any platform:

```bash
npm i -g banyancode
```

---

## Getting Started

Once installed, simply run the following command in any workspace or repository directory to start the interactive Terminal User Interface (TUI):

```bash
banyancode
```

### Quick Commands

BanyanCode also exposes a rich CLI for direct workspace operations:

```bash
# Start a non-interactive task directly from your terminal
banyancode "explain this project structure"

# Build or inspect the tree-sitter code graph
banyancode codegraph build
banyancode codegraph status

# Query repository intelligence
banyancode repository query "find all DB transaction handlers"
banyancode repository explain "packages/core/src/database/"

# Manage cross-session memory
banyancode memory list
banyancode memory search "oauth implementation details"
```

---

## Key Features

* **Parallel Subagent Mesh**: Orchestrates up to 20 subagents running concurrently with robust peer-to-peer message routing.
* **Cross-Session Memory**: Stores structured, version-controlled metadata in a local libSQL database using JSONB and BM25 search.
* **Tree-Sitter Code Graph**: Deep parsing of TypeScript, JavaScript, Python, Go, and Rust codebases for semantic tracking.
* **Free Web Search**: Built-in DuckDuckGo search integration requiring no API keys.
* **Repository Intelligence**: Advanced analysis tools including trace, impact, tests, symbols, relationships, and ownership mapping.

---

## Configuration

BanyanCode respects project-specific preferences via a local config file. Create a `banyancode.json` in your repository root, or configure it globally in `~/.config/banyancode/tui.json`.

Example `banyancode.json`:
```json
{
  "max_subagents": 5,
  "yolo_mode": false,
  "enable_websearch": true
}
```

---

## License

BanyanCode is released under the MIT License.
