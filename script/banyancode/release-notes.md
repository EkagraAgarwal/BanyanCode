Plan mode that holds, read/grep/glob routed through the code graph, five code tools instead of 26, and a code graph that builds in less than half the time.

**Build and plan modes.** `Tab` switches between build and plan, and the footer shows which one is next (`Shift+Tab` still cycles every agent). Plan mode can no longer edit: yolo used to override its denies, and it no longer applies to plan or the read-only subagents (explore, scout, reviewer). Plan asks before running a shell command, even with yolo on.

**Repository gateway.** Calls to `grep`, `glob` and `read` now route by their arguments:

- A `grep` for an identifier goes to `code_find`, and a `glob` for code files goes to the indexed file list.
- A whole-file `read` of indexed code over 400 lines returns an outline (`banyancode_read_outline_lines` sets the threshold). Small or ranged reads stay real reads, with the file's symbols added at the top.
- Regex searches, docs, config, `.env`, paths outside the project, and repeats of a call already rerouted always run the real tool. So does every call while the graph is empty, stale or still building.

Rerouted calls show `⇢ code_find`, and fallbacks show `↩`, in the chat, including on collapsed rows. The sidebar counts them: `gateway 3 swapped · 1 fallback · 4 raw · ~2 KB saved`.

**Five code tools.** `code_find`, `repo`, `change_check`, `safe_rename` and `codegraph` replace 26 overlapping ones. The old tool names are gone, with no aliases.

**Faster code graph.**

- Files are parsed by a native Rust indexer that ships with every platform package. If it fails, the TypeScript parser takes over.
- A full build of this repo dropped from 123 s to 44 s, with the same graph.
- Linked git worktrees (`.claude/worktrees`, `.worktrees`) and paths in `.git/info/exclude` are no longer indexed. One project indexed 12,444 files, more than twice its real size.
- Builds no longer freeze the server near the end. One build blocked it for 84 s, the service was replaced, and the progress box stayed on "Stuck". The progress box now shows "Linking symbols…" in that phase, and recovers if a server restart loses its last update.

**Known limits:** macOS and Linux arm builds haven't been run by hand, and Windows binaries are unsigned. When a whole-file read returns an outline, the model sometimes reads the file again straight after, so measured savings vary. Close BanyanCode before upgrading, because a background service from the old version can keep serving.
