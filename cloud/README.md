# Cloud Control Plane

Source-of-truth registry + auth + assignment/calibration + **the exclusive reservation
lock** + signaling relay. TypeScript / Fastify / Postgres. **Not** in the media path.

## Run (dev)

```bash
docker compose up -d db nats          # from repo root
npm install                           # from repo root (installs all workspaces)
npm run -w @device-lab/contracts build
npm run -w cloud migrate              # apply schema
npm run -w cloud seed                 # dev users: operator/operator, admin/admin
npm run -w cloud dev                  # http://localhost:8080
```

`RUN_MIGRATIONS=1` makes the server migrate on boot. Config via env — see [`.env.example`](../.env.example).

## Endpoints (spec §11)

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/auth/login` | — | username/password → JWT |
| GET | `/tvs` · `/tvs/:id` · `/cameras` | user | pools + denormalized binding/holder |
| POST | `/tvs/:id/calibrate` | user | QR-handshake calibration (auto-binds on match) |
| POST · DELETE | `/tvs/:id/binding` | user | manual confirm · unassign |
| POST | `/tvs/:id/reserve` | user | **atomic** lock claim (200 / 409) |
| POST | `/tvs/:id/heartbeat` | user | renew the short lease |
| POST | `/tvs/:id/release` | user | explicit release |
| POST | `/tvs/:id/force-release` | **admin** | break a stuck lock |
| GET | `/tvs/:id/stream` | user | resolve binding → sfu track + signaling url |
| POST | `/tvs/:id/key` | user (holder) | relay a soft-remote key (403 if not holder) |
| POST · GET · DELETE | `/builds` · `/builds?platform=` · `/builds/:id` | user | upload (multipart) / list / delete a build |
| GET | `/builds/:id/download` | user JWT **or** agent secret | the lab agent fetches build bytes |
| POST | `/tvs/:id/install` | user (holder) | install a build on the TV → `{ job_id }`; progress via `install.update` WS |
| GET | `/install-jobs/:job_id` | user | poll install status |
| POST | `/tvs/:id/launch-app` · `/list-apps` · `/uninstall-app` · `/power` | user (holder) | app management + power (403 if not holder) |
| WS | `/agent` | shared secret | lab-agent control tunnel |
| WS | `/dashboard` | JWT | live presence push + WebRTC signaling + install progress |

## The lock (spec §7) — why it's the crown jewel

Two testers on one TV = two control connections fighting one authorized vendor session; the
second **breaks** the first. So the lock protects the device connection itself. It is:

- **Server-side + atomic** — claiming is ONE `INSERT … ON CONFLICT … WHERE` statement
  ([`services/reservation.ts`](src/services/reservation.ts)). The dashboard never enforces it.
- **Three release paths** — explicit release, TTL lease lapse (auto-steal), and a
  heartbeat-renewed short lease, with a separate non-renewed hard ceiling.
- **Reconnect-grace** — the lock is keyed by `session_id`; the same user reconnecting
  *resumes* their session instead of being locked out of their own TV.

## Tests

```bash
docker compose up -d db
npm run -w cloud test
```

Pure state-machine tests always run; the lock + registry suites need Postgres (they prove
atomicity against the real engine) and auto-skip with a clear message if it's unreachable.
`test/reservation.test.ts` races 25 users for one TV and asserts exactly one wins.
