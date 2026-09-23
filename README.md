# PET-BACKEND

Backend for **PET — Purvanchal Education Trust Field Operations**: the server half of [sakshamfit/PET](https://github.com/sakshamfit/PET).

Express + SQLite, zero native-build requirements, and a contract written to match the frontend's `src/types/pet.ts` and `src/services/petApi.ts` exactly.

```
Frontend (sakshamfit/PET)             This repo
  React + Vite + Tailwind      →      Express (Node 18+) + SQLite
  Vercel (static build)               Office PC + Cloudflare Tunnel
       │                                    │
       └────────── /api + /health ──────────┘
            https://app.plusoneco.in
```

---

## Quick start

```bash
git clone <this-repo> PET-BACKEND
cd PET-BACKEND
npm install                 # never fails: SQLite driver auto-falls-back

# 1. create the Main Admin (one-time password is printed once)
npm run bootstrap-admin -- --email admin@pet.org

# 2. run
npm start                   # → http://localhost:8080
curl http://localhost:8080/health
# {"status":"ok","service":"pet-backend",...}

# optional: walk every screen with realistic demo data
npm run seed-demo           # admin@pet.local / PetAdmin123!

# tests (34 integration tests, ~3s)
npm test
```

Point the frontend at it:

* **Local dev:** `PET_API_DEV_TARGET=http://localhost:8080 npm run dev` in the PET repo (Vite proxies `/api`), or
* **Hosted frontend:** set `PET_API_BASE=http://localhost:8080` (or your tunnel URL) in Vercel / the app's "Connect to server" screen. The health probe hits `GET /health` on the origin root — this server serves it there by design.

---

## Why it installs with zero pain

The old full repo's `npm ci` died on `better-sqlite3` whenever VS Build Tools were missing — that's *why* the frontend repo is frontend-only. This server treats the native driver as an **option, not a requirement**:

| Priority | Driver | When it is used |
|---|---|---|
| 1 | `better-sqlite3` (optionalDependency) | prebuilt binary available → fastest path |
| 2 | `node:sqlite` (built into Node ≥ 22.5) | dev machines, CI, this sandbox |
| 3 | `node-sqlite3-wasm` (pure WASM) | any Node ≥ 18, no compiler, no prebuilds |

One adapter (`src/db.js`) normalizes all three. Runtime dependencies are **express + node-sqlite3-wasm** and nothing else — JWT, scrypt passwords, CORS, validation and rate limiting are implemented on Node built-ins so the office PC install stays bulletproof.

---

## What's implemented (the full frontend contract)

| Area | Endpoints |
|---|---|
| Health & build | `GET /health`, `GET /build-info.json` |
| Auth | login · refresh (rotating, reuse-detecting) · logout · change-password |
| Me | profile · employee dashboard · today's attendance · notifications · directory |
| Team (admin) | list · create (one-time password) · update · enable/disable · reset-access |
| Students | search · register (duplicate guard) · duplicates-check · profile · PATCH · status lifecycle |
| Schools | list · create · update · archive · profile |
| Field visits | start (one active/employee) · detail · patch · end with report |
| Tasks | list (role-scoped) · create · status flow · reassign · detail with event trail |
| Chat | conversations · unread counts · direct/group · messages · send with entity links |
| Attendance | check-in/out (idempotent) · list · manual mark · monthly summary |
| Tests | create with subjects · assign · marks · finalize · absent · decisions |
| Enrollment | start · advance stages · withdraw |
| Website forms | list · assign · status · convert-to-student |
| Uploads | base64 upload · field/student media registration · authenticated file serving |
| Offline sync | `POST /api/sync` with per-key exactly-once semantics |
| Reports | admin dashboard · global search · activity log · organization settings |

See **[docs/API.md](docs/API.md)** for the complete route reference.

### Security model (mirrors the frontend's expectations)

* Access JWTs (HS256, 15 min) live in browser memory; refresh tokens are opaque, rotated on every use, stored server-side **only as SHA-256 hashes**, and replaying a rotated token revokes its whole family.
* Disabling an account or resetting access revokes every refresh token immediately; the user row is re-read on every request, so role/status changes take effect instantly.
* One-time passwords are generated server-side, returned exactly once, and force a password change at first sign-in.
* Duplicate student registration returns `409 POSSIBLE_DUPLICATES` with the candidate list — records are **never** auto-merged.
* Files are served only through authenticated `/api/files/*` with path-traversal rejection.
* Login attempts are rate-limited per IP; all mutations land in the `audit_log` (Admin → Recent activity).

---

## Configuration

Copy `.env.example` → `.env`. Highlights:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | matches the documented office-PC setup |
| `CORS_ORIGINS` | *(empty = allow all)* | comma-separated; set to your Vercel + tunnel URLs in production |
| `PET_JWT_SECRET` | auto-generated to `data/jwt.secret` | set explicitly in production |
| `PET_DB_PATH` | `./data/pet.db` | SQLite file; back this up |
| `PET_FILES_DIR` | `./data/files` | uploaded photos/documents |
| `PET_ADMIN_EMAIL` / `PET_ADMIN_PASSWORD` | — | first-boot bootstrap when no admin exists |

Full list in [`.env.example`](.env.example).

---

## Project structure

```
src/
├── server.js            # boot: config → db → migrate → listen
├── app.js               # /health, /api mount, SPA statics, error boundary
├── config.js            # env + tiny .env loader (no dotenv dep)
├── db.js                # SQLite driver adapter (3 drivers) + transactions
├── schema.js            # baseline DDL (28 tables) + migration runner
├── lib/                 # errors, validation, jwt, passwords, ids, audit, notify
├── middleware/          # auth, cors, rate limit, error handler
├── services/            # domain logic (shared by routes + offline sync)
└── routes/              # HTTP layer, one file per resource
scripts/
├── bootstrap-admin.js   # create/reset the Main Admin
├── seed-demo.js         # realistic walkthrough data
└── windows/             # first-run, scheduled-task service, cloudflare tunnel
tests/                   # 34 integration tests (node:test, no extra deps)
docs/                    # API reference + deployment guide
```

---

## Deployment (office PC + Cloudflare Tunnel)

See **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)** for the full walkthrough:

```powershell
.\scripts\windows\pet-first-run.ps1 -AdminEmail admin@plusoneco.in -BootstrapAdmin `
    -PublicUrl https://app.plusoneco.in
.\scripts\windows\install-server-service.ps1        # run at boot
.\scripts\windows\cloudflare-tunnel.ps1 -Token "<TOKEN>"
```

---

## Development

```bash
npm run dev              # node --watch
npm test                 # node --test (34 tests)
npm run bootstrap-admin  # manage the Main Admin
npm run seed-demo        # reset-free demo data (refuses if data exists; --force to layer)
```

**Adding an endpoint:** service logic goes in `src/services/` (so `/sync` replay and other callers stay consistent), the route file stays thin, tests go in `tests/`. If the shape changes, update the frontend's `types/pet.ts` in the same PR — the two repos are a contract pair.

License: private — Purvanchal Education Trust.
