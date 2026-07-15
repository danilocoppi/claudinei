# Claudinei

Local web interface to control **multiple Claude Code sessions**, each one in the context of its own project.

<p align="center">
  <img src="https://github.com/user-attachments/assets/ef75eeb6-8598-469e-98fc-2588010d49b9" alt="Claudinei in action — chatting with the engines, tool calls and live streaming" width="850">
</p>

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
- Multi-project, multi-session, resume conversations (`--continue`/`--resume`), notifications, i18n (en/es/pt-BR).

Everything runs **on `127.0.0.1` only** — nothing is exposed to the network.

## Architecture

```
Termaster/
├── server/   Fastify 5 + better-sqlite3 + node-pty + sherpa-onnx  → http://127.0.0.1:9105
├── web/      React 18 + Vite 6 + zustand + xterm.js               → http://localhost:9100 (proxy to 9105)
└── scripts/  utilities (emoji font for Linux)
```

The frontend talks to the backend via REST + WebSocket (`/ws` for session events; `/ws/terminal/:id` for the embedded terminal's binary channel). Data lives in `~/.claudinei/` (SQLite, uploads, voice model). Upgrading from an older install? The legacy `~/.termaster/` folder is migrated automatically on first boot.

## Prerequisites (both platforms)

| Requirement | Detail |
|---|---|
| **Node.js 22+** | developed and tested with **Node 24** |
| **npm** | the repo uses npm workspaces (a single root `node_modules`) |
| **Claude Code CLI** | the `claude` binary on PATH, **already authenticated** (run `claude` once → login). Install with `npm install -g @anthropic-ai/claude-code` |
| **git** | used by Claude Code's normal workflows |
| **curl + tar** | used by the optional voice-transcription setup (standard on Linux and Windows 10+) |

---

## 🐧 Linux

> Tested on Zorin OS / Ubuntu. This is the reference platform — all validation smoke tests ran here.

### 1. Install

```bash
git clone <this-repo> Termaster
cd Termaster
npm install
```

### 2. The `node-pty` gotcha (important)

The embedded terminal uses **`node-pty`**, a native C++ module. It ships **no prebuilt binary for Linux** — it compiles during `npm install`, and with **Node 24 it requires a C++20-capable compiler (g++ 10 or newer)**.

- **Ubuntu 22.04+ / recent distros:** the default g++ is enough; `npm install` compiles it on its own.
- **Ubuntu 20.04 / Zorin 16 (g++ 9.4):** the build fails with `unrecognized command line option '-std=gnu++20'`. Fix it like this:

```bash
sudo apt install -y gcc-10 g++-10
cd node_modules/node-pty
CXX=g++-10 CC=gcc-10 npm run install
cd ../..
```

Verify:

```bash
node -e "require('node-pty'); console.log('node-pty OK')"
```

> ⚠️ **If you recreate `node_modules`** (`rm -rf node_modules`, `npm ci`), repeat the `CXX=g++-10` block above — npm falls back to the default g++ and the build fails again (sometimes silently).

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

```bash
npm run dev          # dev: backend (9105) + Vite (9100) together, with hot reload
```

**Single command (one process, one port)** — the backend serves the built SPA too:

```bash
npm run build -w web    # build the frontend once (or whenever it changes)
npm start               # or: node bin/claudinei.mjs  →  http://127.0.0.1:9105
```

The first run auto-downloads the Parakeet voice model if missing. Flags: `npm start -- --host 0.0.0.0 --port 9105` (exposing on the LAN is refused without auth — pass `--insecure` to force it on a trusted network, at your own risk).

Or in two terminals (cleaner logs):

```bash
npm run dev -w server   # Fastify at http://127.0.0.1:9105
npm run dev -w web      # Vite at http://localhost:9100
```

Open **http://localhost:9100**, create a project pointing at one of your folders and start a session.

### 6. Start with the system (systemd)

Two **user** services (no root needed; they run with your PATH/HOME, which is where `claude` and `~/.claudinei` live):

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/claudinei-server.service <<'EOF'
[Unit]
Description=Claudinei backend (Fastify)
After=network.target

[Service]
WorkingDirectory=%h/Projects/Termaster/server
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
WorkingDirectory=%h/Projects/Termaster/web
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

> Adjust `%h/Projects/Termaster` if the repo lives elsewhere, and `Environment=PATH=` to include wherever **your** `node`/`claude` live (`which node`, `which claude`).

- **Status/logs:** `systemctl --user status claudinei-server` · `journalctl --user -u claudinei-server -f`
- **Stop/disable:** `systemctl --user disable --now claudinei-server claudinei-web`
- By default, user services start **at your login**. To start them **at boot, before login**:
  ```bash
  sudo loginctl enable-linger $USER
  ```

---

## 🪟 Windows

> The code was **designed** to be cross-platform (no hardcoded paths, shell-less spawn, ConPTY via node-pty), but it has **not been validated** on Windows yet. These steps are the expected path; if anything fails, WSL is the guaranteed route.

### Option A — WSL2 (recommended)

Inside WSL you get exactly the tested Linux environment:

```powershell
wsl --install -d Ubuntu-24.04
```

Inside the WSL Ubuntu, follow the **Linux** section above (on 24.04 the default g++ compiles node-pty without tweaks; the voice setup works identically). The Windows browser reaches `http://localhost:9100` normally.

**Autostart with WSL:** the simple way is a Windows scheduled task that kicks WSL at logon:

```powershell
schtasks /create /tn "Claudinei (WSL)" /sc onlogon ^
  /tr "wsl -d Ubuntu-24.04 -u YOUR_USER bash -lc 'cd ~/Termaster && npm run dev'"
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
git clone <this-repo> Termaster
cd Termaster
npm install
npm run dev -w server    # in one terminal
npm run dev -w web       # in another terminal
```

> The root `npm run dev` uses `&`/`wait` (POSIX shell syntax) and **does not work in PowerShell/cmd** — start the two workspaces in separate terminals (or use Git Bash).

**`claude` binary caveat:** on Windows, npm's global `claude` is a `claude.cmd` shim. If spawning fails, point to it explicitly:

```powershell
$env:CLAUDINEI_CLAUDE_BIN = "C:\Users\<you>\AppData\Roaming\npm\claude.cmd"
```

### Start with Windows (Task Scheduler)

1. Create `C:\Users\<you>\Termaster\start-claudinei.cmd`:

```bat
@echo off
cd /d C:\Users\<you>\Termaster\server
start "claudinei-server" /min cmd /c "npx tsx src/index.ts"
cd /d C:\Users\<you>\Termaster\web
start "claudinei-web" /min cmd /c "npx vite --port 9100 --strictPort"
```

2. Register it at logon:

```powershell
schtasks /create /tn "Claudinei" /sc onlogon /tr "C:\Users\<you>\Termaster\start-claudinei.cmd"
```

(Alternatives: a shortcut to the `.cmd` in the `shell:startup` folder, or [NSSM](https://nssm.cc) to run it as a real service with automatic restarts.)

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
service — no root needed (it runs with your PATH/HOME, where `claude`/`codex`/`opencode`
and `~/.claudinei` live):

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/claudinei.service <<'EOF'
[Unit]
Description=Claudinei
After=network.target

[Service]
ExecStart=%h/Projects/Termaster/release/claudinei-linux-x64
# expose on the LAN instead? use:
# ExecStart=%h/Projects/Termaster/release/claudinei-linux-x64 --host 0.0.0.0
Restart=on-failure
RestartSec=3
# claude/codex/opencode must be on the service PATH (check with `which claude`):
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now claudinei
```

> Adjust `%h/Projects/Termaster` if the repo lives elsewhere, and `Environment=PATH=`
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
| `CLAUDE_CONFIG_DIR` | `~/.claude` | where Claude Code keeps transcripts (history) and credentials (usage card) |
| `CLAUDINEI_SPEECH` | `~/.claudinei/speech` | voice model folder (Parakeet) |
| `CLAUDINEI_UPLOADS` | `~/.claudinei/uploads` | chat uploads (automatic rotation) |
| `CLAUDINEI_API` | `http://127.0.0.1:<port>` | URL the hermes MCP uses to talk to the backend |
| `CLAUDINEI_HERMES_SCRIPT` | `server/hermes/hermes-mcp.mjs` | hermes MCP server path |
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

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `EADDRINUSE 127.0.0.1:9105` on startup | a backend is already running (another terminal, systemd, background) | `pkill -f "tsx.*src/index.ts"` (or `systemctl --user stop claudinei-server`) and start again |
| Embedded terminal errors on open | node-pty without a compiled binary (Linux, old g++) | **Linux → node-pty** section |
| 🎤 says "transcription model not installed" | voice setup never ran | `cd server && npm run setup:speech` |
| 🎤 transcribes nonsense | microphone signal too low (the app warns "signal too low") | raise the mic's physical gain; speak closer |
| Usage card doesn't show | no `~/.claude/.credentials.json` (Claude Code not logged in) | run `claude` and log in |
| Embedded terminal: "disconnected" banner | backend crashed/restarted | click **Reconnect** — the session comes back with `--resume` |
| Emojis as □ | old emoji font (Linux) | `scripts/install-emoji-font.sh` + fully restart the browser |
| Session stuck "in terminal" after a crash | process killed without cleanup | restart the backend — boot normalizes it to `stopped` |
| Port 9105/9100 taken | another instance | `CLAUDINEI_PORT=…` and adjust the proxy in `web/vite.config.ts` |
