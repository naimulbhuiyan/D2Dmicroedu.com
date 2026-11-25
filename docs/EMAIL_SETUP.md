# Email alerts — setup step for the site owner (2.1)

The code is ready: the Worker sends an email at three moments, and always
keeps the in-site bell (🔔) as the record.

- New request → the teacher (`POST /api/requests`)
- Teacher accepts → the student (`POST /api/requests/respond`)
- Payment verified → the student AND the teacher (`POST /api/payments/verify`)

Each email has a sign-in link straight to the relevant dashboard page.

## Why no email goes out yet

Sending needs Cloudflare **Email Sending**, which is not set up for this
Worker. Until it is, the code safely does nothing (no error, no fake
"sent"). The bell notifications already work and are unaffected.

## The 2-minute step (do this on your own device — Cloudflare sign-in
## from Muse's browsers is blocked)

1. Open the Cloudflare dashboard and go to the Worker **d2dmicroedu-com**
   (Workers & Pages → d2dmicroedu-com).
2. Go to **Settings → Email Sending** (or Compute → Email Service →
   Email Sending → Onboard Domain) and **onboard a domain you own** —
   for example `microedu.eu.org` once its application is approved, or
   any domain already on your Cloudflare account. The "from" address in
   the code is `microedu@microedu.eu.org` — change the `EMAIL_FROM`
   constant at the top of `cloudflare/worker.js` if you onboard a
   different domain.
3. In the same Worker, go to **Settings → Bindings → Add → Email
   Sending**, variable name exactly `EMAIL`, and save. Then
   **Deploy** (or push any small change) so the binding takes effect.

No API key, no password, no secret is needed anywhere.

## One limit to know about

On the **free Workers plan**, Email Sending only delivers to email
addresses you have verified in the dashboard (Email Routing → Destination
addresses). Sending to *any* member's address needs the **Workers Paid
plan (US $5/month)**. That plan needs a payment card, which the owner
does not have — so until that changes, emails will only reach verified
destination addresses. Verify the addresses that matter (your own, and
the teachers who should get request alerts) under Email Routing →
Destination addresses.

## How to check it works

After the binding is added: create a test request on the live site (or
ask a teacher to accept one) and watch the inbox of the address it
should reach. If nothing arrives, check Workers → d2dmicroedu-com →
Logs for a `sendMail failed:` line — it names the reason.
