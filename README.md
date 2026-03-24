# ai-browser-bridge

A lightweight Chrome extension that bridges AI agents to the user's browser — silently, without mouse takeover.

## How It Works

```
AI Agent (Server)
    ↓ send command
Relay Server (WebSocket Hub)
    ↑ persistent connection (browser connects out)
Chrome Extension (User's browser)
    └── chrome.scripting.executeScript → silent DOM access
```

Users only need to install the extension. No CLI tools, no setup.

## Features

- **Silent execution** — operates via JS injection, never takes over the mouse
- **Lightweight** — ~50KB, no site-specific logic bundled
- **Server-side adapters** — scraping logic stays on the server (opencli-compatible)
- **Secure** — JWT auth, per-user session isolation

## Project Structure

```
ai-browser-bridge/
├── extension/          # Chrome Extension (MV3)
│   ├── manifest.json
│   ├── src/
│   │   ├── background.ts   # Service Worker + WebSocket client
│   │   └── content.ts      # DOM execution helper
│   └── package.json
├── relay/              # Relay Server (Node.js)
│   ├── src/
│   │   └── server.ts       # WebSocket hub + REST API
│   └── package.json
└── .env.example
```

## Security

- All connections authenticated via JWT
- `.env` is gitignored — never commit secrets
- Per-user session isolation via workspace ID

## License

MIT
