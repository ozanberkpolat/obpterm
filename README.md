# OBPTerm

A terminal for Windows with the things Windows Terminal does not have: a vertical tab rail,
split panes with saved layouts, a command palette with snippets and an SSH host book, scrollback
search, session log capture, and a look of its own. `pwsh`, Windows PowerShell and `cmd` run
over ConPTY; the emulator is xterm.js inside a Tauri v2 (WebView2) window.

## Install

Download `OBPTerm_<version>_x64-setup.exe` (per-user, no admin) or `OBPTerm_<version>_x64_en-US.msi`
(per-machine) from the latest GitHub release. Needs Windows 10 1809 or newer (ConPTY).

### Smart App Control

Unsigned builds are **blocked outright by Smart App Control** (SAC), not merely warned about, and
[there is no way to allow a single app](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions):
either the file is signed with a certificate from a CA in the Microsoft Trusted Root Program, or
Microsoft's cloud intelligence already knows the binary is safe. SmartScreen's "More info → Run
anyway" does not apply — that is a different feature. The signature must also be
[RSA; SAC does not accept ECC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control).

Three ways out, in the order they cost:

1. **Turn Smart App Control off** — Windows Security → App & browser control → Smart App Control
   → Off. Microsoft's FAQ says recent Windows updates let you turn it back on without a clean
   install; on older builds it could only be re-enabled by reinstalling Windows, so check your
   build before flipping it. Everything else on the machine loses that layer of protection.
2. **Sign the build** with an OV/EV code-signing certificate from a public CA (Sectigo, DigiCert,
   GlobalSign, Certum…). Since 2023 the private key must live on a hardware token or a cloud HSM,
   so pick a provider with a CLI that CI can call.
3. **Microsoft Trusted Signing** (~USD 10/month, the smoothest path) — but the Public Trust
   certificates are geofenced: organizations in the US, Canada, EU, UK, Australia, New Zealand,
   Japan, South Korea, Singapore, Switzerland, Norway or Israel, and **individual developers only
   in the US or Canada**. Turkey is not on either list, so this needs an entity in an eligible
   country.

The workflow already signs whenever the credentials exist. Add repository secrets:

| Secret | What it does |
| --- | --- |
| `WINDOWS_SIGN_COMMAND` | Any signing CLI with `%1` where the file goes, e.g. `trusted-signing-cli -e https://weu.codesigning.azure.net -a myaccount -c myprofile %1`. Passed to Tauri as `bundle.windows.signCommand`, so it signs the app, the MSI and the NSIS installer. |
| `WINDOWS_PFX_BASE64` + `WINDOWS_PFX_PASSWORD` | A PFX (base64) to import on the runner; the build then uses `signtool` with that thumbprint and a SHA-256 timestamp. |

With neither set, the build is unsigned and says so in the log.

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
| `Ctrl+Shift+H` | Host book (open an SSH target in a new tab) |
| `Ctrl+Shift+,` | Settings — profiles, accounts, hosts, projects |
| `Ctrl+wheel` | Zoom the terminal in and out |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+1..9` | Jump to tab N |
| `Ctrl+Shift+B` | Collapse / expand the rail |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste. Right-click copies a selection, otherwise pastes |
| `F2` / double-click a tab | Rename the tab |
| `Ctrl+Shift+Q` | Close the whole tab (`Ctrl+Shift+W` closes the pane) |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Font size |

Everything else, including `F5`, `Ctrl+R`, `Ctrl+F`, `Ctrl+W`, goes to the shell: WebView2's
browser accelerator keys are switched off at startup (`src-tauri/src/lib.rs`).

## The window

OBPTerm draws its own title bar (the OS one is off): the wordmark, four menus — **Shell**,
**Panes**, **Project**, **View** — the palette button and a settings gear, then minimize /
maximize / close. Nothing is reachable only by right-click; every context menu's contents also
live in one of those four menus.

**Ctrl+K** opens the command palette over profiles, SSH hosts, projects, open tabs and the app's
own commands, matched as a subsequence ("spr" finds "Split right").

## The toolbar

Top-right of the terminal area, the same actions as the `/ssh/` terminal in iot-stack: **copy**,
**paste**, **send Ctrl+C**, **clear**, then a layout picker — one pane, two side by side, two
stacked, four. The picker highlights the shape you are currently in; picking a smaller one closes
the extra panes (and their shells), picking a bigger one opens new ones in the focused pane's
directory.

## Settings

`Ctrl+Shift+,` (or the gear) opens settings as a sheet over the terminal, with a sidebar of
sections:

| Section | What it holds |
| --- | --- |
| Terminal | Font, size, scrollback, cursor style and blink, default folder, default profile, right-click behaviour, capture folder |
| Appearance | Accent, dim-inactive-panes, and all 20 terminal colours with a live preview |
| Rail & layout | Rail width, start collapsed |
| Startup & session | Reopen tabs, default account, token budgets |
| Profiles / Accounts / SSH hosts / Projects | A list and a form: add, duplicate, edit, delete, with undo |
| Keyboard | Every shortcut the app reserves (fixed for now) |
| Updates | Release source, token, check-on-launch, and the update button |
| Files & reset | Show the config / log folders, reset to defaults |

Every control writes to `config.json` as you change it — no Apply button — and the app repaints
immediately. The file stays hand-editable.

It is a sheet rather than a second window on purpose: the app's capability scope covers the
`main` window only, so a second Tauri window's webview gets no IPC and renders as a black
rectangle.

## Selecting and copying

Finishing a left drag copies the selection straight to the clipboard — no keypress, the way the
`/ssh/` terminal in iot-stack behaves. A left drag always selects, even while the program running
in the pane has mouse reporting on (Claude Code, vim), so text stays selectable. `Ctrl+Shift+C`
copies an existing selection and `Ctrl+Shift+V` pastes; plain `Ctrl+C` is left to the shell as an
interrupt. Turn copy-on-select off in Settings → Terminal.

A tab's name is whatever the shell reports, until you give it one: `F2`, a double-click on the
rail row, or Rename in its menu. Clearing the field hands the name back to the shell. The name
travels with the session.

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
`%APPDATA%\tr.com.obp.obpterm\logs\<title>-<timestamp>.log`; the tab shows a red dot while it
is capturing.

## Status bar: account, quota, target

The bar along the bottom shows, left to right: the **account** new shells will start under, the
**tokens this machine has sent** in the last 5 hours and 7 days, the machine's **CPU, memory,
swap and disk** (the disk holding the focused pane's directory, sampled every 3 s), a **check for
updates** button, then the focused pane's target, directory, capture state and pane count. Click the account chip to open a tab under a different
account or to change the default; click the meters for the breakdown; click the target chip for
the host book.

Projects fold away: click a group header in the rail to collapse or expand it, and that stays
folded across restarts. Drag the rail's right edge to resize it; that sticks too.

**Accounts are environment presets** — obpterm never reads, writes or holds a credential. An
account is a name plus the environment its shells start with, so switching Claude Code logins
means pointing `CLAUDE_CONFIG_DIR` at another config directory, and the same mechanism covers
`AZURE_CONFIG_DIR`, `AWS_PROFILE` or `KUBECONFIG`:

```json
"accounts": [
  { "id": "personal", "name": "Personal", "env": {}, "claude_dir": "C:\\Users\\ozan\\.claude", "color": "#ff8a1e" },
  { "id": "work", "name": "Work", "env": { "CLAUDE_CONFIG_DIR": "C:\\Users\\ozan\\.claude-work", "AZURE_CONFIG_DIR": "C:\\Users\\ozan\\.azure-work" },
    "claude_dir": "C:\\Users\\ozan\\.claude-work", "color": "#4c8dff" }
],
"default_account": "personal"
```

Environment reaches a process at spawn, so switching applies to **new** tabs and panes, never to
a shell already running — the menu says so by only offering "New tab as …".

### Adding a second Claude Code login

Account chip → **Add a Claude Code account…**. That creates an account with its own
`CLAUDE_CONFIG_DIR` and opens Settings; set the folder you want, then press **Sign in** on that
row and OBPTerm opens a tab under it running `claude auth login`. Claude Code creates the folder
and stores the credentials — nothing here copies a credential file.

Claude Code can also keep several logins **inside one folder** (`<config dir>/accounts/*` with a
`current` marker). OBPTerm shows which of those is active on the chip, but only Claude Code's own
`/login` can switch between them: there is no CLI or environment variable that selects one, and
swapping the files by hand is how logins get corrupted. One folder per account is the switchable
arrangement.

`claude_dir` is read (never written) for two things: the login shown on the chip, from
`accounts/current` + `accounts/<name>/account.json`, and the meters, summed from the
`projects/**/*.jsonl` transcripts in that directory. **The meters are what this machine sent**
— input + output + cache-writes, with cache reads counted separately because they are not what a
plan window is spent on. They are not Anthropic's accounting of your limit, and nothing here goes
over the network. Set `quota_5h_tokens` / `quota_7d_tokens` to see a percentage of your own
budget instead of raw totals.

## Updates

The **check for updates** button asks the GitHub releases API for the newest tag, compares it to
the running build and either says *App is up to date* or turns into *Update to x.y.z* — pressing
it again downloads that release's `-setup.exe`, saves the session and runs it with `/S /R`:
no installer window, no clicking, and OBPTerm comes back by itself with every tab reopened.

Windows cannot swap a running executable, so the process does restart — the installer stops it,
replaces the files and starts the new build. Shells running inside the tabs are lost with it;
the tabs, panes and directories come back from `session.json`, and the new window says
*Updated to x.y.z*. The repository is public, so no token is needed. If you ever point `update_repo` at a private
repository, add a token with read access to its releases:

```json
"update_repo": "ozanberkpolat/obpterm",
"github_token": "github_pat_…"
```

Nothing is downloaded until you press the button a second time, and the installer is run from
`%TEMP%`. The check and the download both happen in the Rust process, not the webview: GitHub
redirects release assets to a host that sends no CORS headers, so a browser `fetch` of one fails
with a bare "Failed to fetch".

## Host book

```json
"hosts": [
  { "id": "vps", "name": "My VPS", "host": "vps.example.com", "user": "me", "port": null, "identity": null, "project": "homelab" }
]
```

`Ctrl+Shift+H`, the target chip, or right-clicking `+ Tab` opens one in a new tab (`ssh.exe`
with the right arguments); the host book also offers to split the current tab with one. A host
tab remembers its target across restarts, and `project` drops it straight into that project.

`%USERPROFILE%`-style variables (and a leading `~`) are expanded in `cwd` and in an account's
environment values, since Windows does not expand them for a spawned process. An unset variable
is left as written rather than turning into an empty path.

## Sessions and crashes

The open tabs — pane tree, project, colour, account, host, each pane's reported directory — are
written to `session.json` next to `config.json` on every change (250 ms debounce, flushed on
blur, on close and once a minute) and reopened on the next launch. The file is written to a temp
file and renamed over the old one, so a crash mid-write cannot leave a half-written session.

`session.json` also carries `clean_exit`: false while OBPTerm is running, true once the window
closes normally. A launch that finds `clean_exit: false` reopens the tabs and says the app did
not shut down cleanly. Set `restore_session: false` in `config.json` to always start fresh.

## Config

`%APPDATA%\tr.com.obp.obpterm\config.json`, created with defaults on first start (a
`tr.com.obp.winterm` config from before the rename is carried over automatically). Profiles
(`id`, `name`, `exe`, `args`, `cwd`, `env`), projects, accounts, hosts, font, scrollback, rail
width, the update repo and the xterm.js theme. New shells start in `default_cwd` — `C:\OBP` out
of the box, created if it does not exist — unless the project or profile says otherwise. A file that does
not parse is reported on screen, not replaced.

## Development

The UI is plain TypeScript + Vite and iterates in any browser:

```sh
npm install
npm run devserver   # real shells (node-pty) on ws://127.0.0.1:1421, config in dev-config.json
                    # loopback only — it spawns whatever a client names; OBPTERM_DEV_HOST overrides
npm run dev         # Vite on :1420 (listens on all interfaces)
```

`npm test` runs the pane-tree tests. `test/smoke.mjs` is the real check: it drives the built app
in headless Chromium over CDP (splits panes, makes a project, searches, starts a capture) and
fails on any console error —

```sh
docker run -d --rm --name obpterm-chrome --network host -u 0 --entrypoint chromium \
  gotenberg/gotenberg:8 --headless --no-sandbox --remote-debugging-port=9222 --remote-allow-origins=* about:blank
npm run devserver & npx vite preview --port 1420 --host &
node test/smoke.mjs
```

`src/transport.ts` is the only seam: the browser talks to `dev-server.mjs` over a WebSocket,
the app talks to Rust over Tauri IPC. Rust changes are checked from Linux without a Windows box:

```sh
rustup target add x86_64-pc-windows-msvc
cargo check --tests --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc
```

Pass `--tests`: without it the unit tests are not compiled and a broken test only shows up in CI.

(`tauri-build` needs `llvm-rc` on `PATH` for that; `apt install llvm` or extract it from the
`llvm-NN` package.) Pushing to `master` runs `cargo test` + typecheck + a full Windows build;
pushing a `v*` tag also publishes the MSI and exe as a GitHub release.

## Layout

- `src-tauri/src/pty.rs` — one ConPTY per tab, output streamed as raw bytes over a Tauri channel
- `src-tauri/src/config.rs` — config file, defaults, the Sentinel palette
- `src-tauri/src/lib.rs` — plugins, commands, the WebView2 accelerator-key switch
- `src/app.ts` — tabs, panes and projects; `src/layout.ts` — the pane tree; `src/rail.ts` — the rail
- `src/keys.ts` — shortcuts, `src/find.ts` — find bar, `src/menu.ts` — popups, `src/term.ts` — xterm setup
- `src/status.ts` — status bar; `src-tauri/src/claude.rs` — reads Claude Code's login + transcripts
- `dev-server.mjs` — browser dev loop
