# AudioLead

Portable publisher lead generation helper for discovering article-publishing websites with ads, verifying they do not yet have an audio reader, enforcing **Already Contacted (cooldown)** and **Opt-Out** suppression lists, and finding ranked decision-maker contact emails.

- **GitHub Repository:** https://github.com/janlofredy/audiolead
- **Container Image:** `ghcr.io/janlofredy/audiolead:latest`
- **CasaOS LAN URL:** `http://192.168.1.5:3450` (data stored in `/DATA/AppData/audiolead`)

## Local Development

```bash
pnpm install
pnpm dev
```

- Frontend (Vite): http://localhost:5173
- Backend API (Hono): http://localhost:3001

## Production Build & Run

```bash
pnpm build
pnpm start
```

Runs a single Node.js server on `http://localhost:3000` (configurable via `PORT` and `DB_PATH`).

## CasaOS Deployment

`casaos-compose.yml` is pre-configured for CasaOS (`casaos-cli app-management install -f casaos-compose.yml`), mapping container port `3000` to host port `3450` and persisting SQLite data under `/DATA/AppData/audiolead`.
