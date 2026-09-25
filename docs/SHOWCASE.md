# Client showcase deployment

This repository can serve the **PET Field Operations** frontend and API from one
origin. That is the simplest setup for a client demonstration:

```text
https://software.plusoneco.in
        │
        └── HTTPS reverse proxy / Cloudflare Tunnel
                    │
                    └── this Node server :8080
                         ├── bundled React SPA
                         ├── /api/*
                         └── SQLite + uploaded files
```

## Database requirement

No separate database server is required for a showcase. PET uses SQLite and
creates `data/pet.db` automatically. The same folder also contains uploaded
files and the generated JWT signing key.

The server must run on a machine with **persistent disk**. Do not run the
SQLite version on an ephemeral/serverless deployment such as a plain Vercel
function: the demo data will disappear when the instance is recycled.

For a larger multi-server production rollout, move the persistence layer to a
managed database and object storage. That is not needed for this showcase or a
single office server.

## Fresh setup

On the machine that will receive the domain traffic:

```bash
npm ci
cp .env.example .env
```

Edit `.env` before starting:

```ini
NODE_ENV=production
HOST=0.0.0.0
PORT=8080
CORS_ORIGINS=https://software.plusoneco.in
PET_TRUST_PROXY=1
PET_JWT_SECRET=paste-a-long-random-secret-here
PET_DB_PATH=./data/pet.db
PET_FILES_DIR=./data/files
```

Generate a signing secret instead of typing one:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Then prepare the bundled UI and realistic demo data:

```bash
npm run showcase
npm start
```

`npm run showcase` is safe to repeat. It builds the SPA only if it is missing
and seeds data only when the database has no users, students, or schools. It
never overwrites an existing database.

The server should now answer locally:

```bash
curl http://127.0.0.1:8080/health
```

Open `http://127.0.0.1:8080` to verify the complete app before attaching the
public domain. The server-hosted build is same-origin and does **not** show a
“Connect to your PET server” option on the login page. If an old version is
still visible after deployment, rebuild the bundled frontend and hard-refresh
the browser cache.

## Demo accounts

The showcase seed creates:

| Role | Email | Password |
|---|---|---|
| Main Admin | `admin@pet.local` | `PetAdmin123!` |
| Field employee | `ravi@pet.local` | `Employee123!` |
| Field employee | `sunita@pet.local` | `Employee123!` |
| Field employee | `imran@pet.local` | `Employee123!` |

The admin account demonstrates reports, pipeline, schools, tests, enrollment,
website submissions, tasks, team management, chat, and settings. The employee
account demonstrates the mobile field workflow, attendance, visits, tasks,
student registration, and chat.

These are intentionally demo credentials. Before using the system for real
records, replace them with a new admin and remove or disable the demo users.

## Attach `software.plusoneco.in`

The domain needs to terminate HTTPS and forward requests to the Node server.
Choose one:

### Cloudflare Tunnel

1. Create a tunnel and add the public hostname `software.plusoneco.in`.
2. Configure its service as `http://localhost:8080` on the machine running PET.
3. Start the tunnel as a service.
4. Visit `https://software.plusoneco.in/health` and then the root URL.

### Reverse proxy on a VPS or office gateway

Use Nginx, Caddy, or another HTTPS reverse proxy to forward the hostname to
`http://127.0.0.1:8080`. Keep the Node port private; only the proxy should be
public. The proxy must pass normal GET, POST, PATCH, `Authorization`, and
large upload requests through to PET.

The DNS record is managed outside this repository. This code cannot change the
DNS or Cloudflare account for `software.plusoneco.in`; the hostname must be
pointed at the proxy or tunnel by the domain administrator.

## Keeping it online

Run `npm start` under a service manager (systemd, PM2, Docker with a mounted
volume, or the included Windows Scheduled Task scripts). Back up the following
paths regularly:

```text
data/pet.db
 data/pet.db-wal       # if present while SQLite is running
 data/files/
 data/jwt.secret
```

Stop the service before copying a live database, or use SQLite's backup
command. Keep `PET_JWT_SECRET` stable across restarts or existing sessions will
be invalidated.

## Existing database

The normal seed command refuses to touch a database that already contains
students:

```bash
npm run seed-demo
```

To deliberately add the demo dataset on top of an existing database:

```bash
npm run seed-demo -- --force
```

Review the records first; `--force` layers demo records and is not a reset.
For a clean client demo, use a separate `PET_DB_PATH` such as
`./data/showcase/pet.db` rather than mixing demo and live records.
