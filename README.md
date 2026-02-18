# Technical Delivery Architect

An **Electron** desktop app that displays your recent Microsoft Teams meetings in a day-by-day timeline and lets you read full verbatim transcripts — all powered by [**Work IQ**](https://www.npmjs.com/package/workiq) via MCP protocol. **No Azure app registration, client secrets, or Graph API permissions required.**

![Split-screen layout: transcript on the left, meeting timeline on the right](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

---

## Features

- **Zero app registration** — authentication is handled by Azure CLI + Work IQ internally
- **Entra ID sign-in** — uses your work/school Microsoft account via `az login`
- **Timeline sidebar** (right panel) — meetings grouped by day with hourly time slots, newest first
- **Full transcript viewer** (left panel) — speaker-labelled dialogue blocks parsed from Work IQ responses
- **AI meeting insights** — summary and action items endpoint via Work IQ
- **Generic Q&A endpoint** — ask Work IQ any natural-language question about your data
- **Fluent-inspired UI** — clean Microsoft design language, draggable title bar, responsive layout
- **Robust date parsing** — handles ISO 8601, AM/PM formats, unicode en-dashes, and more

## Prerequisites

Before you begin, make sure you have the following installed:

| Requirement | Version | How to check | Install link |
|---|---|---|---|
| **Node.js** | 18 or later | `node --version` | [nodejs.org](https://nodejs.org/) |
| **Azure CLI** | 2.x | `az --version` | [Install Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) |
| **Work IQ CLI** | latest | `workiq --version` | `npm install -g workiq` |
| **Git** | any | `git --version` | [git-scm.com](https://git-scm.com/) |

You also need:

- A **Microsoft 365 work/school account** (Entra ID / Azure AD)
- Teams meetings with **transcription enabled** (so transcripts exist to fetch)

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/jrubiosainz/demo-prep-assistant.git
cd demo-prep-assistant
```

### 2. Install dependencies

```bash
npm install
```

This installs Electron, Express, and dotenv — all dependencies are listed in `package.json`.

### 3. Sign in to Azure CLI

Work IQ uses your Azure CLI session for authentication. Sign in once:

```bash
az login --allow-no-subscriptions
```

A browser window will open. Sign in with your **Microsoft 365 work/school account**. Once authenticated, the terminal will confirm your account.

### 4. Install Work IQ globally (if not already installed)

```bash
npm install -g workiq
```

Verify it's accessible:

```bash
workiq --version
```

### 5. (Optional) Create a `.env` file

No `.env` file is required by default. If you want to customize the Express server port:

```bash
cp .env.example .env
```

Edit `.env` and set `PORT=3000` (or any port you prefer). The Electron app ignores this and picks a random port automatically.

## Running the App

```bash
npm start
```

This launches the Electron desktop window. The app will:

1. Start an internal Express server on a random port
2. Check your Azure CLI session (`az account show`)
3. Show a login screen — click **"Sign in with Microsoft"** to run `az login` if needed
4. Once authenticated, load your recent Teams meetings into the timeline sidebar
5. Click any meeting → its full transcript appears in the left panel

### Development mode

```bash
npm run dev
```

Same as `npm start` but passes the `--dev` flag to Electron for debugging.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                     Electron Main Process                    │
│  main.js — creates BrowserWindow, starts Express, IPC       │
├─────────────┬───────────────────────────────────────────────┤
│  preload.js │  contextBridge: getAuthStatus, login, logout  │
├─────────────┴───────────────────────────────────────────────┤
│                     Express API Server                       │
│  server.js — routes + static files on random port            │
├─────────────────────────────────────────────────────────────┤
│  auth/msalConfig.js    │  Azure CLI session management       │
│  lib/workiq.js         │  MCP JSON-RPC ↔ workiq mcp         │
│  routes/meetings.js    │  /api/meetings, /transcript, etc.   │
├─────────────────────────────────────────────────────────────┤
│                   Work IQ MCP Protocol                       │
│  Spawns `workiq mcp` → JSON-RPC initialize → tools/list     │
│  → tools/call (workiq_ask) → natural language answer         │
│  Auth handled internally by Work IQ (Entra ID / Azure CLI)  │
└─────────────────────────────────────────────────────────────┘
```

### Data flow

1. **`npm start`** → Electron boots → starts Express on port 0 (random) → opens BrowserWindow
2. The app checks if `az account show` returns a valid user. If not, the login overlay is shown.
3. **Load meetings** → `GET /api/meetings` → spawns `workiq mcp` child process → sends a JSON-RPC query asking for the last 7 days of Teams meetings as a markdown table
4. The frontend **parses the markdown table** (subject, start/end dates, organizer) and renders a **day-by-day timeline** with hourly slots
5. **Click a meeting** → `GET /api/meetings/transcript?subject=...&date=...` → Work IQ fetches the full verbatim transcript (10-minute timeout for long meetings)
6. The frontend parses speaker lines (`> Speaker: text` or `Speaker: text`) and renders them as dialogue blocks with speaker labels

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/me` | Check auth status (returns `{ authenticated, name }`) |
| `GET` | `/api/meetings` | Fetch recent Teams meetings (last 7 days) via Work IQ |
| `GET` | `/api/meetings/transcript?subject=...&date=...` | Get full verbatim transcript for a specific meeting |
| `GET` | `/api/meetings/insights?subject=...&date=...` | Get AI summary + action items for a meeting |
| `POST` | `/api/ask` | Send any question to Work IQ (`{ "question": "..." }`) |
| `GET` | `/auth/logout` | Sign out (clears Azure CLI session) |

## Project Structure

```
demo-prep-assistant/
├── main.js                    # Electron main process — window + IPC
├── preload.js                 # Secure bridge (contextBridge) for renderer
├── server.js                  # Express API server (started by Electron)
├── auth/
│   └── msalConfig.js          # Azure CLI auth: login, logout, status
├── lib/
│   └── workiq.js              # Work IQ MCP JSON-RPC client
├── routes/
│   ├── auth.js                # Legacy auth status/logout routes
│   └── meetings.js            # Meeting list, transcript, insights, ask
├── public/
│   ├── index.html             # App shell — split layout + login overlay
│   ├── css/
│   │   └── styles.css         # Fluent-inspired responsive styles
│   └── js/
│       └── app.js             # Frontend: timeline, transcript parser, UI
├── .env.example               # Optional config template
├── .gitignore                 # Excludes node_modules/ and .env
├── package.json               # Dependencies: electron, express, dotenv
└── README.md                  # This file
```

## Troubleshooting

### "Not authenticated" error
Make sure you're signed in to Azure CLI:
```bash
az account show
```
If not signed in, run `az login --allow-no-subscriptions`.

### Meetings show as "Other" with no time slots
Work IQ sometimes returns dates in unexpected formats (unicode hyphens, different date layouts). The app has robust date parsing, but if parsing fails, meetings appear in an "Other" section as a flat list. They are still clickable.

### Transcript is empty or cut off
- Work IQ has internal content policies that may limit transcript output for very long meetings.
- The app uses a 10-minute timeout for transcript queries. If a meeting was very long, the query may still time out.
- Try asking for the transcript again — Work IQ responses can vary between runs.

### `workiq` command not found
Make sure Work IQ is installed globally:
```bash
npm install -g workiq
workiq --version
```
On Windows, the app looks for `workiq.cmd` in `%APPDATA%\npm\`.

### Electron window doesn't open
Kill any lingering Electron processes and try again:
```bash
# Windows
Get-Process -Name "electron*" | Stop-Process -Force

# macOS / Linux
pkill -f electron
```
Then run `npm start` again.

## License

Private project — not licensed for redistribution.
