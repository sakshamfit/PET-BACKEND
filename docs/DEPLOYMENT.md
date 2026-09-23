# Deployment guide — office PC + Cloudflare Tunnel

The intended production shape (from the frontend README):

```
phones / Vercel static build
        │  HTTPS
        ▼
app.plusoneco.in  ── Cloudflare Tunnel ──►  office PC :8080 (this server)
                                                └── data/pet.db + data/files/
```

Everything lives in one folder (default `C:\PET\app`). No database server, no Redis, no build step.

---

## 1. Prerequisites

* Windows 10/11 on the office PC
* **Node.js 20 LTS** (18+ works; 22+ is fine too) — https://nodejs.org
* A Cloudflare Tunnel token for `app.plusoneco.in`
* Git (optional — a zip download works too)

> **No Visual C++ Build Tools required.** `npm install` treats `better-sqlite3` as optional and falls back to `node:sqlite` (Node ≥ 22) or the bundled WASM driver automatically.

## 2. First run

```powershell
cd C:\PET\app
git clone <repo-url> .        # or unzip here

.\scripts\windows\pet-first-run.ps1 `
    -AdminEmail admin@plusoneco.in `
    -BootstrapAdmin `
    -PublicUrl https://app.plusoneco.in
```

This installs dependencies, writes `.env` (with `CORS_ORIGINS` for the Vercel frontend + tunnel domain), and creates the Main Admin. The one-time password is printed **once** — record it and hand it over; the admin must change it at first sign-in.

Manual alternative:

```powershell
npm install
Copy-Item .env.example .env    # then edit
npm run bootstrap-admin -- --email admin@plusoneco.in
npm start
```

Verify: <http://localhost:8080/health> must return `{"status":"ok",...}`.

## 3. Run it as a background service

```powershell
# registers a Scheduled Task "PET-Backend" (SYSTEM, at startup) + starts it
.\scripts\windows\install-server-service.ps1

.\scripts\windows\install-server-service.ps1 -Action Restart   # after updates
.\scripts\windows\install-server-service.ps1 -Action Status
.\scripts\windows\install-server-service.ps1 -Action Remove
```

Logs append to `data\server.log`.

## 4. Expose it on the public URL

```powershell
.\scripts\windows\cloudflare-tunnel.ps1 -Token "<CLOUDFLARE_TUNNEL_TOKEN>"
```

The tunnel forwards `https://app.plusoneco.in` → `http://localhost:8080`. Confirm from any phone:

```
https://app.plusoneco.in/health          → {"status":"ok",...}
```

## 5. Point the frontend at it

* **Vercel static build:** project env var `PET_API_BASE=https://app.plusoneco.in`, redeploy.
* **Already-deployed build:** in-app *Connect to server* screen → type `app.plusoneco.in`.
* The connect screen probes `/health` and checks CORS — if it reports a CORS error, the origin isn't in `CORS_ORIGINS` (step 2), so fix `.env` and restart the service.

## 6. Serving the SPA from this server (optional)

The office-PC deployment can host the built frontend itself (single origin, no CORS):

```powershell
cd <PET frontend repo>
npm ci && npm run build
Copy-Item -Recurse dist\* <backend>\public\app\
```

Restart the service — `/` now serves the app, `/health` and `/api` keep working, and `/build-info.json` powers the frontend's update banner.

## 7. Backups

Everything stateful is under `data/`:

| Path | Contents |
|---|---|
| `data/pet.db` (+ `-wal`, `-shm`) | all records |
| `data/files/` | uploaded photos & documents |
| `data/jwt.secret` | session signing key (keep private & stable) |
| `data/server.log` | service log |

Copy `data\` to an external disk / NAS nightly. Restore = put the folder back. When copying a live database, stop the service first (or use `sqlite3 .backup`).

## 8. Environment reference

`.env` (see `.env.example` for the full list):

```ini
PORT=8080
HOST=0.0.0.0
NODE_ENV=production
CORS_ORIGINS=https://software.plusoneco.in,https://app.plusoneco.in
PET_JWT_SECRET=<openssl rand -base64 48>     # keep stable across restarts
PET_DB_PATH=./data/pet.db
PET_FILES_DIR=./data/files
PET_TRUST_PROXY=1                            # behind the tunnel
```

## 9. Upgrades

```powershell
.\scripts\windows\install-server-service.ps1 -Action Stop
git pull
npm install
.\scripts\windows\install-server-service.ps1 -Action Start
```

Migrations run automatically at boot (`schema.js` is idempotent).

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| `/health` refused locally | service not running → `-Action Status`, check `data\server.log` |
| Frontend: "Cannot reach …" | tunnel down, or URL typo in the connect screen |
| Frontend: CORS message naming `CORS_ORIGINS` | add the exact origin (scheme + host, no path) to `.env`, restart |
| `401 TOKEN_EXPIRED` loops | `PET_JWT_SECRET` changed between restarts — keep it set & stable |
| `429 RATE_LIMITED` at login | raise `PET_AUTH_RATE_LIMIT` (per minute per IP; `0` disables) |
| Disk growing | old `server.log` rotation; `data/files` grows with photos |
| Port already in use | change `PORT` or stop the conflicting program |
