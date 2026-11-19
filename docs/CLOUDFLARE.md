# Deployment — Cloudflare Workers + D1 (free, no card)

The same app as the Node server (`server/server.js`), running on
Cloudflare's free tier: the API is a single Worker (`cloudflare/worker.js`),
the relational database is a D1 database (SQLite dialect,
`cloudflare/schema-d1.sql`), and the frontend in `public/` is served as
static assets by the same Worker. No payment card is needed for the
Cloudflare free plan, and D1 data persists (unlike a file on a free
container host).

Configuration lives in `wrangler.toml` at the repo root
(Worker name `d2d-microedu`, assets `./public`, D1 binding `DB`).

## Step 1 — Create a Cloudflare account
1. Go to https://dash.cloudflare.com/sign-up
2. Sign up with GitHub or Google (or email + password) and verify the email.
3. Choose the **Free** plan when asked. No card is requested on the free plan.

## Step 2 — Create the D1 database
1. Dashboard → **Workers & Pages** → **D1** (left sidebar: Storage & Databases → D1).
2. **Create database** → name it exactly `d2d-microedu-db` → Create.
3. Copy its **Database ID** — you need it in Step 5.

## Step 3 — Create the tables
1. Open the new database → **Console** tab.
2. Paste the whole contents of `cloudflare/schema-d1.sql` and run it.
   (Or locally: `npx wrangler d1 execute d2d-microedu-db --remote --file=cloudflare/schema-d1.sql`)
3. The console should list the tables: `registered_people`, `cv_details`,
   `sessions`, `subscriptions`, `tuition_requests`, `payments`,
   `wallet_entries`, `feedback_evaluation`, `chat_messages`.

## Step 4 — Import this repository as a Worker
1. Dashboard → **Workers & Pages** → **Create** → **Import a repository**
   (Workers → Import Git repository).
2. Connect GitHub and select **`naimulbhuiyan/D2Dmicroedu.com`** (branch `main`).
3. Project/Worker name: `d2d-microedu`. Build/deploy settings: this repo's
   `wrangler.toml` already declares the entry point (`cloudflare/worker.js`)
   and the assets directory (`./public`), so the defaults detected from it
   are fine; if a deploy command is asked for, use `npx wrangler deploy`.
4. **Deploy**. Cloudflare builds and publishes the Worker.

## Step 5 — Connect the database (D1 binding `DB`)
The Worker reads its database from the binding named **`DB`**
(`env.DB`). Check it is connected:
1. Worker `d2d-microedu` → **Settings** → **Bindings**.
2. If no D1 binding is listed, **Add binding** → **D1 database** →
   variable name `DB`, database `d2d-microedu-db` → Save, then redeploy
   (Deployments → Retry deploy, or push any commit).
3. When deploying with Wrangler from your own machine instead of the
   dashboard, put the Database ID from Step 2 into `wrangler.toml`
   (replace `REPLACE_AFTER_CREATING_D1_DATABASE`) before `wrangler deploy`.

## Step 6 — Verify
1. Open the live URL: `https://d2d-microedu.<your-subdomain>.workers.dev`
   — the homepage should show **D2D microedu.com** with Registration,
   Sign In, Subscription, Student and Teacher sections.
2. Open `<live URL>/api/people` — it should return JSON like
   `{"counts":{"Teacher":0,"Student":0,"Other":0},"total":0,"people":[]}`
   (counts grow as people register).
3. Register a Teacher and a Student from the homepage, then reload
   `/api/people` — both must appear with their CVs. That proves the
   Worker ↔ D1 connection works end to end.

## Custom domain (optional)
Worker → **Settings** → **Domains & Routes** → **Add** → **Custom Domain** →
enter your domain (e.g. `d2dmicroedu.com`). If the domain's DNS is on
Cloudflare, the records are added automatically; if it is registered
elsewhere, add the domain to Cloudflare first (free plan) and point the
registrar's nameservers to Cloudflare.

## Notes
- Passwords are hashed with Web Crypto PBKDF2 in the Worker, so password
  hashes are **not** interchangeable with the Node server's scrypt hashes —
  accounts registered on one stack must re-register (or reset) on the other.
- Free-tier limits are generous for launch (Workers requests + D1 reads/
  writes per day); every registered person has their own session token,
  so many students can use the site at the same time.
- Local development of this stack: `npx wrangler dev` (uses a local D1
  emulation; apply the schema with
  `npx wrangler d1 execute d2d-microedu-db --local --file=cloudflare/schema-d1.sql`).
