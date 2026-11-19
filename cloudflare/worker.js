// D2D microedu.com — Cloudflare Worker (single file)
// Same REST API contract as server/server.js (Node), backed by a D1 database
// (binding: env.DB). Static frontend is served from the ASSETS binding
// (the ./public directory, configured in wrangler.toml).
//
// Passwords: Web Crypto PBKDF2 (SHA-256, per-user salt) — node:crypto/scrypt
// is not available in Workers. Stored format: "<saltHex>:<hashHex>".
// Tokens and GIDs: crypto.getRandomValues.

const PLANS = {
  Teacher: { 'Teacher Basic': 300, 'Teacher Plus': 500 },
  Student: { 'Student Basic': 200, 'Student Plus': 300 },
  Other: { 'Other Basic': 200, 'Other Plus': 300 },
};

/* ---------- helpers ---------- */

function send(obj, code = 200) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function randomHex(bytes) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)).buffer);
}

async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return toHex(salt.buffer) + ':' + toHex(bits);
}

async function verifyPw(pw, stored) {
  try {
    const [saltHex, hashHex] = String(stored).split(':');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: fromHex(saltHex), iterations: 100000, hash: 'SHA-256' }, key, 256);
    const a = fromHex(hashHex), b = new Uint8Array(bits);
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  } catch { return false; }
}

/* ---------- db helpers (D1) ---------- */

async function newGid(db) {
  let g;
  do {
    const n = crypto.getRandomValues(new Uint32Array(3));
    g = `${1000 + (n[0] % 9000)}-${100 + (n[1] % 900)}-${100 + (n[2] % 900)}`;
  } while (await db.prepare('SELECT 1 AS x FROM tuition_requests WHERE gid=?').bind(g).first());
  return g;
}

async function auth(request, db) {
  const t = (request.headers.get('Authorization') || '').replace('Bearer ', '');
  if (!t) return null;
  const s = await db.prepare('SELECT person_id FROM sessions WHERE token=?').bind(t).first();
  return s ? db.prepare('SELECT * FROM registered_people WHERE id=?').bind(s.person_id).first() : null;
}

const pub = p => p && ({
  id: p.id, role: p.role, name: p.name, email: p.email,
  phone: p.phone, mobile: p.mobile, picture: p.picture, created_at: p.created_at,
});

// Returns undefined (not null) when absent, mirroring the Node server's JSON shape.
async function cvOf(db, id) {
  return (await db.prepare('SELECT * FROM cv_details WHERE person_id=?').bind(id).first()) || undefined;
}

async function walletBalance(db, id) {
  const r = await db.prepare('SELECT COALESCE(SUM(amount_bdt),0) AS t FROM wallet_entries WHERE person_id=?').bind(id).first();
  return r.t;
}

/* ---------- routes (same contract as server/server.js) ---------- */

const routes = {
  'POST /api/register': async (request, db) => {
    const b = await body(request);
    const reqFields = ['role', 'name', 'email', 'password'];
    const cvReq = ['education', 'university', 'profession', 'experience', 'speciality', 'subjects', 'level', 'address'];
    if (!['Teacher', 'Student', 'Other'].includes(b.role)) return send({ error: 'Select role: Teacher, Student or Other' }, 400);
    for (const f of reqFields) if (!b[f]) return send({ error: 'Missing field: ' + f }, 400);
    for (const f of cvReq) if (!b.cv || !b.cv[f]) return send({ error: 'Detailed CV is mandatory. Missing CV field: ' + f }, 400);
    if (await db.prepare('SELECT 1 AS x FROM registered_people WHERE email=?').bind(b.email).first())
      return send({ error: 'Email already registered' }, 409);
    const info = await db.prepare('INSERT INTO registered_people(role,name,email,phone,mobile,password_hash,picture) VALUES(?,?,?,?,?,?,?)')
      .bind(b.role, b.name, b.email, b.phone || null, b.mobile || null, await hashPw(b.password), b.picture || null).run();
    const pid = Number(info.meta.last_row_id);
    await db.prepare('INSERT INTO cv_details(person_id,education,university,profession,position,experience,speciality,subjects,level,address,available_time,rate_bdt_per_hour,cv_file_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(pid, b.cv.education, b.cv.university, b.cv.profession, b.cv.position || null, b.cv.experience, b.cv.speciality, b.cv.subjects, b.cv.level, b.cv.address, b.cv.available_time || null, Number(b.cv.rate_bdt_per_hour) || 500, b.cv.cv_file_name || null).run();
    const token = randomHex(24);
    await db.prepare('INSERT INTO sessions(token,person_id) VALUES(?,?)').bind(token, pid).run();
    const person = await db.prepare('SELECT * FROM registered_people WHERE id=?').bind(pid).first();
    return send({ person: pub(person), cv: await cvOf(db, pid), token }, 201);
  },

  'POST /api/signin': async (request, db) => {
    const b = await body(request);
    const p = await db.prepare('SELECT * FROM registered_people WHERE email=?').bind(b.email || '').first();
    if (!p || !(await verifyPw(b.password || '', p.password_hash)))
      return send({ found: false, error: 'Invalid email or password' }, 401);
    const token = randomHex(24);
    await db.prepare('INSERT INTO sessions(token,person_id) VALUES(?,?)').bind(token, p.id).run();
    return send({ found: true, person: pub(p), cv: await cvOf(db, p.id), token }, 200);
  },

  'GET /api/people': async (request, db) => {
    const rows = (await db.prepare('SELECT * FROM registered_people ORDER BY id').all()).results;
    const people = [];
    for (const p of rows) {
      const subscription = (await db.prepare('SELECT * FROM subscriptions WHERE person_id=? ORDER BY id DESC LIMIT 1').bind(p.id).first()) || null;
      people.push({ ...pub(p), cv: await cvOf(db, p.id), subscription });
    }
    const counts = {};
    for (const r of ['Teacher', 'Student', 'Other']) {
      const row = await db.prepare('SELECT COUNT(*) AS c FROM registered_people WHERE role=?').bind(r).first();
      counts[r] = row.c;
    }
    return send({ counts, total: people.length, people }, 200);
  },

  'GET /api/teachers': async (request, db) => {
    const rows = (await db.prepare("SELECT * FROM registered_people WHERE role='Teacher' ORDER BY id").all()).results;
    const teachers = [];
    for (const p of rows) teachers.push({ ...pub(p), cv: await cvOf(db, p.id) });
    return send({ teachers }, 200);
  },

  'POST /api/subscriptions': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const months = [1, 3, 6, 12].includes(Number(b.months)) ? Number(b.months) : 1;
    const plans = PLANS[me.role] || PLANS.Other;
    const plan = plans[b.plan] !== undefined ? b.plan : Object.keys(plans)[0];
    const amount = plans[plan] * months;
    const info = await db.prepare("INSERT INTO subscriptions(person_id,plan,months,amount_bdt,status) VALUES(?,?,?,?,'Pending')")
      .bind(me.id, plan, months, amount).run();
    const subscription = await db.prepare('SELECT * FROM subscriptions WHERE id=?').bind(Number(info.meta.last_row_id)).first();
    return send({ subscription }, 201);
  },

  'POST /api/subscriptions/confirm': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    await db.prepare("UPDATE subscriptions SET status='Confirm' WHERE id=? AND person_id=?").bind(b.id, me.id).run();
    const subscription = await db.prepare('SELECT * FROM subscriptions WHERE id=?').bind(b.id).first();
    return send({ subscription }, 200);
  },

  'POST /api/requests': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    if (!b.teacher_id || !b.subject || !b.topic) return send({ error: 'teacher_id, subject and topic are required' }, 400);
    const t = await db.prepare("SELECT * FROM registered_people WHERE id=? AND role='Teacher'").bind(b.teacher_id).first();
    if (!t) return send({ error: 'Teacher not found' }, 404);
    const cv = await cvOf(db, t.id);
    const rate = cv ? Number(cv.rate_bdt_per_hour) || 500 : 500;
    const hours = Number(b.hours) || 1;
    const amount = hours * rate;
    const g = await newGid(db);
    const link = 'https://meet.google.com/' + g;
    const info = await db.prepare("INSERT INTO tuition_requests(gid,student_id,teacher_id,level,subject,chapter,topic,hours,rate_bdt_per_hour,amount_bdt,available_time,status,class_link) VALUES(?,?,?,?,?,?,?,?,?,?,?,'Pending',?)")
      .bind(g, me.id, t.id, b.level || null, b.subject, b.chapter || null, b.topic, hours, rate, amount, b.available_time || null, link).run();
    await db.prepare("INSERT INTO payments(gid,person_id,amount_bdt,status) VALUES(?,?,?,'Pending')").bind(g, me.id, amount).run();
    const requestRow = await db.prepare('SELECT * FROM tuition_requests WHERE id=?').bind(Number(info.meta.last_row_id)).first();
    return send({ request: requestRow }, 201);
  },

  'POST /api/payments/confirm': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const r = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(b.gid || '').first();
    if (!r) return send({ error: 'Request not found' }, 404);
    const next = b.status || 'Confirm';
    if (!['Confirm', 'Ongoing', 'Done'].includes(next)) return send({ error: 'status must be Confirm, Ongoing or Done' }, 400);
    await db.prepare('UPDATE tuition_requests SET status=? WHERE gid=?').bind(next, r.gid).run();
    if (next === 'Confirm') await db.prepare("UPDATE payments SET status='Confirm' WHERE gid=?").bind(r.gid).run();
    if (next === 'Done') {
      const exists = await db.prepare("SELECT 1 AS x FROM wallet_entries WHERE gid=? AND kind='credit'").bind(r.gid).first();
      if (!exists) await db.prepare("INSERT INTO wallet_entries(person_id,gid,topic,amount_bdt,kind) VALUES(?,?,?,?,'credit')")
        .bind(r.teacher_id, r.gid, r.topic, r.amount_bdt).run();
    }
    const updated = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(r.gid).first();
    return send({ request: updated }, 200);
  },

  'GET /api/wallet': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const entries = (await db.prepare('SELECT * FROM wallet_entries WHERE person_id=? ORDER BY id DESC').bind(me.id).all()).results;
    return send({ balance: await walletBalance(db, me.id), entries }, 200);
  },

  'POST /api/wallet/withdraw': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const amt = Number(b.amount) || 0;
    if (amt <= 0) return send({ error: 'Amount must be positive' }, 400);
    if (amt > await walletBalance(db, me.id)) return send({ error: 'Insufficient wallet balance' }, 400);
    await db.prepare("INSERT INTO wallet_entries(person_id,gid,topic,amount_bdt,kind) VALUES(?,NULL,'Withdraw',?,'withdraw')").bind(me.id, -amt).run();
    return send({ balance: await walletBalance(db, me.id) }, 200);
  },

  'POST /api/feedback': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const info = await db.prepare('INSERT INTO feedback_evaluation(person_id,gid,comment,ranking,complain) VALUES(?,?,?,?,?)')
      .bind(me.id, b.gid || null, b.comment || null, b.ranking ? Number(b.ranking) : null, b.complain || null).run();
    const feedback = await db.prepare('SELECT * FROM feedback_evaluation WHERE id=?').bind(Number(info.meta.last_row_id)).first();
    return send({ feedback }, 201);
  },

  'GET /api/my-requests': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const asStudent = (await db.prepare('SELECT * FROM tuition_requests WHERE student_id=? ORDER BY id DESC').bind(me.id).all()).results;
    const asTeacher = (await db.prepare('SELECT * FROM tuition_requests WHERE teacher_id=? ORDER BY id DESC').bind(me.id).all()).results;
    return send({ asStudent, asTeacher }, 200);
  },
};

/* ---------- entry point ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = request.method + ' ' + url.pathname;
    if (routes[key]) {
      try { return await routes[key](request, env.DB); }
      catch (e) { return send({ error: e.message }, 500); }
    }
    if (url.pathname.startsWith('/api/')) return send({ error: 'Not found' }, 404);
    // Static frontend (public/) via the Workers Assets binding.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('D2D microedu.com — API is running. Static assets are served via the ASSETS binding (see wrangler.toml / docs/CLOUDFLARE.md).', {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  },
};
