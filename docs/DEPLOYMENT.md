# Deployment — microedu.com

The app is a zero-dependency Node server (`server/server.js`) with a static frontend.
For production handling many student connections, use a managed host + PostgreSQL
(apply `database/schema.sql`), and put the domain in front.

## Option 1 — Render (from GitHub)
1. Push this repo to GitHub.
2. Render → New → Web Service → connect the repo.
3. Build command: *(none needed)* — Start command: `node server/server.js`.
4. Add a PostgreSQL instance (Render Postgres), set env `DATABASE_URL`, and run `database/schema.sql` in its SQL console.
5. Settings → Custom Domains → add your domain, copy the DNS target to your registrar.

## Option 2 — Railway (from GitHub)
1. Railway → New Project → Deploy from GitHub repo.
2. Railway detects `package.json`; start command is `npm start` (PORT is provided automatically).
3. Add PostgreSQL plugin, set `DATABASE_URL`, apply `database/schema.sql`.
4. Settings → Networking → Custom Domain, add the CNAME at your registrar.

## Option 3 — VPS (Docker)
```bash
git clone <your-repo-url> d2d-microedu && cd d2d-microedu
docker build -t d2d-microedu .
docker run -d --name d2d -p 3000:3000 --restart unless-stopped d2d-microedu
```
Then reverse-proxy with Nginx/Caddy to your domain and enable HTTPS (Let's Encrypt via Caddy is automatic).
Install PostgreSQL on the VPS (or use a managed DB), apply `database/schema.sql`, and set `DATABASE_URL`.

## Option 3b — VPS (pm2, no Docker)
```bash
git clone <your-repo-url> d2d-microedu && cd d2d-microedu
npm i -g pm2
PORT=3000 pm2 start server/server.js --name d2d-microedu
pm2 save && pm2 startup
```

## Notes for scale
- Keep one central relational database; all tables link by `person_id`/`gid` (see schema).
- Each sign-in creates its own session token — students/teachers never share state.
- Back up the database regularly; the app itself is stateless apart from the DB.
- Real Google/LinkedIn/Facebook OAuth and live bKash payment need your own provider
  credentials before production launch; the built-in flows use email+password and
  in-app payment status (Pending → Confirm) until those are wired in.
