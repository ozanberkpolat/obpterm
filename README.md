# winterm

A terminal for Windows with the things Windows Terminal does not have: a vertical tab rail,
split panes with saved layouts, a command palette with snippets and an SSH host book, scrollback
search, session log capture, and a look of its own. `pwsh`, Windows PowerShell and `cmd` run
over ConPTY; the emulator is xterm.js inside a Tauri v2 (WebView2) window.

## Install

Download `winterm_<version>_x64-setup.exe` (per-user, no admin) or `winterm_<version>_x64_en-US.msi`
(per-machine) from the latest GitHub release. The build is unsigned: SmartScreen shows
"More info → Run anyway" once per download. Needs Windows 10 1809 or newer (ConPTY).

## Keys

| Keys | Action |
| --- | --- |
| `Ctrl+Shift+T` | New tab (in the current project). Right-click `+ Tab` to pick a profile |
| `Ctrl+Shift+P` | Profile picker |
| `Ctrl+Shift+N` | New project |
| `Ctrl+Shift+1..9` | New tab with profile N |
| `Ctrl+Shift+W` | Close the focused pane (the tab when it is the last one) |
| middle-click a tab | Close tab |
| `Alt+Shift+=` / `Alt+Shift+-` | Split right / split down (`Alt+Shift+D` also splits right) |
| `Alt+←↑→↓` | Move focus between panes |
| `Alt+Shift+←↑→↓` | Resize the pane |
| `Ctrl+Shift+F` | Find in scrollback (Enter / Shift+Enter, Esc closes) |
| `Ctrl+Shift+L` | Start / stop capturing this pane to a log file |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1..9` | Jump to tab N |
| `Ctrl+Shift+B` | Collapse / expand the rail |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste. Right-click copies a selection, otherwise pastes |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Font size |

Everything else, including `F5`, `Ctrl+R`, `Ctrl+F`, `Ctrl+W`, goes to the shell: WebView2's
browser accelerator keys are switched off at startup (`src-tauri/src/lib.rs`).

## Projects

A project groups tabs, gives them a colour and remembers a layout. `+ Project` in the rail
creates one; right-click a tab to move it in ("Move to project…") or to override just that tab's
colour. Right-click a project header for **Save layout** (stores its open tabs, panes and
directories) and **Open saved layout** (reopens them). A project can also carry a working
directory and a default profile — set those in `config.json`.

Colour precedence: a tab's own colour, else its project's, else the house orange.

## Panes, layouts and capture

Panes split with `Alt+Shift+=` / `Alt+Shift+-`, resize by dragging the divider (or
`Alt+Shift+arrow`) and close with `Ctrl+Shift+W`. Every tab and its pane tree is written back to
`config.json` as you work and reopened on the next launch (`restore_session: false` turns that
off).

A restored pane starts in the directory the shell last reported. PowerShell only reports it if
you ask it to, so add this to your `$PROFILE`:

```powershell
function prompt {
  $p = (Get-Location).Path
  "$([char]27)]9;9;`"$p`"$([char]7)PS $p> "
}
```

`Ctrl+Shift+L` tees the focused pane's raw output (escape codes and all) to
`%APPDATA%\tr.com.obp.winterm\logs\<title>-<timestamp>.log`; the tab shows a red dot while it
is capturing.

## Config

`%APPDATA%\tr.com.obp.winterm\config.json`, created with defaults on first start. Profiles
(`id`, `name`, `exe`, `args`, `cwd`), font, scrollback, and the xterm.js theme. A file that does
not parse is reported on screen, not replaced.

## Development

The UI is plain TypeScript + Vite and iterates in any browser:

```sh
npm install
npm run devserver   # real shells (node-pty) on ws://:1421, config in dev-config.json
npm run dev         # Vite on :1420 (listens on all interfaces)
```

`npm test` runs the pane-tree tests. `test/smoke.mjs` is the real check: it drives the built app
in headless Chromium over CDP (splits panes, makes a project, searches, starts a capture) and
fails on any console error —

```sh
docker run -d --rm --name winterm-chrome --network host -u 0 --entrypoint chromium \
  gotenberg/gotenberg:8 --headless --no-sandbox --remote-debugging-port=9222 --remote-allow-origins=* about:blank
npm run devserver & npx vite preview --port 1420 --host &
node test/smoke.mjs
```

`src/transport.ts` is the only seam: the browser talks to `dev-server.mjs` over a WebSocket,
the app talks to Rust over Tauri IPC. Rust changes are checked from Linux without a Windows box:

```sh
rustup target add x86_64-pc-windows-msvc
cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

(`tauri-build` needs `llvm-rc` on `PATH` for that; `apt install llvm` or extract it from the
`llvm-NN` package.) Pushing to `master` runs `cargo test` + typecheck + a full Windows build;
pushing a `v*` tag also publishes the MSI and exe as a GitHub release.

## Layout

- `src-tauri/src/pty.rs` — one ConPTY per tab, output streamed as raw bytes over a Tauri channel
- `src-tauri/src/config.rs` — config file, defaults, the Sentinel palette
- `src-tauri/src/lib.rs` — plugins, commands, the WebView2 accelerator-key switch
- `src/app.ts` — tabs, panes and projects; `src/layout.ts` — the pane tree; `src/rail.ts` — the rail
- `src/keys.ts` — shortcuts, `src/find.ts` — find bar, `src/menu.ts` — popups, `src/term.ts` — xterm setup
- `dev-server.mjs` — browser dev loop
