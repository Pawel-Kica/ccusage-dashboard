# CC Usage Dashboard

Local browser UI for [ccusage](https://github.com/ryoppippi/ccusage) — Claude Code usage and costs. Dark dashboard with daily/weekly/monthly charts, model breakdowns, and a 30-day default view.

![CC Usage Dashboard](docs/screenshot.png)

## Requirements

- **Node.js** 20+
- **macOS** for the background service installer (manual `npm start` works on any OS)
- **Claude Code** usage data on your machine (read by the bundled `ccusage` CLI)

## Quick start

```bash
git clone git@github.com:Pawel-Kica/ccusage-dashboard.git
cd ccusage-dashboard
npm install
npm run open
```

Opens [http://127.0.0.1:3847](http://127.0.0.1:3847) in your browser.

## Run in the background (macOS)

Install as a LaunchAgent — always on, fixed port, survives reboot:

```bash
npm run install-service
```

Open [http://127.0.0.1:3847](http://127.0.0.1:3847) anytime. Logs: `logs/out.log`, `logs/err.log`.

Remove:

```bash
npm run uninstall-service
```

## Scripts

| Command | Description |
|---|---|
| `npm start` | Start server (port 3847) |
| `npm run open` | Start server and open browser |
| `npm run install-service` | Install macOS LaunchAgent (background) |
| `npm run uninstall-service` | Remove LaunchAgent |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3847` | HTTP port |
| `CACHE_TTL_MS` | `300000` | Server-side cache TTL (5 min) |

Example — different port for install:

```bash
PORT=4000 npm run install-service
```

## How it works

- Node server runs `ccusage claude <report> --json --breakdown`
- 5-minute in-memory cache on server + session cache in the browser
- UI defaults: **Daily**, **last 30 days**, Claude Code only

## License

MIT — see [LICENSE](LICENSE).
