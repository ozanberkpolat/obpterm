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
| `Ctrl+Tab` | Back to the tab you were just in |
| `Ctrl+Shift+Tab` | Previous tab in the rail |
| `Ctrl+Shift+↑` / `Ctrl+Shift+↓` | Move this tab up / down the rail |
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

## What each tab is doing

Every rail row carries one glyph for the state of its shell, in a fixed slot at the right:

| | State | Means |
| --- | --- | --- |
| ● | running | it printed something in the last two seconds |
| ○ | idle | quiet, presumably at a prompt |
| ▲ | waiting | a bell rang while you were looking at something else |
| ✕ | exited | the shell ended with a non-zero code; the subtitle says which |

A tab with several panes shows the loudest of them (waiting, then exited, then running), a
collapsed project rolls its states up into its header so nothing hides inside it, and the rail's
header counts what is waiting. Focusing a tab answers its bell. Nothing blinks.

Claude Code rings the bell only when `preferredNotifChannel` is set to `terminal_bell` — its
default, `auto`, stays silent in a terminal it does not recognise.

## Supervising agents

Every Claude Code session reports what it is doing through Claude's own hooks — a marked,
removable block OBPTerm installs into `settings.json` automatically (Settings → Files & reset
takes it out). No output parsing, nothing configured per shell, and a plain terminal ignores
it. What that buys, per pane:

- **True states in the rail.** ▲ now means *needs you* — a permission prompt or a question —
  not just a bell; a filled dot means *finished while you were elsewhere, unread*; running
  means the agent is actually mid-turn. The subtitle shows what it is doing ("Editing
  pty.rs", "Running cargo check…") and, when it finishes, what it said.
- **Answer a permission prompt from the rail.** Right-click the tab: Allow / Deny, without
  focusing it. The verdict rides the hook's own reply; if you do nothing for 40 seconds the
  normal in-pane prompt appears, exactly as without OBPTerm. A prompt on the pane you are
  already looking at is passed straight through — no delay.
- **Reboots stop costing conversations.** A Claude profile is launched with a session id
  OBPTerm mints; after a reboot (which no session host survives) the restored pane runs
  `claude --resume` on it and the conversation continues. `/clear` and `/compact` are
  tracked through the hooks.
- **Tabs name themselves.** Claude titles every session; the tab uses that name (or your
  `/rename`) until you name it yourself with F2.
- **Eco.** A session that finished and sat unread for half an hour (configurable) is
  `/exit`ed — each idle Claude process holds ~335 MB — and the tab stays, marked; clicking
  it resumes the same conversation.

The hooks POST to a loopback port the session host owns. Claude Code reads `settings.json`
once, when a session starts, and keeps that URL for the session's whole life — so the port has
to stay put. The host persists it, waits a couple of seconds to reclaim it when it restarts
(the old host is often still holding it for a moment), and keeps listening on the last few
ports it used, so a session that started before a restart is never left posting into a closed
socket. When that does happen, the symptom is `UserPromptSubmit hook error / connect
ECONNREFUSED` printed into the prompt and no session states in the rail; reopening the window
re-points `settings.json` at the live port.

## Being told

A pane that asks for you while you are looking at something else raises a desktop notification
carrying what the program actually said, and flashes the taskbar until you come back. That works
because OBPTerm handles `OSC 9` and `OSC 777` — so set Claude Code's `preferredNotifChannel` to
`iterm2` and its notifications arrive by name, **including from sessions running over SSH**.

Optionally, a pane that was busy and then goes quiet for a while is treated as finished and
says so — the completion signal that needs nothing from the shell. Both switches, and the
quiet threshold, live in Settings → Terminal.

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

A shell that dies leaves its pane on screen with its output; press `r` to run it again in the
same terminal, keeping the scrollback — which is what you want when an SSH connection drops.

A restored pane starts in the directory the shell last reported. PowerShell only reports it if
you ask it to, so add this to your `$PROFILE`:

```powershell
function prompt {
  $p = (Get-Location).Path
  "$([char]27)]9;9;`"$p`"$([char]7)PS $p> "
}
```

Captures are kept for **30 days** and the folder is held under **512 MB**, oldest first — both
adjustable (or turned off with zero) in Settings → Files & reset, applied a few seconds after
launch and by the Clean up now button. A pane that is still recording is never touched.

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
`projects/**/*.jsonl` transcripts in that directory. If a `limits_file` or `limits_url` is set (Settings → Startup & session), the meters show
**Anthropic's own numbers instead** — the real percentage of the 5-hour and weekly limit and
when each resets. Claude Code hands its `rate_limits` payload to whatever `statusLine` command
is configured, so a one-line script that writes that payload to a file is all it takes; a
machine of yours already serving `{fiveHour:{used,resetsAt},weekly:{…}}` works too. Nothing is
contacted unless you fill one of those in, and the local sum stays the fallback.

Without them, **the meters are what this machine sent**
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

## Snippets

Commands you keep retyping live in Settings → Snippets and show up in the palette under
**Snippet**. Picking one types it into the focused pane; with "Press Enter for me" off it is
left on the prompt for you to edit first. Nothing is sent until you pick it.

## The session host

Shells belong to the process that started them, and on Windows nothing changes that — so the
window is not that process. **`obpterm-host.exe`** is: a headless program that owns every pty,
keeps the last megabyte each one printed, and talks to the window over a local socket. Close
the window, update the app, crash — the shells keep running. The next window lists what the
host holds and **reattaches**: each pane gets its history replayed, the modes a program switched
on (bracketed paste, mouse reporting) re-asserted, and a resize so full-screen programs repaint.

What that means day to day:

- **An update no longer costs your sessions.** The updater closes the window, replaces it and
  reopens it; the host was never touched, and the new window says "N shells never stopped".
- **Closing the window is a detach**, never a kill. The shells keep running. To end everything:
  View → Quit and end every shell, or the same in `Ctrl+K`, or the status-bar chip.
- **A reboot still ends them** — the host is a process, not a service. For Claude sessions the
  way back is `claude --resume`; see the next release.
- The host exits on its own five minutes after its last shell ends with no window attached,
  so it is never a leftover. The status bar says when it is holding shells the window is not
  showing, and it never holds anything invisibly.

The host runs from a versioned copy in `%LOCALAPPDATA%\OBPTerm\host\`, under its own name: the
installer cannot replace a running executable and kills `OBPTerm.exe` by name, and the copy
escapes both. It advertises itself in `host.json` next to `config.json` (a random socket name
and a token) — that file is user-only, so nothing else on the machine can find the socket.

### Sleeping tabs

A tab nobody has looked at for ten minutes loses its terminal: the xterm buffer and WebGL
context are gone, the shell keeps running in the host, and the rail keeps reporting what it is
doing from the host's own record (output, bell, exit). Clicking the tab brings the terminal
back with the shell's recent output. Settings → Terminal → Memory sets the delay, or zero to
keep every terminal alive. A tab being captured to a log is never put to sleep.

A tab that comes back after a restart or an update and is not the one in front is built
asleep — no terminal, no WebGL context — and only gets one when you click it. Twenty-five tabs
reopening used to mean twenty-five terminals built and twenty-four torn down a moment later.

### The terminal wins the CPU

By default every shell starts one scheduling notch below the window (Windows BELOW_NORMAL), and
`claude` and every agent it spawns inherit that. It is ordering, not a limit: on an idle machine
Claude gets every cycle; when twenty Node processes have it saturated, the window's few
milliseconds per frame are served first, so it keeps answering clicks. Under saturation Claude
is slower by exactly what the window used. Settings → Terminal → Responsiveness turns it off;
it applies to shells started after the change.

The rail's header shows what idle sessions off screen are holding once it passes a gigabyte
("1.9G idle"), and the session-host chip on the status bar can sleep every one of them in one
click — each tab stays and resumes on click. The status bar's memory gauge shows commit charge
(RAM plus pagefile in use) where Windows reports it, because that is the number the machine
actually runs out of.

### Memory pressure

Above the threshold in Settings → Terminal → Memory (85% of the fuller of RAM and commit
charge, by default), the app acts on every five-second sample rather than once a minute: shells
no tab is showing are ended first, then idle finished sessions biggest first, three at a time
with a thirty-second pause between rounds, and never a session touched in the last ninety
seconds. Each one is named in a toast, and each tab resumes its conversation on click. A
fan-out can take a 16 GB machine from comfortable to swapping inside a minute; this is what
keeps it on the right side of that.

Claude Code has a known leak: a sub-agent's Node process can outlive its agent, and a session
that `/exit`s leaves them behind. Every fifteen seconds the app ends a process only when all
three hold — it was seen inside one of this app's own shells, its parent is gone, and it runs
Claude's own CLI. Nothing else on the machine is ever touched, and each one ended is announced.
Settings → Terminal → Memory turns it off.

## Claude Code logins

Settings → Claude logins switches which login is live in `~/.claude`, the way the homelab's
`/ssh/` terminal does it and with the same layout on disk (`.claude/accounts/<name>/` plus a
`current` marker), so a profile saved on the laptop reads the same way on the VPS.

A switch **saves the live login back into its own slot first** (refresh tokens rotate; a
snapshot from days ago is dead), then copies the other profile over `.credentials.json` and the
two identity keys of `~/.claude.json`. Nothing else is touched. Two refusals keep the save-back
out of the wrong slot: no `current` marker, or a live email that is not the marked profile's —
both mean "save it first". And it **refuses while `claude` is running**, because a live session
rotates its token and would overwrite the one just swapped in, killing both logins. Setup is
once per login, in order: logged in as A → save as `a`; `claude auth login` as B → save as `b`.

This is distinct from **Accounts**, which are environment presets — a second login in its own
folder via `CLAUDE_CONFIG_DIR`. Logins share one folder; accounts keep separate ones.

## Sessions and crashes

The open tabs — pane tree, project, colour, account, host, each pane's reported directory — are
written to `session.json` next to `config.json` on every change (250 ms debounce, flushed on
blur, on close and once a minute) and reopened on the next launch. The file is written to a temp
file and renamed over the old one, so a crash mid-write cannot leave a half-written session.

The tab that was in front comes back in front, and a profile with **Capture to a log
automatically** starts recording every shell it opens — so a crash leaves a file behind even
when you never thought to press `Ctrl+Shift+L`.

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
