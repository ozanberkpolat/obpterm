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
| `Ctrl+Shift+T` | New tab (default profile). Right-click `+` to pick a profile |
| `Ctrl+Shift+1..9` | New tab with profile N |
| `Ctrl+Shift+W` / middle-click | Close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1..9` | Jump to tab N |
| `Ctrl+Shift+B` | Collapse / expand the rail |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste. Right-click copies a selection, otherwise pastes |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Font size |

Everything else, including `F5`, `Ctrl+R`, `Ctrl+F`, `Ctrl+W`, goes to the shell: WebView2's
browser accelerator keys are switched off at startup (`src-tauri/src/lib.rs`).

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
- `src/app.ts` — tabs + rail, `src/keys.ts` — shortcuts, `src/term.ts` — xterm setup
- `dev-server.mjs` — browser dev loop
