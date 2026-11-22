-- microedu.com — Relational schema for Cloudflare D1 (SQLite dialect)
-- Same tables/relationships as database/schema.sql (PostgreSQL) and the
-- embedded schema in server/server.js. One database for ALL registered
-- people. Everything links by person_id / GID.
-- Run this in the D1 Console (or: wrangler d1 execute d2d-microedu-db --file=cloudflare/schema-d1.sql)

CREATE TABLE IF NOT EXISTS registered_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('Teacher','Student','Other')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT, mobile TEXT,
  password_hash TEXT NOT NULL, -- PBKDF2 hash (Web Crypto), never plain text
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
  teacher_ready INTEGER DEFAULT 0,
  accepts_time_exchange INTEGER DEFAULT 0,
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
  gid TEXT NOT NULL UNIQUE, -- XXXX-XXX-XXX
  student_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  teacher_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  level TEXT, subject TEXT NOT NULL, chapter TEXT, topic TEXT NOT NULL,
  hours REAL NOT NULL DEFAULT 1,
  rate_bdt_per_hour REAL NOT NULL DEFAULT 500,
  amount_bdt REAL NOT NULL,
  available_time TEXT,
  pay_with TEXT DEFAULT 'money',
  teacher_response TEXT DEFAULT 'Waiting',
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
  escrow_status TEXT DEFAULT 'Awaiting payment',
  trxid TEXT, sender TEXT, verified INTEGER DEFAULT 0, rejected INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Confirm')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pay_gid ON payments(gid);
CREATE INDEX IF NOT EXISTS idx_pay_person ON payments(person_id);

CREATE TABLE IF NOT EXISTS wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES registered_people(id) ON DELETE CASCADE,
  gid TEXT, topic TEXT,
  amount_bdt REAL NOT NULL, -- positive = credit, negative = withdraw
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
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  gid TEXT, topic TEXT,
  minutes INTEGER NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_person ON time_entries(person_id);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
