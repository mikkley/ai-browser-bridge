# ai-browser-bridge

A lightweight Chrome extension that bridges AI agents to the user's browser — silent DOM access, no mouse takeover.

## How It Works

```
AI Agent (Server)
    ↓  POST /command
Relay Server              ← deploy on any VPS
    ↑  WebSocket (browser connects out, no firewall issues)
Chrome Extension          ← user installs this
    ↓  chrome.scripting.executeScript
User's Chrome (logged in, mouse untouched)
```

Users only need to install the extension and paste one connect code. No CLI tools, no technical setup.

## Quick Start

### 1. Deploy Relay Server

```bash
git clone https://github.com/mikkley/ai-browser-bridge
cd ai-browser-bridge/relay
npm install
npm run dev
```

On first start, secrets are auto-generated and a Cloudflare Tunnel is created automatically:

```
🚀 AI Browser Bridge Relay
──────────────────────────────────────────────────
🌐 Public URL:  wss://abc123.trycloudflare.com/ws
🔑 Admin connect code:
   bridge_eyJ1cmwiOiJ3c3M6Ly...

🔐 Relay secret: xxxxxxxx
📋 Generate user connect code:  npm run token -- <userId>
──────────────────────────────────────────────────
```

> **Production:** Set `PUBLIC_URL=https://your-domain.com` to skip Cloudflare Tunnel.

### 2. Generate a Connect Code for Each User

```bash
npm run token -- user123
# → bridge_eyJ1cmwiOiJ3c3M6Ly...
```

### 3. User Installs Extension

1. Load `extension/` as an unpacked extension in Chrome
2. Click the extension icon → paste connect code → Connect
3. Done — browser is now available to your AI agent

---

## Project Structure

```
ai-browser-bridge/
├── extension/                  # Chrome Extension (MV3)
│   ├── manifest.json
│   ├── popup.html              # Single connect code field
│   └── src/
│       ├── background.ts       # WebSocket client + command handler
│       └── popup.ts            # Paste & connect UI
│
├── relay/                      # Relay Server (Node.js + TypeScript)
│   └── src/
│       ├── server.ts           # WebSocket hub + HTTP API
│       ├── config.ts           # Auto-generate secrets on first run
│       ├── tunnel.ts           # Cloudflare Quick Tunnel
│       └── cli.ts              # npm run token / npm run info
│
├── .env.example
├── .gitignore                  # .data/ (secrets) excluded
└── README.md
```

---

## Extension Commands

The extension handles these actions silently (no mouse takeover):

| Action | Description |
|--------|-------------|
| `execute` | Run any JS in the page (`element.click()`, etc.) |
| `navigate` | Open a URL in current or new tab |
| `extract` | Get page `text`, `html`, or `title` |
| `cookies` | Get cookies for a domain |
| `tabs` | List open tabs |
| `screenshot` | Capture visible tab as PNG |

## Agent API

```bash
# Send a command to a user's browser
curl -X POST https://your-relay.com/command \
  -H "Authorization: Bearer <agent-jwt>" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "user123",
    "action": "extract",
    "params": { "type": "text" }
  }'
```

## CLI Tools

```bash
npm run token -- <userId>   # Generate connect code for a user
npm run info                # Show current relay URL & config
```

## Security

- All connections authenticated via JWT (auto-generated on first run)
- `.data/` directory (secrets + state) is gitignored — never committed
- Per-user session isolation via userId
- Relay secret required to generate new tokens

## License

MIT
