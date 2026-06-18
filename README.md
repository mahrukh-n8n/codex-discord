<p align="center">
  <img src="docs/icon-rounded.png" alt="Codex Discord Controller" width="120">
</p>

# Codex Discord Controller

Control local Codex workspaces from Discord.
Run Codex on your own machine, keep one Discord channel mapped to one project folder, and continue the same local threads from phone, desktop, or VS Code.

**No manually pasted API key required.** The bot uses your local `codex login` session.

> **[한국어 문서](docs/README.kr.md)** | **[Setup Guide](SETUP.md)**

## What This Project Is

`codex-discord` is a self-hosted Discord bot that sits on the same machine as your local projects and your Codex CLI login.

It gives you a Discord-native control surface for Codex:

- register a Discord channel to a local folder
- send normal messages to start or continue a Codex thread
- resume existing local Codex threads for that project
- approve file edits and command execution from Discord buttons
- stop active turns, inspect the queue, and fetch the last response

Because it reads local Codex thread storage under `~/.codex`, threads created in VS Code Codex can also show up in `/sessions` for the same project path.

## Why Use Discord for Codex?

- Already on your phone: no extra mobile UI to build or maintain
- Push notifications for approvals and task completion
- Channels work well as per-project workspaces
- Discord buttons and select menus cover most control UI needs
- Easy multi-machine setup: one bot per machine, one server for all workspaces

## Key Features

- Uses your logged-in Codex account via `codex login`
- One Discord channel = one local project directory
- Resume existing Codex threads from local `~/.codex` state
- Works with threads created by this bot and with VS Code Codex threads for the same project path
- Discord approval UI for tool calls and file changes
- Interactive user-input questions from Codex surfaced in Discord
- MCP elicitation requests from Codex are handled through Discord prompts
- Per-channel Codex model and reasoning-effort settings with autocomplete
- Stop active turns from a button or `/stop`
- Queue follow-up prompts while a task is already running
- Attachment support for images and files
- Codex usage snapshot from Discord with `/usage`
- Completion summaries are appended to the final streamed reply with model, reasoning, context, and limit status when available
- Desktop control panels on Linux and Windows can also show the same cached Codex usage snapshot
- SQLite-backed project/session mapping
- Allowed-user whitelist, rate limiting, and path validation
- Background launchers for macOS, Linux, and Windows

## How It Works

```text
[Discord]
    |
    v
[discord.js bot]
    |
    v
[Codex session manager]
    |
    +--> Codex app-server protocol
    +--> ~/.codex state_*.sqlite
    +--> rollout JSONL logs
```

- The bot stores channel-to-project mappings in local SQLite.
- When a message arrives, it starts or resumes a Codex thread for that project.
- `/sessions` reads local Codex thread metadata and lets you resume an existing thread.
- Assistant output is streamed back into Discord and split safely for long messages and code blocks.

## Requirements

- Node.js 20+
- Codex CLI installed: `@openai/codex`
- Logged in locally with `codex login`
- A Discord bot token
- A Discord server ID and allowed user ID list

## Installation

```bash
git clone https://github.com/mahrukh-n8n/codex-discord.git
cd codex-discord

# macOS / Linux
./install.sh

# Windows
install.bat
```

## Setup Guides

| Language | Guide |
|---|---|
| English | [SETUP.md](SETUP.md) |
| Korean | [docs/SETUP.kr.md](docs/SETUP.kr.md) |

If you prefer manual setup or want the full Discord bot creation walkthrough, follow the setup guide.

## Quick Start

1. Log in to Codex on the same machine that will run the bot.

```bash
codex login
codex login status
```

Windows PowerShell note:

- if `codex login status` fails because PowerShell resolves `codex` to `codex.ps1`, run `codex.cmd login status` instead
- the Windows bot and tray auto-detect a working Codex command (`codex.cmd`, `codex.exe`, or `codex`) and cache it in `~/.codex/codex-discord-runtime.json`

2. Create `.env` from `.env.example`.

```bash
cp .env.example .env
```

3. Fill in:

```env
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=...
ALLOWED_USER_IDS=123456789012345678
BASE_PROJECT_DIR=/Users/you/projects
RATE_LIMIT_PER_MINUTE=10
SHOW_COST=false
```

Do not add `OPENAI_API_KEY` to `.env` for normal use. This project uses your local `codex login` session instead.

4. Start the bot.

```bash
# macOS
./mac-start.sh

# Linux
./linux-start.sh

# Windows
win-start.bat
```

## Setup Checklist

Before the first real run, make sure you have done all of these:

1. `codex login` on the same machine that will run the bot
2. created a Discord application and bot
3. enabled `MESSAGE CONTENT INTENT`
4. invited the bot with `bot` and `applications.commands` scopes
5. copied your server ID and allowed user ID
6. filled `.env`
7. started the platform launcher

The full illustrated walkthrough is in [SETUP.md](SETUP.md).

## Panel Preview

A quick look at the Discord control panel and session flow:

<p align="center">
  <img src="docs/panel.png" alt="Codex Discord panel preview" width="900">
</p>

For setup screenshots and the full step-by-step install guide, see [SETUP.md](SETUP.md).

## Commands

| Command | What it does |
|---|---|
| `/register <path>` | Link the current channel to a project directory |
| `/unregister` | Remove the channel-to-project mapping |
| `/status` | Show registered project status across the server |
| `/stop` | Interrupt the current Codex turn in this channel |
| `/auto-approve on\|off` | Toggle approval bypass for the current channel |
| `/model [model] [reasoning] [new_session]` | View or set the Codex model and reasoning effort for new threads in this channel |
| `/sessions` | List and resume existing local Codex sessions for the project |
| `/last` | Show the last assistant response from the current session |
| `/usage` | Show Codex rate-limit usage from your local account |
| `/queue list` | Show queued prompts for this channel |
| `/queue clear` | Clear queued prompts |
| `/clear-sessions` | Remove stored session mappings for the current project |

## Typical Workflow

1. In a Discord channel, run `/register`.
2. Pick or type a project folder under `BASE_PROJECT_DIR`.
3. Send a normal message like `fix the failing tests`.
4. If Codex wants to run a command or edit files, approve or deny in Discord.
5. Use `/sessions`, `/last`, or `/usage` later to inspect the current project state.

### Model and Reasoning Settings

Use `/model` in a registered channel to view or set Codex settings for that project channel.

- `model` uses Discord autocomplete from your local `~/.codex/models_cache.json`
- `reasoning` uses autocomplete and adapts to the selected model when the local model cache includes supported reasoning levels
- choosing `default` clears the override and lets Codex use its normal local config
- `new_session:true` prepares a fresh session so the next normal message starts a new Codex thread with the selected settings

These settings are stored in the local SQLite project mapping and apply when the bot starts a new Codex thread. Existing Codex threads keep their own original model/reasoning behavior.

## Project Path Model

The bot enforces a base directory boundary:

- `BASE_PROJECT_DIR` is the root users are allowed to register under
- `/register my-app` becomes `BASE_PROJECT_DIR/my-app`
- nested paths like `/register apps/api-server` are also supported in autocomplete
- absolute paths are allowed only if they still resolve inside `BASE_PROJECT_DIR`
- if the folder does not exist yet, `/register` can create it

This keeps the Discord UI simple while preventing arbitrary path traversal outside the allowed project root.

## Attachments

When you attach files in Discord:

- files are downloaded into `<project>/.codex-uploads/`
- images are appended to the prompt as local file paths
- non-image files are also appended as local file references
- blocked executable types are rejected
- files over 25 MB are skipped

## Codex Session Behavior

This project is built around Codex's local storage model:

- local thread metadata is read from `~/.codex/state_*.sqlite`
- rollout logs are read from the JSONL files tracked by that state DB
- `/sessions` filters threads by project `cwd`
- fresh completion metadata is read from the thread rollout when available

That means a thread you used in VS Code Codex for the same project can appear in Discord and be resumed there.

Practical note:

- light handoff between Discord and VS Code works well
- driving the exact same thread aggressively from both surfaces at once is not recommended

## MCP and User Input

Codex can ask the app-server client for approvals or user input while a turn is running. The bot maps those requests into Discord UI:

- command/file-change approvals appear as Discord buttons
- Codex user-input requests appear as Discord prompts with buttons or custom input
- MCP elicitation requests are converted into Discord questions and answered back with the app-server `action` field Codex expects
- if a request arrives for a stale or missing active session, the bot cancels it instead of leaving Codex waiting

This allows MCP flows such as deployment confirmations or structured prompts to continue from Discord.

## Completion Summary

When a turn finishes, the bot appends a compact summary to the end of the final streamed reply instead of sending a separate completion message.

Example:

```text
...assistant response...

✅ Task Complete | gpt-5.5 / medium | 34.7s
Context Used | 39%
Limit | 5H 81% - W 97%
```

The context percentage comes from Codex token-count data for the turn. The limit line comes from the latest Codex rate-limit snapshot in the rollout or a fresh account rate-limit read when rollout data is unavailable.

## Security Notes

- No HTTP server is opened by this project
- access is limited to `ALLOWED_USER_IDS`
- rate limiting is enforced per user
- project registration is restricted to `BASE_PROJECT_DIR`
- executable attachments are blocked
- your Discord bot token lives in `.env`; do not share it

## Platform Launchers

### macOS

- `./mac-start.sh` starts the bot in background and launches the menu bar app
- `./mac-start.sh --fg` runs foreground mode for debugging
- `./mac-start.sh --stop` stops the bot
- `./mac-start.sh --status` checks status

### Linux

- `./linux-start.sh` starts the bot via `systemd --user`
- if a desktop session is available, it also starts the tray app
- the tray menu can open a separate Linux control panel for status, usage, and bot controls
- `./linux-start.sh --fg` runs foreground mode for debugging

### Windows

- `win-start.bat` starts the bot and tray app
- `win-start.bat --fg` runs foreground mode
- `win-start.bat --stop` stops the bot
- the tray panel can show status, controls, and cached Codex usage
- the Windows launcher reuses the detected Codex command on future runs

## Development

```bash
npm install
npm run build
npm test
npm run dev
```

## Project Structure

```text
codex-discord/
├── src/
│   ├── bot/        # Discord client, commands, handlers
│   ├── codex/      # Codex app-server client and session manager
│   ├── db/         # SQLite project/session mapping
│   ├── security/   # whitelist, rate limit, path validation
│   └── utils/      # config and i18n helpers
├── menubar/        # macOS menu bar app
├── tray/           # Linux/Windows tray apps
├── install.sh
├── install.bat
├── mac-start.sh
├── linux-start.sh
├── win-start.bat
└── SETUP.md
```

## Limitations

- The Discord bot app name is configured in Discord Developer Portal, not in this repo
- Codex login-based runs do not currently expose reliable per-turn billing data here, so zero-cost completion footers are hidden
- For best results, avoid racing the same thread from multiple clients at the same time

## Changelog

### Unreleased

- Added `/model` to view and set per-channel Codex model and reasoning effort.
- Added model and reasoning autocomplete based on local Codex model cache.
- Added DB fields and migrations for per-project Codex model settings.
- Passed selected model and reasoning effort into new Codex app-server threads.
- Added model and reasoning details to `/status`.
- Fixed MCP elicitation responses by returning the required `action` field and structured content.
- Added cancellation handling for stale MCP/user-input requests.
- Suppressed duplicate non-actionable `write_stdin` stderr noise while keeping real Codex errors visible.
- Changed task completion reporting to append a compact summary to the final streamed reply.
- Added context and Codex rate-limit status to completion summaries when available.
- Hardened `.gitignore` for runtime logs and SQLite files.

## License

MIT. See [LICENSE](LICENSE).
