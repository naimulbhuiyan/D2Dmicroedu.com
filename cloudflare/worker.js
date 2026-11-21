// microedu.com — Cloudflare Worker (single file)
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

/* ---------- database schema (embedded copy of cloudflare/schema-d1.sql) ----------
   Lets the Worker initialise its own D1 database (see /api/init-db and the
   lazy auto-init in fetch), so deployment does not depend on pasting SQL
   into the D1 Console. All statements are IF NOT EXISTS — idempotent. */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS registered_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('Teacher','Student','Other')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT, mobile TEXT,
  password_hash TEXT NOT NULL,
  picture TEXT,
  photo_data TEXT,
  photo_mode TEXT DEFAULT 'personal',
  group_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_role ON registered_people(role);
CREATE INDEX IF NOT EXISTS idx_people_email ON registered_people(email);
CREATE TABLE IF NOT EXISTS cv_details (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL UNIQUE REFERENCES registered_people(id) ON DELETE CASCADE,
  education TEXT NOT NULL, university TEXT NOT NULL,
  profession TEXT NOT NULL, position TEXT,
  experience TEXT NOT NULL, speciality TEXT NOT NULL,
  subjects TEXT NOT NULL, level TEXT NOT NULL,
  address TEXT NOT NULL, available_time TEXT,
  rate_bdt_per_hour REAL NOT NULL DEFAULT 500,
  pricing_type TEXT DEFAULT 'hourly',
  expertise_time TEXT,
  cv_file_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_cv_person ON cv_details(person_id);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_person ON sessions(person_id);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  months INTEGER NOT NULL CHECK (months IN (1,3,6,12)),
  amount_bdt REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Confirm')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_person ON subscriptions(person_id);
CREATE TABLE IF NOT EXISTS tuition_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gid TEXT NOT NULL UNIQUE,
  student_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  level TEXT, subject TEXT NOT NULL, chapter TEXT, topic TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 1,
  rate_bdt_per_hour REAL NOT NULL DEFAULT 500,
  amount_bdt REAL NOT NULL,
  available_time TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Confirm','Ongoing','Done','Cancelled')),
  class_link TEXT,
  class_start TEXT,
  extension_minutes INTEGER DEFAULT 0,
  extension_status TEXT DEFAULT 'None',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_req_student ON tuition_requests(student_id);
CREATE INDEX IF NOT EXISTS idx_req_teacher ON tuition_requests(teacher_id);
CREATE INDEX IF NOT EXISTS idx_req_gid ON tuition_requests(gid);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gid TEXT NOT NULL,
  person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  amount_bdt REAL NOT NULL,
  method TEXT DEFAULT 'bKash',
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Confirm')),
  escrow_status TEXT DEFAULT 'Awaiting payment',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_gid ON payments(gid);
CREATE INDEX IF NOT EXISTS idx_pay_person ON payments(person_id);
CREATE TABLE IF NOT EXISTS wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  gid TEXT, topic TEXT,
  amount_bdt REAL NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('credit','withdraw')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_wallet_person ON wallet_entries(person_id);
CREATE TABLE IF NOT EXISTS feedback_evaluation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  gid TEXT, comment TEXT,
  ranking INTEGER CHECK (ranking BETWEEN 1 AND 5),
  complain TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fb_person ON feedback_evaluation(person_id);
CREATE INDEX IF NOT EXISTS idx_fb_gid ON feedback_evaluation(gid);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER REFERENCES registered_people(id) ON DELETE SET NULL,
  gid TEXT, sender TEXT, message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_gid ON chat_messages(gid);
`;

/* Databases (env.DB objects) already known to hold the schema. A WeakSet so
   each distinct database is checked/initialised once per isolate, and a
   replaced database is never mistaken for an initialised one. */
const initializedDbs = new WeakSet();

async function runSchema(db) {
  if (typeof db.exec === 'function') {
    try { await db.exec(SCHEMA_SQL); initializedDbs.add(db); return; }
    catch { /* fall through to statement-by-statement execution */ }
  }
  for (const stmt of SCHEMA_SQL.split(';')) {
    const s = stmt.trim();
    if (s) await db.prepare(s).run();
  }
  initializedDbs.add(db);
}

/* Column additions for databases created before the photo / pricing
   update. Each ALTER is attempted and "duplicate column" errors ignored,
   so this is safe to run on every fresh isolate. */
const MIGRATIONS = [
  'ALTER TABLE registered_people ADD COLUMN photo_data TEXT',
  "ALTER TABLE registered_people ADD COLUMN photo_mode TEXT DEFAULT 'personal'",
  'ALTER TABLE registered_people ADD COLUMN group_name TEXT',
  "ALTER TABLE cv_details ADD COLUMN pricing_type TEXT DEFAULT 'hourly'",
  'ALTER TABLE cv_details ADD COLUMN expertise_time TEXT',
  'ALTER TABLE tuition_requests ADD COLUMN class_start TEXT',
  'ALTER TABLE tuition_requests ADD COLUMN extension_minutes INTEGER DEFAULT 0',
  "ALTER TABLE tuition_requests ADD COLUMN extension_status TEXT DEFAULT 'None'",
  "ALTER TABLE payments ADD COLUMN escrow_status TEXT DEFAULT 'Awaiting payment'",
];

async function runMigrations(db) {
  for (const sql of MIGRATIONS) {
    try { await db.prepare(sql).run(); } catch { /* column already exists */ }
  }
}

/* Lazy auto-init: if registered_people is missing, create all tables, then
   let the request continue normally. */
async function ensureDb(db) {
  if (!db || initializedDbs.has(db)) return;
  const row = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='registered_people'").first();
  if (!row) await runSchema(db);
  else initializedDbs.add(db);
  await runMigrations(db);
}

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
  photo_data: p.photo_data || null, photo_mode: p.photo_mode || 'personal',
  group_name: p.group_name || null,
});

/* Public view: anonymous members are masked — no name, contacts or photo. */
const pubPublic = p => {
  const v = pub(p);
  if (!v) return v;
  if (v.photo_mode === 'anonymous') {
    return { ...v, name: 'Anonymous', email: null, phone: null, mobile: null, picture: null, photo_data: null, group_name: null, anonymous: true };
  }
  return v;
};

// Returns undefined (not null) when absent, mirroring the Node server's JSON shape.
async function cvOf(db, id) {
  return (await db.prepare('SELECT * FROM cv_details WHERE person_id=?').bind(id).first()) || undefined;
}

/* The class link is never sent in list/detail responses — it is handed out
   only by POST /api/requests/join, inside the booked time window. */
const stripLink = r => r && ({ ...r, class_link: null });

/* Join window: opens 15 minutes before the booked start, closes at
   start + booked hours + 30 minutes grace (+ approved extension minutes).
   Bookings without a class_start (older ones) have no window check. */
function joinWindow(r) {
  if (!r.class_start) return { ok: true };
  const start = Date.parse(r.class_start);
  if (isNaN(start)) return { ok: true };
  const now = Date.now();
  const open = start - 15 * 60000;
  const mins = (Number(r.hours) || 1) * 60 + 30 + (r.extension_status === 'Approved' ? (Number(r.extension_minutes) || 0) : 0);
  const close = start + mins * 60000;
  if (now < open) return { ok: false, reason: 'too_early' };
  if (now > close) return { ok: false, reason: 'ended' };
  return { ok: true, closes_at: new Date(close).toISOString() };
}

async function walletBalance(db, id) {
  const r = await db.prepare('SELECT COALESCE(SUM(amount_bdt),0) AS t FROM wallet_entries WHERE person_id=?').bind(id).first();
  return r.t;
}

/* ---------- routes (same contract as server/server.js) ---------- */

const routes = {
  /* Self-initialisation: creates the (empty) tables if they do not exist.
     Idempotent and unauthenticated by design — it only runs
     CREATE ... IF NOT EXISTS statements, never reads or writes user data.
     Errors surface through the entry point as {error} with status 500. */
  'GET /api/init-db': async (request, db) => {
    await runSchema(db);
    await runMigrations(db);
    return send({ ok: true, initialized: true }, 200);
  },

  'POST /api/init-db': async (request, db) => {
    await runSchema(db);
    await runMigrations(db);
    return send({ ok: true, initialized: true }, 200);
  },

  'POST /api/register': async (request, db) => {
    const b = await body(request);
    const reqFields = ['role', 'name', 'email', 'password'];
    const cvReq = ['education', 'university', 'profession', 'experience', 'speciality', 'subjects', 'level', 'address'];
    if (!['Teacher', 'Student', 'Other'].includes(b.role)) return send({ error: 'Select role: Teacher, Student or Other' }, 400);
    for (const f of reqFields) if (!b[f]) return send({ error: 'Missing field: ' + f }, 400);
    for (const f of cvReq) if (!b.cv || !b.cv[f]) return send({ error: 'Detailed CV is mandatory. Missing CV field: ' + f }, 400);
    if (await db.prepare('SELECT 1 AS x FROM registered_people WHERE email=?').bind(b.email).first())
      return send({ error: 'Email already registered' }, 409);
    const photoMode = ['personal', 'group', 'anonymous'].includes(b.photo_mode) ? b.photo_mode : 'personal';
    const photoData = photoMode !== 'anonymous' && typeof b.photo_data === 'string' && b.photo_data.startsWith('data:image/') && b.photo_data.length <= 500000 ? b.photo_data : null;
    const info = await db.prepare('INSERT INTO registered_people(role,name,email,phone,mobile,password_hash,picture,photo_data,photo_mode,group_name) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(b.role, b.name, b.email, b.phone || null, b.mobile || null, await hashPw(b.password), b.picture || null, photoData, photoMode, photoMode === 'group' ? (b.group_name || null) : null).run();
    const pid = Number(info.meta.last_row_id);
    const pricing = ['hourly', 'bidding', 'free'].includes(b.cv.pricing_type) ? b.cv.pricing_type : 'hourly';
    const rate = pricing === 'free' ? 0 : (Number(b.cv.rate_bdt_per_hour) || 500);
    await db.prepare('INSERT INTO cv_details(person_id,education,university,profession,position,experience,speciality,subjects,level,address,available_time,rate_bdt_per_hour,pricing_type,expertise_time,cv_file_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(pid, b.cv.education, b.cv.university, b.cv.profession, b.cv.position || null, b.cv.experience, b.cv.speciality, b.cv.subjects, b.cv.level, b.cv.address, b.cv.available_time || null, rate, pricing, b.cv.expertise_time || null, b.cv.cv_file_name || null).run();
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
      people.push({ ...pubPublic(p), cv: await cvOf(db, p.id), subscription });
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
    for (const p of rows) teachers.push({ ...pubPublic(p), cv: await cvOf(db, p.id) });
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
    const pricing = cv && cv.pricing_type ? cv.pricing_type : 'hourly';
    let rate = cv ? Number(cv.rate_bdt_per_hour) || 0 : 500;
    if (pricing === 'hourly' && !rate) rate = 500;
    const hours = Number(b.hours) || 1;
    let amount = hours * rate;
    if (pricing === 'free') { rate = 0; amount = 0; }
    if (pricing === 'bidding') {
      const offer = Number(b.offer_amount) || 0;
      if (offer > 0) amount = offer;
    }
    const g = await newGid(db);
    const link = 'https://meet.google.com/' + g;
    const info = await db.prepare("INSERT INTO tuition_requests(gid,student_id,teacher_id,level,subject,chapter,topic,hours,rate_bdt_per_hour,amount_bdt,available_time,status,class_link,class_start) VALUES(?,?,?,?,?,?,?,?,?,?,?,'Pending',?,?)")
      .bind(g, me.id, t.id, b.level || null, b.subject, b.chapter || null, b.topic, hours, rate, amount, b.available_time || null, link, b.class_start || null).run();
    await db.prepare("INSERT INTO payments(gid,person_id,amount_bdt,status) VALUES(?,?,?,'Pending')").bind(g, me.id, amount).run();
    const requestRow = await db.prepare('SELECT * FROM tuition_requests WHERE id=?').bind(Number(info.meta.last_row_id)).first();
    return send({ request: stripLink(requestRow) }, 201);
  },

  'POST /api/payments/confirm': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const r = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(b.gid || '').first();
    if (!r) return send({ error: 'Request not found' }, 404);
    const next = b.status || 'Confirm';
    if (!['Confirm', 'Ongoing', 'Done'].includes(next)) return send({ error: 'status must be Confirm, Ongoing or Done' }, 400);
    await db.prepare('UPDATE tuition_requests SET status=? WHERE gid=?').bind(next, r.gid).run();
    if (next === 'Confirm') await db.prepare("UPDATE payments SET status='Confirm', escrow_status='Held' WHERE gid=?").bind(r.gid).run();
    if (next === 'Done') {
      const exists = await db.prepare("SELECT 1 AS x FROM wallet_entries WHERE gid=? AND kind='credit'").bind(r.gid).first();
      if (!exists) await db.prepare("INSERT INTO wallet_entries(person_id,gid,topic,amount_bdt,kind) VALUES(?,?,?,?,'credit')")
        .bind(r.teacher_id, r.gid, r.topic, r.amount_bdt).run();
      await db.prepare("UPDATE payments SET escrow_status='Released' WHERE gid=?").bind(r.gid).run();
    }
    const updated = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(r.gid).first();
    return send({ request: stripLink(updated) }, 200);
  },

  /* Secure join: the link itself is returned only to this booking's own
     student or teacher, only once the class is confirmed, and only inside
     the booked time window. It is never listed anywhere. */
  'POST /api/requests/join': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const r = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(b.gid || '').first();
    if (!r) return send({ error: 'Request not found' }, 404);
    if (r.student_id !== me.id && r.teacher_id !== me.id) return send({ error: 'Only this class\u2019s student and teacher can join it' }, 403);
    if (!['Confirm', 'Ongoing'].includes(r.status)) return send({ error: 'Class is not confirmed yet' }, 403);
    const w = joinWindow(r);
    if (!w.ok) return send({ error: w.reason === 'too_early' ? 'Too early \u2014 the class opens 15 minutes before its booked time' : 'This class time is over \u2014 ask microedu for an extension', reason: w.reason }, 403);
    return send({ class_link: r.class_link, closes_at: w.closes_at || null }, 200);
  },

  /* Extra time: a participant asks, microedu (site owner, member #1) approves. */
  'POST /api/requests/extend': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const r = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(b.gid || '').first();
    if (!r) return send({ error: 'Request not found' }, 404);
    if (r.student_id !== me.id && r.teacher_id !== me.id) return send({ error: 'Only this class\u2019s student and teacher can ask for more time' }, 403);
    const mins = [30, 60].includes(Number(b.minutes)) ? Number(b.minutes) : 30;
    await db.prepare("UPDATE tuition_requests SET extension_status='Requested', extension_minutes=? WHERE gid=?").bind(mins, r.gid).run();
    const updated = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(r.gid).first();
    return send({ request: stripLink(updated) }, 200);
  },

  'GET /api/extensions': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    if (me.id !== 1) return send({ error: 'microedu admin only' }, 403);
    const rows = (await db.prepare("SELECT * FROM tuition_requests WHERE extension_status='Requested' ORDER BY id DESC").all()).results;
    return send({ extensions: rows.map(stripLink) }, 200);
  },

  'POST /api/requests/extend/approve': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    if (me.id !== 1) return send({ error: 'microedu admin only' }, 403);
    const b = await body(request);
    const r = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(b.gid || '').first();
    if (!r) return send({ error: 'Request not found' }, 404);
    await db.prepare("UPDATE tuition_requests SET extension_status='Approved' WHERE gid=? AND extension_status='Requested'").bind(r.gid).run();
    const updated = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(r.gid).first();
    return send({ request: stripLink(updated) }, 200);
  },

  /* Escrow refund: money still held with microedu goes back to the student
     in full, and the booking is cancelled. Only before the class is Done. */
  'POST /api/payments/refund': async (request, db) => {
    const me = await auth(request, db); if (!me) return send({ error: 'Sign in required' }, 401);
    const b = await body(request);
    const r = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(b.gid || '').first();
    if (!r) return send({ error: 'Request not found' }, 404);
    if (r.student_id !== me.id && me.id !== 1) return send({ error: 'Only the student of this class (or microedu) can refund it' }, 403);
    if (r.status === 'Done') return send({ error: 'Class already done \u2014 the money has been released to the teacher' }, 400);
    const pay = await db.prepare('SELECT * FROM payments WHERE gid=? ORDER BY id DESC LIMIT 1').bind(r.gid).first();
    if (!pay || pay.escrow_status !== 'Held') return send({ error: 'Only money held with microedu can be refunded' }, 400);
    await db.prepare("UPDATE payments SET escrow_status='Refunded' WHERE gid=?").bind(r.gid).run();
    await db.prepare("UPDATE tuition_requests SET status='Cancelled' WHERE gid=?").bind(r.gid).run();
    const updated = await db.prepare('SELECT * FROM tuition_requests WHERE gid=?').bind(r.gid).first();
    return send({ request: stripLink(updated), refunded: true }, 200);
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
    const enrich = async rows => {
      const out = [];
      for (const r of rows) {
        const pay = await db.prepare('SELECT escrow_status FROM payments WHERE gid=? ORDER BY id DESC LIMIT 1').bind(r.gid).first();
        out.push({ ...stripLink(r), escrow_status: pay ? pay.escrow_status : 'Awaiting payment' });
      }
      return out;
    };
    const asStudent = await enrich((await db.prepare('SELECT * FROM tuition_requests WHERE student_id=? ORDER BY id DESC').bind(me.id).all()).results);
    const asTeacher = await enrich((await db.prepare('SELECT * FROM tuition_requests WHERE teacher_id=? ORDER BY id DESC').bind(me.id).all()).results);
    return send({ asStudent, asTeacher }, 200);
  },
};

/* ---------- entry point ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = request.method + ' ' + url.pathname;
    // Lazy auto-init: on any API call other than init-db itself, make sure
    // the tables exist before handling. If the check throws unexpectedly,
    // proceed with normal handling and let the handler surface any error.
    if (url.pathname.startsWith('/api/') && key !== 'GET /api/init-db' && key !== 'POST /api/init-db') {
      try { await ensureDb(env.DB); } catch { /* proceed with normal handling */ }
    }
    if (routes[key]) {
      try { return await routes[key](request, env.DB); }
      catch (e) { return send({ error: e.message }, 500); }
    }
    if (url.pathname.startsWith('/api/')) return send({ error: 'Not found' }, 404);
    // Static frontend (public/) via the Workers Assets binding.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('microedu.com — API is running. Static assets are served via the ASSETS binding (see wrangler.toml / docs/CLOUDFLARE.md).', {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    });
  },
};
