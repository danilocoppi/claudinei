# Claudinei

Local web interface to control **multiple coding-agent sessions** — Claude Code, Codex,
Kimi and OpenCode — each one in the context of its own project.

<p align="center">
  <img src="https://github.com/user-attachments/assets/29657b34-9e70-4947-bf78-472410114ab8" alt="Claudinei overview — sidebar with grouped terminals, sessions and usage" width="850">
</p>

- **Beautiful chat** on top of headless Claude Code (`claude -p --output-format stream-json`): markdown, collapsible tool calls, diffs, token-by-token streaming, subagent visualization.
- **Turn control**: **■** button (or Esc) to stop Claude mid-work; **✏** on your latest messages to fix and resend; **↑** on an empty field navigates message history.
- **Embedded terminal** (node-pty + xterm.js): opens the **real** Claude Code TUI in the browser — permissions, interactive commands, everything headless mode can't do. Button pinned to the session title; **← Back to chat** revives the web session automatically.
- **100% local voice transcription**: the chat's 🎤 records and transcribes with **NVIDIA Parakeet v3** on your backend (25 languages, punctuation, ~30× realtime on CPU). Audio never leaves your machine. Text appears live while you speak.
- **Board & Tasks (hermes MCP)**: agents talk to each other (`ask_agent`), publish to a shared **board** (`post_to_board`) and dispatch **tasks** to one another (`dispatch_task`) with an **automatic queue** — click the ⓘ in the sidebar footer for the full documentation.
- **Usage card**: the `/usage` bars (session, week, per model) in the sidebar, with **pace coloring** — green if your consumption reaches the reset without maxing out, red if you're burning too fast.
- **Per-session ⚙**: hot-swap **model**, **effort** (low→ultracode, persisted) and **permission mode**.
- **Actions**: commands a terminal repeats with one click — name it once (`awsVAEXA` + `npm run deploy`) and it runs in a floating window you can drag, minimize and type into. Survives a page reload: the process lives on the server, so F5 finds the deploy still running instead of starting a second one.
- **Shell shortcut**: a message starting with `!` runs in the terminal's folder instead of going to the agent — `!ls`, `!git status`.
- **Schedules**: recurring tasks per terminal (every N minutes/hours, daily, weekly, monthly or cron), each with its own engine/model/effort and a history of results.
- **Sectors → groups → terminals**: a three-level tree for when a dozen projects stop fitting in a flat list. Collapse the whole sidebar into a rail and depth still reads, without indentation.
- **Open on this machine**: from a terminal's ⋮ menu, open its folder, VS Code or your terminal emulator (which one is configurable) — only when you're browsing from the machine that hosts the server.
- **Multi-user**: login, per-terminal access for non-admins, lockout after failed attempts.
- Multi-project, multi-session, resume conversations (`--continue`/`--resume`), notifications, themes, i18n (en/es/pt-BR).

Everything runs **on `127.0.0.1` only** — nothing is exposed to the network.

<p align="center">
  <img src="https://github.com/user-attachments/assets/ef75eeb6-8598-469e-98fc-2588010d49b9" alt="Claudinei in action — chatting with the engines, tool calls and live streaming" width="460">
</p>

## Architecture

```
claudinei/
├── server/   Fastify 5 + better-sqlite3 + node-pty + sherpa-onnx  → http://127.0.0.1:9105
├── web/      React 18 + Vite 6 + zustand + xterm.js               → http://localhost:9100 (proxy to 9105)
└── scripts/  packaging, emoji font (Linux), autostart (Windows)
```

The frontend talks to the backend via REST + WebSocket (`/ws` for session events; `/ws/terminal/:id` for the embedded terminal's binary channel). Data lives in `~/.claudinei/` (SQLite, uploads, voice model). Upgrading from an older install? The legacy `~/.termaster/` folder is migrated automatically on first boot.

## Installation

### 🤖 The easiest way: clone it and ask an agent

This project is a cockpit for coding agents — so let one of them install it. Clone the
repo, open it with **Claude Code**, **Codex**, **Kimi**, **OpenCode** or whichever agent
you use, and ask it to do the whole thing:

```bash
git clone https://github.com/danilocoppi/claudinei.git
cd claudinei
claude          # or: codex · kimi · opencode · your agent of choice
```

Then paste something like this:

> Install this project on my machine and set it up to start with the operating system.
> Read the README first. Detect my OS and distro, install the dependencies, compile the
> native modules with a compiler that works here, build the single-file binary, and
> register it as a service (systemd user unit on Linux, Task Scheduler on Windows).
> Show me the service file before creating it, and at the end confirm the app answers
> on http://127.0.0.1:9105.

The agent has everything it needs: this README documents each platform's traps, and
`scripts/windows/` already carries the autostart scripts. It will read your actual
environment — compiler version, where `node` and `claude` live, whether you're on WSL —
which is exactly the part that generic instructions get wrong.

**Two things worth asking for:** that it *shows you the service file* before writing it
(it's going to run on every boot), and that it *tells you what it installed globally*.

Prefer doing it by hand? The rest of this section is the manual path, and it's what the
agent will follow anyway.

### Prerequisites (both platforms)

| Requirement | Detail |
|---|---|
| **Node.js 22+** | developed and tested with **Node 24** |
| **npm** | the repo uses npm workspaces (a single root `node_modules`) |
| **Claude Code CLI** | the `claude` binary on PATH, **already authenticated** (run `claude` once → login). Install with `npm install -g @anthropic-ai/claude-code` |
| **Other engines** (optional) | each one is used only if its CLI is on PATH and authenticated: **Codex** (`npm install -g @openai/codex`), **OpenCode** (`npm install -g opencode-ai`), **Kimi Code** (`npm install -g @moonshot-ai/kimi-code`, then `kimi login`) |
| **git** | used by Claude Code's normal workflows |
| **curl + tar** | used by the optional voice-transcription setup (standard on Linux and Windows 10+) |

---

## 🐧 Linux

> Tested on Zorin OS / Ubuntu. This is the reference platform — all validation smoke tests ran here.

### 1. Install

```bash
git clone https://github.com/danilocoppi/claudinei.git
cd claudinei
npm install
```

### 2. The compiler gotcha (important)

Three native C++ modules get compiled here — **`node-pty`** (embedded terminal),
**`better-sqlite3`** (database) and **`sherpa-onnx`** (voice). `node-pty` ships **no
prebuilt binary for Linux**, so it always compiles, and with **Node 22+ it requires a
C++20-capable compiler (g++ 10 or newer)**.

- **Ubuntu 22.04+ / recent distros:** the default g++ is enough; `npm install` just works.
- **Ubuntu 20.04 / Zorin 16 (g++ 9.4):** the install fails with `unrecognized command line
  option '-std=gnu++20'` — and npm then **rolls the whole thing back**, leaving you with no
  `node_modules` at all. Point the build at a newer compiler **from the root install**:

```bash
sudo apt install -y gcc-10 g++-10
CC=gcc-10 CXX=g++-10 npm install
```

> Pass the compiler on the **root** `npm install`, not by rebuilding `node_modules/node-pty`
> after the fact: the variables reach every native module in one go, and the failure isn't
> `node-pty`-specific — it's the toolchain.

Verify:

```bash
node -e "require('node-pty'); console.log('node-pty OK')"
```

> ⚠️ **Every time you recreate `node_modules`** (`rm -rf node_modules`, `npm ci`, a fresh
> clone), pass `CC`/`CXX` again — npm falls back to the default g++ and the build fails the
> same way.

### 3. Voice transcription (optional, recommended)

The chat's 🎤 uses **Parakeet v3** running locally on the backend. One time only:

```bash
cd server
npm run setup:speech     # downloads the model (~630 MB) + portable libstdc++ into ~/.claudinei/speech
cd ..
```

- The download happens **once**; nothing is downloaded afterwards.
- The "portable libstdc++" exists because the sherpa-onnx runtime requires `GLIBCXX_3.4.29` (GCC 11+), which Ubuntu 20.04/Zorin 16 doesn't have — the setup solves it **without touching your system** (the lib is loaded only inside the transcription process).
- Without the setup the app works normally — the 🎤 just tells you the model isn't installed.

### 4. Broken emojis (□) in the UI?

```bash
bash scripts/install-emoji-font.sh
```

Then **close the browser completely** and reopen it.

### 5. Run

**To use the app** — one process, one port. The backend serves the built SPA too, so
there's no separate Vite port:

```bash
npm run build -w web    # build the frontend once (or whenever it changes)
npm start               # or: node bin/claudinei.mjs
```

Open **http://127.0.0.1:9105**, create a project pointing at one of your folders and start
a session. The first run auto-downloads the Parakeet voice model if missing. Flags go after
`--`: `npm start -- --host 0.0.0.0 --port 9105` (exposing on the LAN is refused without
auth — pass `--insecure` to force it on a trusted network, at your own risk).

**To work on the app** — two processes and hot reload, on **http://localhost:9100** (Vite
proxies the API to 9105):

```bash
npm run dev             # both together
```

Or in two terminals, for cleaner logs:

```bash
npm run dev -w server   # Fastify at http://127.0.0.1:9105
npm run dev -w web      # Vite at http://localhost:9100
```

> Mind which URL you open: **9105** is the app; **9100** only exists in dev mode.

### 6. Start with the system (systemd)

> **For everyday use, prefer the single-file binary** — one service instead of two, no
> `node_modules` to keep alive, and a restart picks up the new build. Jump to
> [Run the binary as a service](#run-the-binary-as-a-service-systemd). The two services
> below run the app **from source**, which is what you want while developing it.

Two **user** services (no root needed; they run with your PATH/HOME, which is where `claude` and `~/.claudinei` live):

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/claudinei-server.service <<'EOF'
[Unit]
Description=Claudinei backend (Fastify)
After=network.target

[Service]
WorkingDirectory=%h/claudinei/server
ExecStart=/usr/bin/env npx tsx src/index.ts
Restart=on-failure
RestartSec=3
# make sure your user's node/claude are on the service PATH:
Environment=PATH=%h/.local/bin:%h/.local/share/npm/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

cat > ~/.config/systemd/user/claudinei-web.service <<'EOF'
[Unit]
Description=Claudinei frontend (Vite)
After=claudinei-server.service

[Service]
WorkingDirectory=%h/claudinei/web
ExecStart=/usr/bin/env npx vite --port 9100 --strictPort
Restart=on-failure
RestartSec=3
Environment=PATH=%h/.local/bin:%h/.local/share/npm/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now claudinei-server claudinei-web
```

> Adjust `%h/claudinei` if the repo lives elsewhere, and `Environment=PATH=` to include wherever **your** `node`/`claude` live (`which node`, `which claude`).

- **Status/logs:** `systemctl --user status claudinei-server` · `journalctl --user -u claudinei-server -f`
- **Stop/disable:** `systemctl --user disable --now claudinei-server claudinei-web`
- By default, user services start **at your login**. To start them **at boot, before login**:
  ```bash
  sudo loginctl enable-linger $USER
  ```

---

## 🪟 Windows

> **What's actually been tested here.** The autostart (Task Scheduler) was validated on
> Windows 11 — including the no-visible-window behaviour, measured window by window (see
> below). The cross-platform plumbing is deliberate: no hardcoded paths, shell-less spawn,
> ConPTY through node-pty, `PATH` resolution for the embedded terminal, `cmd.exe` quoting
> for Actions. What has **not** had a full end-to-end pass is day-to-day use — chat, voice,
> the engines. If something breaks, WSL is the guaranteed route.

### Option A — WSL2 (recommended)

Inside WSL you get exactly the tested Linux environment:

```powershell
wsl --install -d Ubuntu-24.04
```

Inside the WSL Ubuntu, follow the **Linux** section above (on 24.04 the default g++ compiles node-pty without tweaks; the voice setup works identically). The Windows browser reaches `http://localhost:9100` normally.

**Autostart with WSL:** the simple way is a Windows scheduled task that kicks WSL at logon:

```powershell
schtasks /create /tn "Claudinei (WSL)" /sc onlogon ^
  /tr "wsl -d Ubuntu-24.04 -u YOUR_USER bash -lc 'cd ~/claudinei && npm run dev'"
```

(Or, inside WSL with systemd enabled — `/etc/wsl.conf` with `[boot] systemd=true` — use the systemd services from the Linux section.)

### Option B — Native Windows

**Platform-specific prerequisites:**

1. **Windows 10 1809+ or Windows 11** — node-pty uses the ConPTY API, which only exists from there on.
2. **Claude Code for Windows** installed and authenticated.
3. `node-pty` **ships a prebuilt Windows binary** (`win32-x64`) — normally `npm install` compiles nothing. If it does try to compile and fails:
   ```powershell
   # PowerShell as administrator
   winget install Microsoft.VisualStudio.2022.BuildTools   # "C++ build tools" workload
   npm install -g node-gyp
   ```
4. **Voice transcription:** sherpa-onnx also ships a `win-x64` binary, and Windows 10+ has `curl`/`tar` capable of extracting the model — `cd server; npm run setup:speech` is **expected** to work (the libstdc++ step is irrelevant on Windows: that download is linux-64 and simply isn't used). **Not validated** — if the 🎤 fails, the rest of the app is unaffected.

**Install and run:**

```powershell
git clone https://github.com/danilocoppi/claudinei.git
cd claudinei
npm install
npm run build -w web    # build the frontend once (or whenever it changes)
npm start               # or: node bin\claudinei.mjs
```

Open **http://127.0.0.1:9105** — one process, one port, same as on Linux (the backend
serves the built SPA, so there's no separate Vite port).

**To work on the app** instead, use two terminals:

```powershell
npm run dev -w server    # in one terminal
npm run dev -w web       # in another  →  http://localhost:9100
```

> The root `npm run dev` uses `&`/`wait` (POSIX shell syntax) and **does not work in PowerShell/cmd** — start the two workspaces in separate terminals (or use Git Bash).

**`claude` binary caveat:** on Windows, npm's global `claude` is a `claude.cmd` shim. If spawning fails, point to it explicitly:

```powershell
$env:CLAUDINEI_CLAUDE_BIN = "C:\Users\<you>\AppData\Roaming\npm\claude.cmd"
```

**Embedded terminal:** ConPTY does not search the `PATH`, so a bare command name would
fail with `File not found:` (no name after the colon — that's the tell). `server/src/terminal/pty.ts`
resolves the name against `PATH`/`PATHEXT` before spawning; on Linux/macOS it's a no-op.

**Actions and `!` commands** run through `cmd.exe /c`. `&&` chains work there exactly as in
bash, but the command line is passed **raw**, because the default argument quoting escapes
inner quotes the C compiler's way (`\"`) — which `cmd.exe` doesn't understand, and which
turned a `git commit -m "message"` into literal backslashes. Aliases are the one thing that
doesn't carry over: `doskey` macros don't exist in a non-interactive `cmd /c`, so the
Windows equivalent of a shell alias is a `.bat`/`.cmd` on the `PATH`.

### Start with Windows (Task Scheduler)

The scripts in `scripts\windows\` do it — no administrator needed (the task belongs to
your user, with **your** PATH/HOME, where `claude` and `~\.claudinei` live):

```powershell
npm run build -w web    # the autostart serves web/dist — build before installing
powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
```

That registers a **Claudinei** task with two triggers: your **logon** (20 s delay) starts
the server, and a **watchdog** every 2 minutes brings it back if it ever dies. It starts
right away too — open **http://127.0.0.1:9105**.

**No window at all** — verified by sampling every visible window for 15 s across a start:
zero windows appear, not even a flash. Three things were needed, each learned the hard way:

- The task's action is **`conhost.exe --headless powershell.exe …`**, not `powershell.exe`. On Windows 11 the default terminal application is Windows Terminal, which hosts *any* console app in a window of its own — a black empty window titled `…\powershell.exe`. Neither `-WindowStyle Hidden` nor hiding `GetConsoleWindow()` touches it: under Terminal that handle is a `PseudoConsoleWindow` (an invisible proxy) while the real window belongs to `WindowsTerminal.exe`. Closing it killed the whole hosted tree — server included. A headless conhost creates no window and never delegates to Terminal.
- The server gets **its own console** (`CreateNoWindow`), not the launcher's (`-NoNewWindow`): a console event on a shared console (Ctrl-C, close, session end) kills the server too — it died once with `0xC000013A` (STATUS_CONTROL_C_EXIT) exactly like that.
- That console is hidden, **not absent**. Spawning the server fully detached (no console) looks tempting, but the app spawns the engine CLIs without `windowsHide`, so each one would pop its own console window. An invisible console that children inherit is what keeps them invisible.

Day-to-day:

- **Restart after a rebuild:** `powershell -ExecutionPolicy Bypass -File scripts\windows\restart-claudinei.ps1`.
- **Stop for real:** `…\stop-claudinei.ps1`. Use it instead of just ending the task in the GUI: Task Scheduler kills only the task's own process, leaving the server orphaned on port 9105 (and the watchdog will find it healthy and leave it alone).
- **Logs:** `~\.claudinei\logs\` — `claudinei.log` (stdout), `claudinei.err.log` (stderr), `boot.log` (start/stop/watchdog history); the previous run is kept as `.prev`.
- **Extra flags:** `install-autostart.ps1 -ExtraArgs '--port','9200'` (passed straight to `bin\claudinei.mjs`); watchdog interval: `-WatchdogMinutes 5`.
- **Status:** `Get-ScheduledTask -TaskName Claudinei` · **remove:** `install-autostart.ps1 -Uninstall`.
- A logon task lives with your session: it stops when you log off and comes back on the next logon.
- The `.ps1` files are saved as **UTF-8 with BOM** on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI, and an em dash inside a string then turns into a curly quote that breaks the parser.

(Alternatives: a shortcut in the `shell:startup` folder, or [NSSM](https://nssm.cc) to run it as a real Windows service.)

---

## Production build

The backend runs straight from TypeScript via `tsx` (no build step). The frontend:

```bash
npm run build -w web      # tsc + vite build → web/dist
cd web && npx vite preview --port 9100   # serves the build (same proxy to 9105)
```

For day-to-day local use, dev mode is enough and is how the app was validated. If you prefer serving the build on autostart, swap the `claudinei-web.service` `ExecStart` for `npx vite preview --port 9100 --strictPort`.

## Single-file binary (`npm run package`)

Build a **self-contained executable** with the server, the SPA and the native libs (sqlite, node-pty, voice) all inside one file — no Node/npm needed on the target machine:

```bash
npm run package          # → release/claudinei-linux-x64  (~130 MB)
./release/claudinei-linux-x64          # runs on http://127.0.0.1:9105
./release/claudinei-linux-x64 --host 0.0.0.0               # expose on the LAN — login required
./release/claudinei-linux-x64 --host 0.0.0.0 --insecure    # expose with auth deliberately skipped
```

On first launch the binary extracts its bundled native libs to a cache
(`~/.cache/claudinei/native-<version>/`, or `$XDG_CACHE_HOME`) and — the first time
you use the 🎤 — downloads the Parakeet voice model (~630 MB) to `~/.claudinei/speech`.
Later launches reuse both. The Claude Code CLI is still a prerequisite on the target
(the binary drives it); everything else is in the file.

**Caveats — read before shipping the binary:**
- **One binary per platform.** `npm run package` builds for the machine it runs on
  (the native prebuilts are platform-specific). Windows/macOS binaries must be built
  on those platforms (or a CI matrix) — there is no cross-build from a single machine.
  Building requires the native modules to be compiled first (see the **node-pty gotcha**
  above); the packager fails fast if a prebuilt `.node` is missing.
- **Needs a writable cache.** If `~/.cache` (or `$XDG_CACHE_HOME`) isn't writable, set
  `XDG_CACHE_HOME` to a writable dir. A version bump extracts into a fresh
  `native-<version>` folder (the old one can be deleted by hand).
- **Antivirus / corporate policy** sometimes flags self-extracting executables. If the
  binary is blocked, fall back to `npm start` (the non-packaged single command) or dev mode.

### Run the binary as a service (systemd)

The binary serves the SPA **and** the API on one port (9105), so it's a **single** user
service — no root needed (it runs with your PATH/HOME, where `claude`/`codex`/`opencode`/`kimi`
and `~/.claudinei` live):

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/claudinei.service <<'EOF'
[Unit]
Description=Claudinei
After=network.target

[Service]
ExecStart=%h/claudinei/release/claudinei-linux-x64
# expose on the LAN instead? use:
# ExecStart=%h/claudinei/release/claudinei-linux-x64 --host 0.0.0.0
Restart=on-failure
RestartSec=3
# claude/codex/opencode/kimi must be on the service PATH (check with `which claude`):
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now claudinei
```

> Adjust `%h/claudinei` if the repo lives elsewhere, and `Environment=PATH=`
> to include wherever **your** `node`/`claude` live.

- **Status/logs:** `systemctl --user status claudinei` · `journalctl --user -u claudinei -f`
- **After a rebuild** (`npm run package`): `systemctl --user restart claudinei` picks up the new binary.
- **Stop/disable:** `systemctl --user disable --now claudinei`
- User services start **at your login**. To start at boot, before login: `sudo loginctl enable-linger $USER`.

Then open **http://127.0.0.1:9105** — the whole app is on that one port (there is no
separate Vite port; that only exists in `npm run dev`).

## Multi-user authentication

The first time you open **http://127.0.0.1:9105** you get a **Create master account** screen — pick a username and password and you become the first admin. This setup screen only works from **localhost**; it won't render if you're already being reached over the LAN.

From then on, **every access requires login** — localhost included. The session lives in an `httpOnly` cookie that lasts **7 days**; close the tab, come back later, and you're still in.

### Exposing on the LAN

Once at least one user exists, `--host 0.0.0.0` works **without** `--insecure` — remote visitors land on the login screen instead of a bare shell:

```bash
npm start -- --host 0.0.0.0                 # auth is configured → visitors get the login screen
npm start -- --host 0.0.0.0 --insecure      # skip auth on purpose (trusted network only, at your own risk)
```

With **zero** users configured, `--host 0.0.0.0` **without** `--insecure` is refused at boot — the server won't start at all, so you can't accidentally expose an unauthenticated instance. `--insecure` still exists for that case, if you really want to skip auth.

### Administration

The **👤** menu (sidebar) gives admins:

- **Manage users** — create, edit and delete users; toggle the **admin** flag; restrict each non-admin user to specific terminals (per-terminal access). Non-admin users only see the terminals they've been granted, and don't see **+ Terminal**, **Usage** or filesystem browsing.
- **Revoke all sessions** — bumps every user's token version, sending every logged-in browser (including yours) back to the login screen.
- **Automatic lockout** — 5 failed login attempts on an account locks it for **15 minutes**.

### Change password

Any user can change their own password from the **👤** menu. This invalidates that user's other sessions — other browsers/devices logged in as that user are signed out right away.

### Forgot the master password?

Stop the server and clear the users table:

```bash
sqlite3 ~/.claudinei/claudinei.db "DELETE FROM users;"
```

The next access from `localhost` shows **Create master account** again.

### ⚠️ No TLS

There's no HTTPS here — over the LAN, the password and the session cookie travel **in cleartext**. Fine for a quick session on a trusted home network; for anything more serious, put a **reverse proxy with HTTPS** (nginx, Caddy, Tailscale, …) in front of Claudinei — that's outside this app's scope.

## Tests

```bash
npm test                  # server (vitest) + web (vitest)
npm test -w server        # backend only
npm test -w web           # frontend only
```

Tests do **not** need the native node-pty (fake PTY), the real Claude (`fake-claude`) or the voice model (fake worker).

## Configuration (environment variables)

| Variable | Default | What it does |
|---|---|---|
| `CLAUDINEI_PORT` | `9105` | backend/app port |
| `CLAUDINEI_HOST` | `127.0.0.1` | bind address (`0.0.0.0` to expose on the LAN — requires at least one user configured, or `--insecure`; see **Multi-user authentication**) |
| `CLAUDINEI_DB` | `~/.claudinei/claudinei.db` | SQLite path |
| `CLAUDINEI_CLAUDE_BIN` | `claude` | Claude Code binary (useful on Windows/out-of-PATH installs) |
| `CLAUDINEI_CODEX_BIN` | `codex` | Codex CLI binary |
| `CLAUDINEI_OPENCODE_BIN` | `opencode` | OpenCode CLI binary |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | where Claude Code keeps transcripts (history) and credentials (usage card) |
| `CLAUDINEI_SPEECH` | `~/.claudinei/speech` | voice model folder (Parakeet) |
| `CLAUDINEI_UPLOADS` | `~/.claudinei/uploads` | chat uploads (automatic rotation) |
| `CLAUDINEI_SCHEDULES` | `~/.claudinei/schedules` | scheduled-task results on disk |
| `CLAUDINEI_API` | `http://127.0.0.1:<port>` | URL the hermes MCP uses to talk to the backend |
| `CLAUDINEI_HERMES_SCRIPT` | `server/hermes/hermes-mcp.mjs` | hermes MCP server path |
| `CLAUDINEI_HERMES_COMMAND` | the running `node` | interpreter that starts the hermes MCP |
| `CLAUDINEI_HERMES_ARGS` | — | extra args for it, as a JSON array |
| `CLAUDINEI_KEEP_SESSIONS` | `5` | finished sessions kept per project (startup prune) |

## How to use (quick flow)

1. **+ Terminal** → pick the project folder, icon and color.
2. **▶ Start session** → toggle "Continue last conversation" and "Skip permissions" to taste.
3. Chat away — or click the **🎤** and speak (text appears live; review and send). Tool calls, diffs and subagents render structured.
4. **⚙** next to Send: hot-swap model, **effort** and permission mode.
5. Claude working and you want to stop? **■** (or Esc). Forgot something in your instruction? **✏** on the message → fix → resend.
6. Need the TUI (approve a permission, interactive command)? **🖥 Open in terminal** on the title. **← Back to chat** brings the session back ready.
7. **Board** and **Tasks** in the sidebar show agent collaboration — the **ⓘ** next to "Terminal Interaction" explains everything with examples.
8. The **Usage** card shows your plan limits in real time (color = pace: green = sustainable until reset).
9. Repeating the same commands in a terminal? The **⋮** menu has **Actions** — register them once, run with a click. And a message starting with **`!`** (`!git status`) runs right there instead of going to the agent.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EADDRINUSE 127.0.0.1:9105` on startup | a backend is already running (another terminal, systemd, background) | `pkill -f "tsx.*src/index.ts"` (or `systemctl --user stop claudinei-server`) and start again |
| Embedded terminal errors on open | node-pty without a compiled binary (Linux, old g++) | **Linux → the compiler gotcha** section |
| 🎤 says "transcription model not installed" | voice setup never ran | `cd server && npm run setup:speech` |
| 🎤 transcribes nonsense | microphone signal too low (the app warns "signal too low") | raise the mic's physical gain; speak closer |
| Usage card doesn't show | no `~/.claude/.credentials.json` (Claude Code not logged in) | run `claude` and log in |
| Embedded terminal: "disconnected" banner | backend crashed/restarted | click **Reconnect** — the session comes back with `--resume` |
| Emojis as □ | old emoji font (Linux) | `scripts/install-emoji-font.sh` + fully restart the browser |
| Session stuck "in terminal" after a crash | process killed without cleanup | restart the backend — boot normalizes it to `stopped` |
| Port 9105/9100 taken | another instance | `CLAUDINEI_PORT=…` and adjust the proxy in `web/vite.config.ts` |
