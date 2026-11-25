'use strict';
/* microedu.com — zero-dependency server (Node built-ins only)
   Local/dev DB: node:sqlite in server/data/app.db (mirrors database/schema.sql for PostgreSQL prod) */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS registered_people(id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL CHECK(role IN ('Teacher','Student','Other')), name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT, mobile TEXT, password_hash TEXT NOT NULL, picture TEXT, photo_data TEXT, photo_mode TEXT DEFAULT 'personal', group_name TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_people_role ON registered_people(role);
CREATE TABLE IF NOT EXISTS cv_details(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL UNIQUE REFERENCES registered_people(id) ON DELETE CASCADE, education TEXT NOT NULL, university TEXT NOT NULL, profession TEXT NOT NULL, position TEXT, experience TEXT NOT NULL, speciality TEXT NOT NULL, subjects TEXT NOT NULL, level TEXT NOT NULL, address TEXT NOT NULL, available_time TEXT, rate_bdt_per_hour REAL NOT NULL DEFAULT 500, pricing_type TEXT DEFAULT 'hourly', expertise_time TEXT, teacher_ready INTEGER DEFAULT 0, accepts_time_exchange INTEGER DEFAULT 0, cv_file_name TEXT);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS subscriptions(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE, plan TEXT NOT NULL, months INTEGER NOT NULL, amount_bdt REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'Pending', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS tuition_requests(id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT NOT NULL UNIQUE, student_id INTEGER NOT NULL REFERENCES registered_people(id), teacher_id INTEGER NOT NULL REFERENCES registered_people(id), level TEXT, subject TEXT NOT NULL, chapter TEXT, topic TEXT NOT NULL, hours REAL NOT NULL DEFAULT 1, rate_bdt_per_hour REAL NOT NULL DEFAULT 500, amount_bdt REAL NOT NULL, available_time TEXT, pay_with TEXT DEFAULT 'money', teacher_response TEXT DEFAULT 'Waiting', on_hold_until TEXT, status TEXT NOT NULL DEFAULT 'Pending', class_link TEXT, class_start TEXT, extension_minutes INTEGER DEFAULT 0, extension_status TEXT DEFAULT 'None', created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS time_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, gid TEXT, topic TEXT, minutes INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS password_resets(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, email TEXT NOT NULL, done INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, text TEXT NOT NULL, gid TEXT, is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS subscribers(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, gid TEXT NOT NULL, person_id INTEGER NOT NULL, amount_bdt REAL NOT NULL, method TEXT DEFAULT 'bKash', status TEXT NOT NULL DEFAULT 'Pending', escrow_status TEXT DEFAULT 'Awaiting payment', trxid TEXT, sender TEXT, verified INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS wallet_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, gid TEXT, topic TEXT, amount_bdt REAL NOT NULL, kind TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS feedback_evaluation(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, gid TEXT, comment TEXT, ranking INTEGER, complain TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS chat_messages(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER, gid TEXT, sender TEXT, message TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`);

/* Column additions for databases created before the photo / pricing update. */
for (const sql of [
  'ALTER TABLE registered_people ADD COLUMN photo_data TEXT',
  "ALTER TABLE registered_people ADD COLUMN photo_mode TEXT DEFAULT 'personal'",
  'ALTER TABLE registered_people ADD COLUMN group_name TEXT',
  "ALTER TABLE cv_details ADD COLUMN pricing_type TEXT DEFAULT 'hourly'",
  'ALTER TABLE cv_details ADD COLUMN expertise_time TEXT',
  'ALTER TABLE tuition_requests ADD COLUMN class_start TEXT',
  'ALTER TABLE tuition_requests ADD COLUMN extension_minutes INTEGER DEFAULT 0',
  "ALTER TABLE tuition_requests ADD COLUMN extension_status TEXT DEFAULT 'None'",
  "ALTER TABLE payments ADD COLUMN escrow_status TEXT DEFAULT 'Awaiting payment'",
  'ALTER TABLE payments ADD COLUMN trxid TEXT',
  'ALTER TABLE payments ADD COLUMN sender TEXT',
  'ALTER TABLE payments ADD COLUMN verified INTEGER DEFAULT 0',
  'ALTER TABLE payments ADD COLUMN rejected INTEGER DEFAULT 0',
  'ALTER TABLE cv_details ADD COLUMN teacher_ready INTEGER DEFAULT 0',
  'ALTER TABLE cv_details ADD COLUMN accepts_time_exchange INTEGER DEFAULT 0',
  "ALTER TABLE tuition_requests ADD COLUMN pay_with TEXT DEFAULT 'money'",
  'CREATE TABLE IF NOT EXISTS time_entries(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, gid TEXT, topic TEXT, minutes INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT DEFAULT (datetime(\'now\')))',
  "UPDATE cv_details SET teacher_ready=1 WHERE teacher_ready=0 AND subjects IS NOT NULL AND subjects<>''",
  "CREATE TABLE IF NOT EXISTS password_resets(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, email TEXT NOT NULL, done INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT, person_id INTEGER NOT NULL, text TEXT NOT NULL, gid TEXT, is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')))",
  "CREATE TABLE IF NOT EXISTS subscribers(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, created_at TEXT DEFAULT (datetime('now')))",
  "ALTER TABLE tuition_requests ADD COLUMN teacher_response TEXT DEFAULT 'Waiting'",
  'ALTER TABLE tuition_requests ADD COLUMN on_hold_until TEXT',
  "UPDATE tuition_requests SET teacher_response='Accepted' WHERE status IN ('Confirm','Ongoing','Done') AND (teacher_response IS NULL OR teacher_response='Waiting')",
]) { try { db.exec(sql); } catch { /* column already exists */ } }

const hashPw = pw => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const verifyPw = (pw, stored) => { try { const [s, h] = stored.split(':'); return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, s, 64)); } catch { return false; } };
const gid = () => [1000,100,100].map((m,i)=> Math.floor(Math.random()*9000*(i?0.111:1)) + (i?100:1000)).join('-').replace(/(\d{4})-(\d{3})-(\d{3})/,'$1-$2-$3');
const newGid = () => { let g; do { g = `${1000+Math.floor(Math.random()*9000)}-${100+Math.floor(Math.random()*900)}-${100+Math.floor(Math.random()*900)}`; } while (db.prepare('SELECT 1 FROM tuition_requests WHERE gid=?').get(g)); return g; };
/* One plan list for every member — there are no roles anymore. */
const PLANS = { 'Basic': 0, 'Plus': 300, 'Teacher Plus': 500 };

function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b); }
function body(req) { return new Promise(r => { let d=''; req.on('data',c=>d+=c); req.on('end',()=>{ try{r(JSON.parse(d||'{}'))}catch{r({})} }); }); }
/* Auto sign-out: a login lasts at most SESSION_HOURS (mirrors the Worker). */
const SESSION_HOURS = 12;
function auth(req) { const t = (req.headers.authorization||'').replace('Bearer ',''); if(!t) return null; const s = db.prepare('SELECT person_id, created_at FROM sessions WHERE token=?').get(t); if(!s) return null; const ageMs = Date.now() - Date.parse(String(s.created_at).replace(' ','T') + 'Z'); if(!(ageMs >= 0) || ageMs > SESSION_HOURS * 3600 * 1000) { db.prepare('DELETE FROM sessions WHERE token=?').run(t); return null; } return db.prepare('SELECT * FROM registered_people WHERE id=?').get(s.person_id); }
/* Stored notifications: they stay in the member's bell panel until the
   member deletes them — nothing here is recomputed or resurrected. */
function notify(personId, text, gid) { try { db.prepare('INSERT INTO notifications(person_id,text,gid) VALUES(?,?,?)').run(personId, text, gid || null); } catch { /* a notification must never block the main action */ } }
/* ---------- email alerts (2.1) ----------
   The local dev server never sends real mail — it logs the alert
   instead. The live Worker sends through the Cloudflare Email Sending
   binding (see cloudflare/worker.js + docs/EMAIL_SETUP.md). */
const SITE_URL = 'https://d2dmicroedu-com.du-naimul2024.workers.dev';
function mailTo(personId, subject, text) {
  const p = db.prepare('SELECT email FROM registered_people WHERE id=?').get(personId);
  if (!p || !p.email) return false;
  console.log('[email-alert] to ' + p.email + ' | ' + subject + ' | ' + text);
  return true;
}
/* Completed classes + average stars for a teacher (1.5): from the
   requests they finished and the feedback left on those classes. */
const teacherStats = teacherId => {
  const c = db.prepare("SELECT COUNT(*) n FROM tuition_requests WHERE teacher_id=? AND status='Done'").get(teacherId);
  const r = db.prepare("SELECT AVG(f.ranking) avg, COUNT(f.ranking) n FROM feedback_evaluation f JOIN tuition_requests t ON t.gid=f.gid WHERE t.teacher_id=? AND f.ranking IS NOT NULL").get(teacherId);
  return { completed: c ? c.n : 0, rating_avg: r && r.avg !== null ? Math.round(Number(r.avg) * 10) / 10 : null, rating_count: r ? r.n : 0 };
};
const pub = p => p && ({ id:p.id, role:p.role, name:p.name, email:p.email, phone:p.phone, mobile:p.mobile, picture:p.picture, created_at:p.created_at, photo_data:p.photo_data||null, photo_mode:p.photo_mode||'personal', group_name:p.group_name||null });
/* Public view: anonymous members are masked — no name, contacts or photo. */
const pubPublic = p => { const v = pub(p); if (!v) return v; if (v.photo_mode==='anonymous') return {...v, name:'Anonymous', email:null, phone:null, mobile:null, picture:null, photo_data:null, group_name:null, anonymous:true}; return v; };
const cvOf = id => db.prepare('SELECT * FROM cv_details WHERE person_id=?').get(id);
/* The class link is never sent in list/detail responses — it is handed out
   only by POST /api/requests/join, inside the booked time window. */
const stripLink = r => r && ({...r, class_link:null});

/* One teacher per help need: committing to one teacher puts the student's
   other Pending requests for the same subject+topic on hold for one day —
   inactive, not cancelled. A refund (issue raised) clears the hold at once. */
function holdSiblings(r) {
  const until = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  db.prepare("UPDATE tuition_requests SET on_hold_until=? WHERE student_id=? AND subject=? AND topic=? AND gid<>? AND status='Pending'")
    .run(until, r.student_id, r.subject, r.topic, r.gid);
}
function clearSiblingHolds(r) {
  db.prepare("UPDATE tuition_requests SET on_hold_until=NULL WHERE student_id=? AND subject=? AND topic=? AND gid<>? AND status='Pending'")
    .run(r.student_id, r.subject, r.topic, r.gid);
}
const onHold = r => !!(r.on_hold_until && new Date(r.on_hold_until).getTime() > Date.now());
/* Once the chosen class is Done, the other teachers for that help are
   removed for good. */
function deleteSiblingsFinal(r) {
  db.prepare("DELETE FROM tuition_requests WHERE student_id=? AND subject=? AND topic=? AND gid<>? AND status='Pending'")
    .run(r.student_id, r.subject, r.topic, r.gid);
}
/* Join window: opens 15 min before the booked start, closes at start +
   booked hours + 30 min grace (+ approved extension). No class_start = no check. */
function joinWindow(r) {
  if (!r.class_start) return {ok:true};
  const start = Date.parse(r.class_start);
  if (isNaN(start)) return {ok:true};
  const now = Date.now();
  const open = start - 15*60000;
  const mins = (Number(r.hours)||1)*60 + 30 + (r.extension_status==='Approved' ? (Number(r.extension_minutes)||0) : 0);
  const close = start + mins*60000;
  if (now < open) return {ok:false, reason:'too_early'};
  if (now > close) return {ok:false, reason:'ended'};
  return {ok:true, closes_at:new Date(close).toISOString()};
}
const walletBalance = id => { const r = db.prepare('SELECT COALESCE(SUM(amount_bdt),0) t FROM wallet_entries WHERE person_id=?').get(id); return r.t; };
/* Time bank: minutes earned by teaching free / time-paid classes, minus
   minutes spent learning from teachers who accept time exchange. */
const timeBalance = id => { const r = db.prepare('SELECT COALESCE(SUM(minutes),0) t FROM time_entries WHERE person_id=?').get(id); return r.t; };

const routes = {
  /* Two-step registration (no roles): basic sign-up can learn at once;
     the teacher profile is completed later via /api/teacher-profile.
     A full CV sent with registration is still accepted (older forms). */
  'POST /api/register': async (req,res) => {
    const b = await body(req);
    for (const f of ['name','email','password']) if (!b[f]) return send(res,400,{error:'Missing field: '+f});
    if (db.prepare('SELECT 1 FROM registered_people WHERE email=?').get(b.email)) return send(res,409,{error:'Email already registered'});
    const photoMode = ['personal','group','anonymous'].includes(b.photo_mode) ? b.photo_mode : 'personal';
    const photoData = photoMode!=='anonymous' && typeof b.photo_data==='string' && b.photo_data.startsWith('data:image/') && b.photo_data.length<=500000 ? b.photo_data : null;
    const role = ['Teacher','Student','Other'].includes(b.role) ? b.role : 'Other';
    const info = db.prepare('INSERT INTO registered_people(role,name,email,phone,mobile,password_hash,picture,photo_data,photo_mode,group_name) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(role,b.name,b.email,b.phone||null,b.mobile||null,hashPw(b.password),b.picture||null,photoData,photoMode,photoMode==='group'?(b.group_name||null):null);
    const pid = Number(info.lastInsertRowid);
    const cv = b.cv || {};
    const cvReq = ['education','university','profession','experience','speciality','subjects','level','address'];
    const fullCv = cvReq.every(f => cv[f]);
    const pricing = ['hourly','bidding','free'].includes(cv.pricing_type) ? cv.pricing_type : 'hourly';
    const rate = pricing==='free' ? 0 : (Number(cv.rate_bdt_per_hour)||500);
    db.prepare('INSERT INTO cv_details(person_id,education,university,profession,position,experience,speciality,subjects,level,address,available_time,rate_bdt_per_hour,pricing_type,expertise_time,teacher_ready,accepts_time_exchange,cv_file_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(pid,cv.education||'',cv.university||'',cv.profession||'',cv.position||null,cv.experience||'',cv.speciality||'',cv.subjects||'',cv.level||'',cv.address||'',cv.available_time||null,rate,pricing,cv.expertise_time||null,fullCv?1:0,cv.accepts_time_exchange?1:0,cv.cv_file_name||null);
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions(token,person_id) VALUES(?,?)').run(token,pid);
    send(res,201,{person:pub(db.prepare('SELECT * FROM registered_people WHERE id=?').get(pid)), cv:cvOf(pid), token});
  },
  /* Step 2: complete (or update) the teacher profile — every field is
     required here; saving it is what lists the member as a teacher. */
  'POST /api/teacher-profile': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const cv = b.cv || b;
    const cvReq = ['education','university','profession','experience','speciality','subjects','level','address'];
    for (const f of cvReq) if (!cv[f]) return send(res,400,{error:'Teacher profile is incomplete. Missing field: '+f});
    const pricing = ['hourly','bidding','free'].includes(cv.pricing_type) ? cv.pricing_type : 'hourly';
    const rate = pricing==='free' ? 0 : (Number(cv.rate_bdt_per_hour)||500);
    const acceptsTime = cv.accepts_time_exchange ? 1 : 0;
    const existing = cvOf(me.id);
    if (existing) {
      db.prepare('UPDATE cv_details SET education=?,university=?,profession=?,position=?,experience=?,speciality=?,subjects=?,level=?,address=?,available_time=?,rate_bdt_per_hour=?,pricing_type=?,expertise_time=?,teacher_ready=1,accepts_time_exchange=?,cv_file_name=? WHERE person_id=?')
        .run(cv.education,cv.university,cv.profession,cv.position||null,cv.experience,cv.speciality,cv.subjects,cv.level,cv.address,cv.available_time||null,rate,pricing,cv.expertise_time||null,acceptsTime,cv.cv_file_name||existing.cv_file_name||null,me.id);
    } else {
      db.prepare('INSERT INTO cv_details(person_id,education,university,profession,position,experience,speciality,subjects,level,address,available_time,rate_bdt_per_hour,pricing_type,expertise_time,teacher_ready,accepts_time_exchange,cv_file_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(me.id,cv.education,cv.university,cv.profession,cv.position||null,cv.experience,cv.speciality,cv.subjects,cv.level,cv.address,cv.available_time||null,rate,pricing,cv.expertise_time||null,1,acceptsTime,cv.cv_file_name||null);
    }
    send(res,200,{person:pub(me), cv:cvOf(me.id)});
  },
  'POST /api/signin': async (req,res) => {
    const b = await body(req);
    /* Sign in with the email address OR the numeric member ID. */
    const ident = String(b.email||'').trim();
    const p = /^\d+$/.test(ident)
      ? db.prepare('SELECT * FROM registered_people WHERE id=?').get(Number(ident))
      : db.prepare('SELECT * FROM registered_people WHERE LOWER(email)=LOWER(?)').get(ident);
    if (!p || !verifyPw(b.password||'', p.password_hash)) return send(res,401,{found:false,error:'Invalid email or password'});
    const token = crypto.randomBytes(24).toString('hex');
    db.prepare('INSERT INTO sessions(token,person_id) VALUES(?,?)').run(token,p.id);
    send(res,200,{found:true, person:pub(p), cv:cvOf(p.id), token});
  },
  /* Forgot password: request lands in the site owner's admin card;
     microedu resets the account to the starter password (micro1234) and
     tells the member on Gmail. Same response whether the email exists. */
  'POST /api/password/forgot': async (req,res) => {
    const b = await body(req);
    const email = String(b.email||'').trim();
    if (email) {
      const p = db.prepare('SELECT * FROM registered_people WHERE LOWER(email)=LOWER(?)').get(email);
      if (p && !db.prepare('SELECT 1 FROM password_resets WHERE person_id=? AND done=0').get(p.id))
        db.prepare('INSERT INTO password_resets(person_id,email) VALUES(?,?)').run(p.id, p.email);
    }
    send(res,200,{ok:true});
  },
  'GET /api/password-resets': (req,res) => {
    const me = auth(req); if (!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    send(res,200,{resets: db.prepare('SELECT r.id, r.person_id, r.email, r.created_at, p.name FROM password_resets r JOIN registered_people p ON p.id=r.person_id WHERE r.done=0 ORDER BY r.id').all()});
  },
  'POST /api/password-resets/reset': async (req,res) => {
    const me = auth(req); if (!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM password_resets WHERE id=? AND done=0').get(Number(b.id)||0);
    if (!r) return send(res,404,{error:'Request not found'});
    db.prepare('UPDATE registered_people SET password_hash=? WHERE id=?').run(hashPw('micro1234'), r.person_id);
    db.prepare('UPDATE password_resets SET done=1 WHERE id=?').run(r.id);
    send(res,200,{ok:true, email:r.email});
  },
  'POST /api/password-resets/dismiss': async (req,res) => {
    const me = auth(req); if (!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    const b = await body(req);
    db.prepare('UPDATE password_resets SET done=1 WHERE id=?').run(Number(b.id)||0);
    send(res,200,{ok:true});
  },
  'GET /api/me': (req,res) => {
    const me = auth(req); if (!me) return send(res,401,{error:'Sign in required'});
    send(res,200,{person:pub(me), cv:cvOf(me.id)});
  },
  /* Change own password (signed in). */
  'POST /api/me/password': async (req,res) => {
    const me = auth(req); if (!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    if (!b.new_password || String(b.new_password).length < 6) return send(res,400,{error:'New password must be at least 6 characters'});
    if (!verifyPw(b.current_password||'', me.password_hash)) return send(res,403,{error:'Current password is wrong'});
    db.prepare('UPDATE registered_people SET password_hash=? WHERE id=?').run(hashPw(String(b.new_password)), me.id);
    send(res,200,{ok:true});
  },
  /* Update own basic details (name, phone, mobile, appearance/photo). */
  'POST /api/me/update': async (req,res) => {
    const me = auth(req); if (!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const name = (b.name||'').trim() || me.name;
    const photoMode = ['personal','group','anonymous'].includes(b.photo_mode) ? b.photo_mode : (me.photo_mode||'personal');
    let photoData = me.photo_data || null;
    if (photoMode === 'anonymous') photoData = null;
    else if (typeof b.photo_data === 'string' && b.photo_data.startsWith('data:image/') && b.photo_data.length <= 500000) photoData = b.photo_data;
    db.prepare('UPDATE registered_people SET name=?,phone=?,mobile=?,photo_data=?,photo_mode=?,group_name=? WHERE id=?')
      .run(name, b.phone !== undefined ? (b.phone||null) : me.phone, b.mobile !== undefined ? (b.mobile||null) : me.mobile, photoData, photoMode, photoMode === 'group' ? (b.group_name||null) : null, me.id);
    send(res,200,{person:pub(db.prepare('SELECT * FROM registered_people WHERE id=?').get(me.id)), cv:cvOf(me.id)});
  },
  /* Public counts only — no names, emails or phones (1.2). The home page
     counters read this, so they work for signed-out visitors too. */
  'GET /api/stats': (req,res) => {
    const t = db.prepare('SELECT COUNT(*) c FROM cv_details WHERE teacher_ready=1').get();
    const tt = db.prepare('SELECT COUNT(*) c FROM cv_details WHERE teacher_ready=1 AND accepts_time_exchange=1').get();
    const m = db.prepare('SELECT COUNT(*) c FROM registered_people').get();
    send(res,200,{counts:{teachers: t?t.c:0, members: m?m.c:0, time_teachers: tt?tt.c:0}});
  },
  /* Registered People list (Decision A): signed-in members only. The
     full member rows (names, emails, phones) are no longer public. */
  'GET /api/people': (req,res) => {
    const me = auth(req); if (!me) return send(res,401,{error:'Sign in required'});
    const people = db.prepare('SELECT * FROM registered_people ORDER BY id').all().map(p => ({...pubPublic(p), cv:cvOf(p.id), subscription: db.prepare("SELECT * FROM subscriptions WHERE person_id=? ORDER BY id DESC LIMIT 1").get(p.id)||null }));
    const teachersCount = db.prepare('SELECT COUNT(*) c FROM cv_details WHERE teacher_ready=1').get().c;
    const timeTeachers = db.prepare('SELECT COUNT(*) c FROM cv_details WHERE teacher_ready=1 AND accepts_time_exchange=1').get().c;
    const counts = { teachers: teachersCount, members: people.length, time_teachers: timeTeachers, Teacher: teachersCount, Student: people.length - teachersCount, Other: 0 };
    send(res,200,{counts, total:people.length, people});
  },
  'GET /api/teachers': (req,res) => {
    const teachers = db.prepare('SELECT p.* FROM registered_people p JOIN cv_details c ON c.person_id=p.id WHERE c.teacher_ready=1 ORDER BY p.id').all().map(p => ({...pubPublic(p), cv:cvOf(p.id), ...teacherStats(p.id)}));
    send(res,200,{teachers});
  },
  'POST /api/subscriptions': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const months = [1,3,6,12].includes(Number(b.months)) ? Number(b.months) : 1;
    const plan = PLANS[b.plan]!==undefined ? b.plan : Object.keys(PLANS)[0];
    const amount = PLANS[plan]*months;
    const info = db.prepare('INSERT INTO subscriptions(person_id,plan,months,amount_bdt,status) VALUES(?,?,?,?,\'Pending\')').run(me.id,plan,months,amount);
    send(res,201,{subscription: db.prepare('SELECT * FROM subscriptions WHERE id=?').get(Number(info.lastInsertRowid))});
  },
  'POST /api/subscriptions/confirm': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    db.prepare("UPDATE subscriptions SET status='Confirm' WHERE id=? AND person_id=?").run(b.id,me.id);
    send(res,200,{subscription: db.prepare('SELECT * FROM subscriptions WHERE id=?').get(b.id)});
  },
  'POST /api/requests': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    if (!b.teacher_id || !b.subject || !b.topic) return send(res,400,{error:'teacher_id, subject and topic are required'});
    const t = db.prepare('SELECT * FROM registered_people WHERE id=?').get(b.teacher_id);
    const cv = t ? cvOf(t.id) : null;
    if (!t || !cv || !cv.teacher_ready) return send(res,404,{error:'Teacher not found'});
    const pricing = cv.pricing_type ? cv.pricing_type : 'hourly';
    let rate = Number(cv.rate_bdt_per_hour)||0;
    if (pricing==='hourly' && !rate) rate = 500;
    const hours = Number(b.hours)||1; let amount = hours*rate;
    if (pricing==='free') { rate = 0; amount = 0; }
    if (pricing==='bidding') { const offer = Number(b.offer_amount)||0; if (offer>0) amount = offer; }
    /* Time bank payment: only with teachers who opted in, and only when
       the student holds enough time credit for the booked hours. */
    const payWith = b.pay_with==='time' ? 'time' : 'money';
    if (payWith==='time') {
      if (!cv.accepts_time_exchange) return send(res,400,{error:'This teacher does not accept time exchange'});
      const need = Math.round(hours*60);
      if (timeBalance(me.id) < need) return send(res,400,{error:'Not enough time credit for this class'});
      amount = 0;
    }
    const g = newGid();
    /* Private Jitsi room with an unguessable random name — handed out only
       by /api/requests/join, inside the booked window, to the participants. */
    const link = 'https://meet.jit.si/microedu-' + crypto.randomBytes(16).toString('hex');
    const info = db.prepare('INSERT INTO tuition_requests(gid,student_id,teacher_id,level,subject,chapter,topic,hours,rate_bdt_per_hour,amount_bdt,available_time,status,class_link,class_start,pay_with) VALUES(?,?,?,?,?,?,?,?,?,?,?,\'Pending\',?,?,?)')
      .run(g,me.id,t.id,b.level||null,b.subject,b.chapter||null,b.topic,hours,rate,amount,b.available_time||null,link,b.class_start||null,payWith);
    db.prepare('INSERT INTO payments(gid,person_id,amount_bdt,status) VALUES(?,?,?,\'Pending\')').run(g,me.id,amount);
    notify(t.id, '📩 New request from ' + me.name + ' — ' + b.subject + ' · ' + b.topic, g);
    /* Email alert (2.1): new request → the teacher. On this dev server
       it only logs; the live Worker sends it (see worker.js). */
    mailTo(t.id, 'New request on microedu.com — ' + b.subject,
      'Hi ' + (t.name || 'teacher') + ',\n\n' + me.name + ' asked for help with ' + b.subject + ' — ' + b.topic + ' (' + hours + ' hour' + (hours > 1 ? 's' : '') + ').\n\nSign in to accept or decline it:\n' + SITE_URL + '/dashboard\n\n— microedu.com');
    send(res,201,{request: stripLink(db.prepare('SELECT * FROM tuition_requests WHERE id=?').get(Number(info.lastInsertRowid)))});
  },
  /* bKash advance payment: student submits the TrxID; microedu (admin)
     verifies it, which is what sets Confirm + Held. */
  'POST /api/payments/submit': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r || r.student_id!==me.id) return send(res,404,{error:'Request not found'});
    if (r.teacher_response!=='Accepted' || !['Pending','Confirm'].includes(r.status)) return send(res,400,{error:'The teacher must accept first'});
    if (r.pay_with==='time' || Number(r.amount_bdt)<=0) return send(res,400,{error:'This class needs no bKash payment'});
    const trxid = String(b.trxid||'').trim().toUpperCase();
    if (trxid.length<6) return send(res,400,{error:'Please enter the bKash transaction ID (TrxID)'});
    db.prepare('UPDATE payments SET trxid=?, sender=?, rejected=0 WHERE gid=?').run(trxid, String(b.sender||'').trim()||null, r.gid);
    /* Choosing this teacher: siblings for the same help go on hold a day. */
    holdSiblings(r);
    if (me.id !== 1) notify(1, '💳 ' + me.name + ' submitted a bKash payment (TrxID ' + trxid + ') — ' + r.subject + '. Please verify it.', r.gid);
    send(res,200,{ok:true});
  },
  'GET /api/payments/to-verify': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    const rows = db.prepare("SELECT p.gid, p.amount_bdt, p.trxid, p.sender, t.subject, t.topic, s.name AS student_name, te.name AS teacher_name FROM payments p JOIN tuition_requests t ON t.gid=p.gid JOIN registered_people s ON s.id=t.student_id JOIN registered_people te ON te.id=t.teacher_id WHERE p.trxid IS NOT NULL AND p.verified=0 AND p.rejected=0 ORDER BY p.id DESC").all();
    send(res,200,{payments: rows});
  },
  'POST /api/payments/verify': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r) return send(res,404,{error:'Request not found'});
    if (b.ok) {
      db.prepare("UPDATE payments SET verified=1, status='Confirm', escrow_status='Held' WHERE gid=?").run(r.gid);
      db.prepare("UPDATE tuition_requests SET status='Confirm' WHERE gid=? AND status='Pending'").run(r.gid);
      holdSiblings(r);
    } else {
      db.prepare('UPDATE payments SET rejected=1, trxid=NULL, sender=NULL WHERE gid=?').run(r.gid);
    }
    const stuV = db.prepare('SELECT name FROM registered_people WHERE id=?').get(r.student_id);
    const teaV = db.prepare('SELECT name FROM registered_people WHERE id=?').get(r.teacher_id);
    if (b.ok) {
      notify(r.student_id, '✅ Your payment was verified — your class with ' + (teaV ? teaV.name : 'your teacher') + ' is confirmed (' + r.subject + ').', r.gid);
      notify(r.teacher_id, '✅ Payment verified for your class with ' + (stuV ? stuV.name : 'your student') + ' (' + r.subject + ').', r.gid);
      /* Email alert (2.1): payment verified → student + teacher. */
      mailTo(r.student_id, 'Payment verified — your microedu class is confirmed',
        'Hi ' + (stuV ? stuV.name : '') + ',\n\nYour payment for ' + r.subject + ' — ' + r.topic + ' was verified. Your class with ' + (teaV ? teaV.name : 'your teacher') + ' is confirmed.\n\nSee it in your dashboard:\n' + SITE_URL + '/dashboard#myReqCard\n\n— microedu.com');
      mailTo(r.teacher_id, 'Payment verified for your microedu class',
        'Hi ' + (teaV ? teaV.name : '') + ',\n\nPayment was verified for your class with ' + (stuV ? stuV.name : 'your student') + ' (' + r.subject + ' — ' + r.topic + '). The money is held safely with microedu until the class is Done.\n\nSee it in your dashboard:\n' + SITE_URL + '/dashboard#reqToMeCard\n\n— microedu.com');
    } else {
      notify(r.student_id, '⚠️ Your bKash payment could not be verified — please check the TrxID and submit again (' + r.subject + ').', r.gid);
    }
    send(res,200,{ok:true});
  },
  'POST /api/payments/confirm': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r) return send(res,404,{error:'Request not found'});
    const next = b.status || 'Confirm';
    if (!['Confirm','Ongoing','Done'].includes(next)) return send(res,400,{error:'status must be Confirm, Ongoing or Done'});
    /* The cycle: teacher accepts first, then the student confirms payment. */
    if (next==='Confirm' && r.teacher_response!=='Accepted') return send(res,400,{error:'The teacher has not accepted this request yet'});
    /* Money classes confirm only through bKash TrxID verification. */
    if (next==='Confirm' && r.pay_with!=='time' && Number(r.amount_bdt)>0) return send(res,400,{error:'Pay by bKash first — microedu will verify your payment and confirm the class.'});
    db.prepare('UPDATE tuition_requests SET status=? WHERE gid=?').run(next,r.gid);
    if (next==='Confirm') { db.prepare("UPDATE payments SET status='Confirm', escrow_status='Held' WHERE gid=?").run(r.gid); holdSiblings(r); }
    if (next==='Done') {
      const mins = Math.round((Number(r.hours)||1)*60);
      const timeExists = db.prepare("SELECT 1 FROM time_entries WHERE gid=? AND kind='earn'").get(r.gid);
      if (r.pay_with==='time') {
        /* Time-paid class: the student's time credit moves to the teacher. */
        if (!timeExists) {
          db.prepare("INSERT INTO time_entries(person_id,gid,topic,minutes,kind) VALUES(?,?,?,?,'earn')").run(r.teacher_id,r.gid,r.topic,mins);
          db.prepare("INSERT INTO time_entries(person_id,gid,topic,minutes,kind) VALUES(?,?,?,?,'spend')").run(r.student_id,r.gid,r.topic,-mins);
        }
      } else if (Number(r.amount_bdt) > 0) {
        const exists = db.prepare("SELECT 1 FROM wallet_entries WHERE gid=? AND kind='credit'").get(r.gid);
        if (!exists) db.prepare("INSERT INTO wallet_entries(person_id,gid,topic,amount_bdt,kind) VALUES(?,?,?,?,'credit')").run(r.teacher_id,r.gid,r.topic,r.amount_bdt);
      } else if (!timeExists) {
        /* Free class: the teacher earns the time as time-bank credit. */
        db.prepare("INSERT INTO time_entries(person_id,gid,topic,minutes,kind) VALUES(?,?,?,?,'earn')").run(r.teacher_id,r.gid,r.topic,mins);
      }
      db.prepare("UPDATE payments SET escrow_status='Released' WHERE gid=?").run(r.gid);
      /* Service properly received: siblings for this help are removed. */
      deleteSiblingsFinal(r);
      if (r.pay_with==='time' || Number(r.amount_bdt) <= 0) notify(r.teacher_id, '⏳ Class done — ' + mins + ' minutes of time credit added to your time bank (' + r.subject + ').', r.gid);
      else notify(r.teacher_id, '💰 Class done — BDT ' + r.amount_bdt + ' added to your wallet (' + r.subject + ').', r.gid);
    }
    send(res,200,{request: stripLink(db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(r.gid))});
  },
  /* The teacher answers a request from their own dashboard ("Requests to
     me"): Accept = willing, Decline = not willing (booking cancelled).
     Only while Pending; the student sees the answer in their dashboard. */
  'POST /api/requests/respond': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r) return send(res,404,{error:'Request not found'});
    if (r.teacher_id!==me.id) return send(res,403,{error:'Only the teacher of this request can answer it'});
    if (r.status!=='Pending') return send(res,400,{error:'This request is no longer waiting for an answer'});
    if (onHold(r)) return send(res,400,{error:'This request is on hold for a day — the student is trying another teacher for this help first'});
    if (!['Accepted','Declined'].includes(b.response)) return send(res,400,{error:'response must be Accepted or Declined'});
    if (b.response==='Declined') db.prepare("UPDATE tuition_requests SET teacher_response='Declined', status='Cancelled' WHERE gid=?").run(r.gid);
    else db.prepare("UPDATE tuition_requests SET teacher_response='Accepted' WHERE gid=?").run(r.gid);
    notify(r.student_id, b.response === 'Accepted'
      ? '✅ ' + me.name + ' accepted your request — ' + r.subject + ' · ' + r.topic + '. You can now pay in My Requests.'
      : '❌ ' + me.name + ' declined your request — ' + r.subject + ' · ' + r.topic + '.', r.gid);
    /* Email alert (2.1): teacher accepts → the student. (A decline is
       bell-only — the student picks another teacher from the dashboard.) */
    if (b.response === 'Accepted') {
      const stu = db.prepare('SELECT name FROM registered_people WHERE id=?').get(r.student_id);
      mailTo(r.student_id, me.name + ' accepted your microedu request — ' + r.subject,
        'Hi ' + (stu ? stu.name : '') + ',\n\n' + me.name + ' accepted your request for ' + r.subject + ' — ' + r.topic + '. You can now pay in My Requests.\n\nSign in to pay:\n' + SITE_URL + '/dashboard#myReqCard\n\n— microedu.com');
    }
    send(res,200,{request: stripLink(db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(r.gid))});
  },
  /* Secure join: link returned only to this booking's own student/teacher,
     only when confirmed, only inside the booked time window. */
  'POST /api/requests/join': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r) return send(res,404,{error:'Request not found'});
    if (r.student_id!==me.id && r.teacher_id!==me.id) return send(res,403,{error:'Only this class\u2019s student and teacher can join it'});
    if (!['Confirm','Ongoing'].includes(r.status)) return send(res,403,{error:'Class is not confirmed yet'});
    /* Advance payment rule: money classes need a verified bKash payment. */
    if (r.pay_with!=='time' && Number(r.amount_bdt)>0) {
      const pay = db.prepare('SELECT verified FROM payments WHERE gid=? ORDER BY id DESC LIMIT 1').get(r.gid);
      if (!pay || !pay.verified) return send(res,403,{error:'Payment not verified yet — the student pays by bKash first and microedu verifies it'});
    }
    const w = joinWindow(r);
    if (!w.ok) return send(res,403,{error: w.reason==='too_early' ? 'Too early \u2014 the class opens 15 minutes before its booked time' : 'This class time is over \u2014 ask microedu for an extension', reason:w.reason});
    send(res,200,{class_link:r.class_link, closes_at:w.closes_at||null});
  },
  /* Extra time: a participant asks, microedu (site owner, member #1) approves. */
  'POST /api/requests/extend': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r) return send(res,404,{error:'Request not found'});
    if (r.student_id!==me.id && r.teacher_id!==me.id) return send(res,403,{error:'Only this class\u2019s student and teacher can ask for more time'});
    const mins = [30,60].includes(Number(b.minutes)) ? Number(b.minutes) : 30;
    db.prepare("UPDATE tuition_requests SET extension_status='Requested', extension_minutes=? WHERE gid=?").run(mins,r.gid);
    send(res,200,{request: stripLink(db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(r.gid))});
  },
  'GET /api/extensions': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    send(res,200,{extensions: db.prepare("SELECT * FROM tuition_requests WHERE extension_status='Requested' ORDER BY id DESC").all().map(stripLink)});
  },
  'POST /api/requests/extend/approve': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r) return send(res,404,{error:'Request not found'});
    db.prepare("UPDATE tuition_requests SET extension_status='Approved' WHERE gid=? AND extension_status='Requested'").run(r.gid);
    send(res,200,{request: stripLink(db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(r.gid))});
  },
  /* Escrow refund: money still held with microedu returns to the student in
     full and the booking is cancelled. Only before the class is Done. */
  'POST /api/payments/refund': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const r = db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(b.gid||'');
    if (!r) return send(res,404,{error:'Request not found'});
    if (r.student_id!==me.id && me.id!==1) return send(res,403,{error:'Only the student of this class (or microedu) can refund it'});
    if (r.status==='Done') return send(res,400,{error:'Class already done \u2014 the money has been released to the teacher'});
    const pay = db.prepare('SELECT * FROM payments WHERE gid=? ORDER BY id DESC LIMIT 1').get(r.gid);
    if (!pay || pay.escrow_status!=='Held') return send(res,400,{error:'Only money held with microedu can be refunded'});
    db.prepare("UPDATE payments SET escrow_status='Refunded' WHERE gid=?").run(r.gid);
    db.prepare("UPDATE tuition_requests SET status='Cancelled' WHERE gid=?").run(r.gid);
    /* Issue raised: the other teachers for this help reactivate at once. */
    clearSiblingHolds(r);
    send(res,200,{request: stripLink(db.prepare('SELECT * FROM tuition_requests WHERE gid=?').get(r.gid)), refunded:true});
  },
  'GET /api/wallet': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    send(res,200,{balance: walletBalance(me.id), entries: db.prepare('SELECT * FROM wallet_entries WHERE person_id=? ORDER BY id DESC').all(me.id)});
  },
  'POST /api/wallet/withdraw': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req); const amt = Number(b.amount)||0;
    if (amt<=0) return send(res,400,{error:'Amount must be positive'});
    if (amt > walletBalance(me.id)) return send(res,400,{error:'Insufficient wallet balance'});
    db.prepare("INSERT INTO wallet_entries(person_id,gid,topic,amount_bdt,kind) VALUES(?,NULL,'Withdraw',?,'withdraw')").run(me.id,-amt);
    send(res,200,{balance: walletBalance(me.id)});
  },
  /* Email subscription list: paid plans are paused, so the Subscription
     page only collects an email address. Anyone may join; the admin sees
     the list (with member details when the email belongs to a member). */
  'POST /api/subscribe': async (req,res) => {
    const b = await body(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res,400,{error:'Please enter a valid email address'});
    const ex = db.prepare('SELECT id FROM subscribers WHERE email=?').get(email);
    if (ex) return send(res,200,{ok:true, already:true});
    db.prepare('INSERT INTO subscribers(email) VALUES(?)').run(email);
    send(res,201,{ok:true});
  },
  'GET /api/subscribers': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    if (me.id!==1) return send(res,403,{error:'microedu admin only'});
    const rows = db.prepare('SELECT s.id, s.email, s.created_at, p.id AS member_id, p.name AS member_name FROM subscribers s LEFT JOIN registered_people p ON lower(p.email)=s.email ORDER BY s.id DESC').all();
    send(res,200,{subscribers: rows});
  },
  /* The member's own stored notifications (bell panel). They stay until
     the member deletes them — one by one, or all at once. */
  'GET /api/notifications': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const rows = db.prepare('SELECT id, text, gid, is_read, created_at FROM notifications WHERE person_id=? ORDER BY id DESC LIMIT 40').all(me.id);
    const u = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE person_id=? AND is_read=0').get(me.id);
    send(res,200,{notifications: rows, unread: u ? u.n : 0});
  },
  'POST /api/notifications/read': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    db.prepare('UPDATE notifications SET is_read=1 WHERE person_id=?').run(me.id);
    send(res,200,{ok:true});
  },
  'POST /api/notifications/delete': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    db.prepare('DELETE FROM notifications WHERE id=? AND person_id=?').run(Number(b.id) || 0, me.id);
    send(res,200,{ok:true});
  },
  'POST /api/notifications/clear': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    db.prepare('DELETE FROM notifications WHERE person_id=?').run(me.id);
    send(res,200,{ok:true});
  },
  /* One rating per member per class (2.2): rating the same class again
     replaces the earlier rating instead of adding a second row, so the
     averages in 1.5 stay honest. */
  'POST /api/feedback': async (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const b = await body(req);
    const ranking = b.ranking ? Number(b.ranking) : null;
    if (ranking !== null && (ranking < 1 || ranking > 5)) return send(res,400,{error:'Ranking must be 1 to 5 stars'});
    const existing = b.gid ? db.prepare('SELECT * FROM feedback_evaluation WHERE person_id=? AND gid=?').get(me.id, b.gid) : null;
    if (existing) {
      db.prepare('UPDATE feedback_evaluation SET comment=?, ranking=?, complain=? WHERE id=?').run(b.comment||null, ranking, b.complain||null, existing.id);
      return send(res,200,{feedback: db.prepare('SELECT * FROM feedback_evaluation WHERE id=?').get(existing.id)});
    }
    const info = db.prepare('INSERT INTO feedback_evaluation(person_id,gid,comment,ranking,complain) VALUES(?,?,?,?,?)').run(me.id,b.gid||null,b.comment||null,ranking,b.complain||null);
    send(res,201,{feedback: db.prepare('SELECT * FROM feedback_evaluation WHERE id=?').get(Number(info.lastInsertRowid))});
  },
  /* A teacher's own completed classes + average stars (2.2), shown under
     the As Teacher view in the dashboard. */
  'GET /api/my-rating': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    send(res,200,teacherStats(me.id));
  },
  /* No member-to-member messaging by design: learners send a request to
     microedu, microedu finalizes it from both sides, and only then is the
     meeting organized. Contact happens through the request flow only. */

  /* Teacher suggestions for a help request: match the learner's words
     against each teacher's subjects, speciality and expertise. */
  'GET /api/suggest': (req,res,url) => {
    const q = url.searchParams;
    const words = [...new Set(((q.get('subject')||'') + ' ' + (q.get('topic')||'') + ' ' + (q.get('chapter')||'')).toLowerCase().split(/[^a-z0-9\u0980-\u09FF]+/).filter(w => w.length >= 3))];
    const level = (q.get('level')||'').toLowerCase().trim();
    const rows = db.prepare('SELECT p.* FROM registered_people p JOIN cv_details c ON c.person_id=p.id WHERE c.teacher_ready=1 ORDER BY p.id').all();
    const scored = rows.map(p => {
      const cv = cvOf(p.id);
      const hay = ((cv.subjects||'') + ' ' + (cv.speciality||'') + ' ' + (cv.expertise_time||'') + ' ' + (cv.profession||'')).toLowerCase();
      const matched = words.filter(w => hay.includes(w));
      let score = matched.length;
      if (level && (cv.level||'').toLowerCase().includes(level)) score += 2;
      return {...pubPublic(p), cv, match_score: score, matched, ...teacherStats(p.id)};
    });
    scored.sort((a,b) => b.match_score - a.match_score || (Number(a.cv.rate_bdt_per_hour)||0) - (Number(b.cv.rate_bdt_per_hour)||0));
    send(res,200,{teachers: scored.slice(0,6)});
  },
  /* Time bank: balance and history for the signed-in member. */
  'GET /api/timebank': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    send(res,200,{balance_minutes: timeBalance(me.id), entries: db.prepare('SELECT * FROM time_entries WHERE person_id=? ORDER BY id DESC').all(me.id)});
  },
  'GET /api/my-requests': (req,res) => {
    const me = auth(req); if(!me) return send(res,401,{error:'Sign in required'});
    const enrich = rows => rows.map(r => { const pay = db.prepare('SELECT escrow_status, status, trxid, sender, verified, rejected FROM payments WHERE gid=? ORDER BY id DESC LIMIT 1').get(r.gid); const sn = db.prepare('SELECT name, photo_mode FROM registered_people WHERE id=?').get(r.student_id); const tn = db.prepare('SELECT name, photo_mode FROM registered_people WHERE id=?').get(r.teacher_id); const shownName = (row, pid, label) => (!row ? null : (row.photo_mode==='anonymous' && me.id!==pid && me.id!==1 ? label : row.name)); const fb = db.prepare('SELECT ranking, comment FROM feedback_evaluation WHERE person_id=? AND gid=? ORDER BY id DESC LIMIT 1').get(me.id, r.gid); return {...stripLink(r), escrow_status: pay ? pay.escrow_status : 'Awaiting payment', pay_status: pay ? pay.status : null, trxid: pay ? pay.trxid : null, sender: pay ? pay.sender : null, verified: pay ? pay.verified : 0, rejected: pay ? pay.rejected : 0, student_name: shownName(sn, r.student_id, 'Anonymous student'), teacher_name: shownName(tn, r.teacher_id, 'Anonymous teacher'), my_rating: fb ? fb.ranking : null, my_rating_comment: fb ? fb.comment : null}; });
    send(res,200,{asStudent: enrich(db.prepare('SELECT * FROM tuition_requests WHERE student_id=? ORDER BY id DESC').all(me.id)), asTeacher: enrich(db.prepare('SELECT * FROM tuition_requests WHERE teacher_id=? ORDER BY id DESC').all(me.id))});
  },
};

const MIME = {'.html':'text/html','.css':'text/css','.js':'text/javascript','.json':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml'};
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = req.method + ' ' + url.pathname;
  if (routes[key]) { try { await routes[key](req,res,url); } catch(e){ send(res,500,{error:e.message}); } return; }
  if (url.pathname.startsWith('/api/')) return send(res,404,{error:'Not found'});
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!path.extname(file)) file += '.html';
  const fp = path.join(__dirname,'..','public', path.normalize(file).replace(/^(\.\.[\/\\])+/,''));
  fs.readFile(fp,(err,data)=>{ if(err){res.writeHead(404);return res.end('Not found');} res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'application/octet-stream'}); res.end(data); });
});
server.listen(PORT, () => console.log(`microedu.com running at http://localhost:${PORT}`));
