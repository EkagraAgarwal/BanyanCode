A new Home screen, a rebuilt Agents tab, and far less CPU use.

**Home.** A banyan grows when you launch, then keeps a light sparkle. Your three most recent sessions sit under the prompt. Turn it all off with `animations: false`.

**Agents tab.** Rebuilt around three views of the same run:

- **Trace:** every agent on a shared timeline, with tool calls and token activity. It moves only when new work arrives. Scroll back through the run, and older messages load as you go.
- **Roots:** a map of your repo showing which files each agent is reading and editing. It warns when one agent edits a file another has changed since reading it.
- **Stream:** one merged log of what every agent said and did.

Drag the ruler to replay any moment of a run. Type `@coder-1` in the composer to steer one branch.

**Changed keys.** The Agents tab no longer has single-letter shortcuts. Actions such as steer, kill and allow are now buttons, and typing goes straight to the composer. Arrow keys, Page Up/Down, Enter, Tab and Esc still work.

**Performance.** The Agents tab now redraws only what changed. On a run of 20 agents with 2,000 messages each, a frame dropped from about 870 ms to about 15 ms in our benchmark.

**Also new:**

- A `banyan` theme, set as the default if you haven't chosen one.
- `session_layout: "trunk"` is an optional Chat layout that shows subagents on a rail. The classic layout stays the default.
- One project database is now shared across the stable, next and dev channels.
- Repository gateway rewrites now run on every path, and fail closed if they can't.

**Known limits:** macOS and Linux arm builds haven't been run by hand, and Windows binaries are unsigned. A background service left running from an older version can keep serving after an upgrade, so close BanyanCode before upgrading.
