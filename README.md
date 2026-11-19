# D2D microedu.com

Micro Edu. Support — an online, on-demand tuition platform built from the Web View wireframes.
Students request direct help on any part of any subject; teachers accept, get paid in advance (bKash), and teach via a class link.

## Features
- **One registration for all** — a single form with a role selector: Teacher / Student / Other. No "Sign up" anywhere; Sign In only (email + password).
- **Mandatory detailed CV** in registration (education, university, profession, position, experience, speciality, subjects, level, address, available time, rate BDT/hour default 500, CV file name). The CV powers the profile, teacher list cards, requests, wallet and subscription summary.
- **Subscription** — plan by role, 1/3/6/12 months, status Pending → Confirm.
- **Student flow** — Need Support → Choose Teacher → Teacher list (from database) → Request (hours × BDT 500, GID `XXXX-XXX-XXX`) → Payment Pending → Confirm → Ongoing → Done → Class Link → Evaluation (comment, ranking stars, complain).
- **Teacher flow** — Profile from CV, Wallet (entries by GID, withdraw), accept requests, feedback.
- **Admin** — Registered People list with Teacher/Student/Other counts.
- Design: teal = Teacher, orange = Student, dark-red buttons.

## Folder structure
```
server/server.js      Zero-dependency Node server (http + node:sqlite) + REST API
public/               Single-page frontend (index.html, styles.css, app.js)
database/schema.sql   Production relational schema (PostgreSQL; MySQL notes inside)
docs/DEPLOYMENT.md    Step-by-step deployment: Render, Railway, VPS
Dockerfile            node:24-alpine image
```

## Run locally
Requires Node ≥ 22 (uses built-in `node:sqlite`). No `npm install` needed.
```bash
node server/server.js
# or: npm start
```
Open http://localhost:3000 — port from env `PORT` (default 3000). Local data lives in `server/data/app.db` (gitignored).

## API
| Method | Path | What |
|---|---|---|
| POST | /api/register | Register (unique email, mandatory CV, scrypt-hashed password) → token |
| POST | /api/signin | Sign in → token |
| GET | /api/people | All registered people + role counts, CV + subscription joined |
| GET | /api/teachers | Registered teachers with CVs |
| POST | /api/subscriptions / /api/subscriptions/confirm | Create (Pending) / confirm subscription |
| POST | /api/requests | Create tuition request (generates GID, amount = hours × rate) |
| POST | /api/payments/confirm | Advance request Pending → Confirm → Ongoing → Done (Done credits teacher wallet) |
| GET / POST | /api/wallet / /api/wallet/withdraw | Wallet balance/entries, withdraw |
| POST | /api/feedback | Evaluation/feedback (comment, ranking, complain) |

Authenticated calls send `Authorization: Bearer <token>` (token stored in the `sessions` table).

## Production database
Create a PostgreSQL database and apply `database/schema.sql`. The schema is relational:
`registered_people` is the central table (unique email, role check); `cv_details`, `subscriptions`,
`tuition_requests` (student_id + teacher_id), `payments`, `wallet_entries`, `feedback_evaluation`,
`chat_messages` and `sessions` all link by `person_id` / `gid`, with indexes on email, role, person_id and gid.
The local server uses the same tables in SQLite for development; for production scale, point the API layer
at PostgreSQL (or use the VPS/Docker deployment with a managed Postgres on Render/Railway — see docs/DEPLOYMENT.md).

## Environment variables
| Name | Default | Purpose |
|---|---|---|
| PORT | 3000 | Server port |
| DATABASE_URL | — | Production PostgreSQL connection string (managed DB on Render/Railway) |

## Deployment
See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Render/Railway deploy directly from this GitHub repo; VPS uses the Dockerfile or pm2. Point your domain (e.g. d2dmicroedu.com) at the chosen host.

## Cloudflare (free, no card)
The same API also runs on Cloudflare Workers + D1 (relational SQLite database, free tier, no payment card): the Worker is `cloudflare/worker.js`, the D1 schema is `cloudflare/schema-d1.sql`, and configuration is in `wrangler.toml`. Step-by-step setup: [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).
