// ---------------------------------------------------------------------------
// EduVault data layer — SQLite via Node built-in (node:sqlite)
// No native compile, no Python, works on Windows with Node 22.5+
// Invitation flow: admin invites email first; employee requests code later.
// ---------------------------------------------------------------------------

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "eduvault.sqlite");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS teachers (
    emp_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT,
    subjects_handled TEXT,
    email TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'teacher',
    active INTEGER NOT NULL DEFAULT 1,
    email_verified INTEGER NOT NULL DEFAULT 0,
    seeded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS students (
    roll_no TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT,
    semester TEXT,
    email TEXT,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    bookmarked_teachers TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS materials (
    material_id TEXT PRIMARY KEY,
    emp_id TEXT NOT NULL,
    subject TEXT,
    title TEXT,
    unit TEXT,
    semester TEXT,
    file_url TEXT,
    original_name TEXT,
    upload_date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS access_logs (
    log_id TEXT PRIMARY KEY,
    roll_no TEXT NOT NULL,
    material_id TEXT NOT NULL,
    accessed_on TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trusted_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_type TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(owner_type, owner_id, token_hash)
  );

  CREATE TABLE IF NOT EXISTS enrollment_codes (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    email TEXT NOT NULL,
    employee_id TEXT,
    department TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    name TEXT,
    employee_id TEXT,
    department TEXT,
    created_at TEXT NOT NULL,
    revoked_at TEXT,
    used_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_enrollment_email ON enrollment_codes(email);
  CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
  CREATE INDEX IF NOT EXISTS idx_materials_emp ON materials(emp_id);
  CREATE INDEX IF NOT EXISTS idx_access_material ON access_logs(material_id);
`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

function newId() {
  return crypto.randomUUID();
}

function hashDeviceToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function rowTeacher(t) {
  if (!t) return null;
  return {
    emp_id: t.emp_id,
    name: t.name,
    department: t.department,
    subjects_handled: t.subjects_handled,
    email: t.email,
    password_hash: t.password_hash,
    role: t.role,
    active: Boolean(t.active),
    email_verified: Boolean(t.email_verified),
    seeded: Boolean(t.seeded),
    created_at: t.created_at,
  };
}

function rowStudent(s) {
  if (!s) return null;
  return {
    roll_no: s.roll_no,
    name: s.name,
    department: s.department,
    semester: s.semester,
    email: s.email,
    password_hash: s.password_hash,
    active: Boolean(s.active),
    bookmarked_teachers: JSON.parse(s.bookmarked_teachers || "[]"),
    created_at: s.created_at,
  };
}

function rowMaterial(m) {
  if (!m) return null;
  return { ...m };
}

function rowEnrollment(c) {
  if (!c) return null;
  return {
    id: c.id,
    code_hash: c.code_hash,
    email: c.email,
    employee_id: c.employee_id,
    department: c.department,
    attempts: c.attempts,
    expires_at: c.expires_at,
    used_at: c.used_at,
    created_at: c.created_at,
    revoked_at: c.revoked_at,
  };
}

// ---- device trust ----------------------------------------------------------
function trustDevice(owner_type, owner_id, device_token) {
  if (!device_token) return;
  const token_hash = hashDeviceToken(device_token);
  try {
    db.prepare(
      `INSERT OR IGNORE INTO trusted_devices (owner_type, owner_id, token_hash, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(owner_type, owner_id, token_hash, new Date().toISOString());
  } catch (_) {
    // ignore unique conflicts
  }
}

function isDeviceTrusted(owner_type, owner_id, device_token) {
  if (!device_token) return false;
  const token_hash = hashDeviceToken(device_token);
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM trusted_devices
       WHERE owner_type = ? AND owner_id = ? AND token_hash = ?`
    )
    .get(owner_type, owner_id, token_hash);
  return Boolean(row);
}

function isIdCardAlreadyRegistered(id) {
  const normalizedId = String(id).trim();
  const student = db.prepare(`SELECT roll_no FROM students WHERE roll_no = ?`).get(normalizedId);
  if (student) return { exists: true, role: "student" };
  const teacher = db.prepare(`SELECT emp_id FROM teachers WHERE emp_id = ?`).get(normalizedId);
  if (teacher) return { exists: true, role: "teacher" };
  return { exists: false, role: null };
}

// ---- Teachers --------------------------------------------------------------
function createTeacher({ emp_id, name, department, subjects_handled, email, password, role, email_verified, seeded }) {
  const existing = db.prepare(`SELECT emp_id FROM teachers WHERE emp_id = ?`).get(emp_id);
  if (existing) throw new Error("A teacher with this Employee ID already exists.");

  const password_hash = hashPassword(password);
  const roleVal = role === "admin" ? "admin" : "teacher";
  const created_at = new Date().toISOString();

  db.prepare(
    `INSERT INTO teachers
     (emp_id, name, department, subjects_handled, email, password_hash, role, active, email_verified, seeded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
  ).run(
    emp_id,
    name,
    department,
    subjects_handled,
    email,
    password_hash,
    roleVal,
    email_verified ? 1 : 0,
    seeded ? 1 : 0,
    created_at
  );

  return sanitizeTeacher(
    rowTeacher({
      emp_id,
      name,
      department,
      subjects_handled,
      email,
      password_hash,
      role: roleVal,
      active: 1,
      email_verified: email_verified ? 1 : 0,
      seeded: seeded ? 1 : 0,
      created_at,
    })
  );
}

function findTeacher(emp_id) {
  const row = db.prepare(`SELECT * FROM teachers WHERE emp_id = ?`).get(emp_id);
  return rowTeacher(row);
}

function listTeachers() {
  return db.prepare(`SELECT * FROM teachers`).all().map((t) => sanitizeTeacher(rowTeacher(t)));
}

function sanitizeTeacher(t) {
  if (!t) return null;
  const { password_hash, ...rest } = t;
  return rest;
}

function authenticateTeacher(emp_id, password) {
  const teacher = findTeacher(emp_id);
  if (!teacher) throw new Error("No teacher found with that Employee ID.");
  if (!verifyPassword(password, teacher.password_hash)) {
    throw new Error("Incorrect password.");
  }
  if (teacher.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeTeacher(teacher);
}

function authenticateTeacherByCard(emp_id, device_token) {
  const teacher = findTeacher(emp_id);
  if (!teacher) {
    const err = new Error("No teacher account is registered for this ID card yet.");
    err.code = "UNKNOWN_CARD";
    throw err;
  }
  if (!isDeviceTrusted("teacher", teacher.emp_id, device_token)) {
    const err = new Error(
      "This device hasn't been used with your password yet. Please log in with your Employee ID and password once to enable one-tap card login on this device."
    );
    err.code = "DEVICE_NOT_TRUSTED";
    throw err;
  }
  if (teacher.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeTeacher(teacher);
}

// ---- Students --------------------------------------------------------------
function createStudent({ roll_no, name, department, semester, email, password }) {
  const existing = db.prepare(`SELECT roll_no FROM students WHERE roll_no = ?`).get(roll_no);
  if (existing) throw new Error("A student with this Roll Number already exists.");

  const password_hash = hashPassword(password);
  const created_at = new Date().toISOString();

  db.prepare(
    `INSERT INTO students
     (roll_no, name, department, semester, email, password_hash, active, bookmarked_teachers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, '[]', ?)`
  ).run(roll_no, name, department, semester, email, password_hash, created_at);

  return sanitizeStudent(
    rowStudent({
      roll_no,
      name,
      department,
      semester,
      email,
      password_hash,
      active: 1,
      bookmarked_teachers: "[]",
      created_at,
    })
  );
}

function findStudent(roll_no) {
  const row = db.prepare(`SELECT * FROM students WHERE roll_no = ?`).get(roll_no);
  return rowStudent(row);
}

function sanitizeStudent(s) {
  if (!s) return null;
  const { password_hash, ...rest } = s;
  return rest;
}

function authenticateStudent(roll_no, password) {
  const student = findStudent(roll_no);
  if (!student) throw new Error("No student found with that Roll Number.");
  if (!verifyPassword(password, student.password_hash)) {
    throw new Error("Incorrect password.");
  }
  if (student.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeStudent(student);
}

function authenticateStudentByCard(roll_no, device_token) {
  const student = findStudent(roll_no);
  if (!student) {
    const err = new Error("No student account is registered for this ID card yet.");
    err.code = "UNKNOWN_CARD";
    throw err;
  }
  if (!isDeviceTrusted("student", student.roll_no, device_token)) {
    const err = new Error(
      "This device hasn't been used with your password yet. Please log in with your Roll Number and password once to enable one-tap card login on this device."
    );
    err.code = "DEVICE_NOT_TRUSTED";
    throw err;
  }
  if (student.active === false) {
    const err = new Error("This account has been deactivated. Contact your administrator.");
    err.code = "ACCOUNT_INACTIVE";
    throw err;
  }
  return sanitizeStudent(student);
}

function toggleBookmark(roll_no, emp_id) {
  const student = findStudent(roll_no);
  if (!student) throw new Error("Student not found.");
  const list = student.bookmarked_teachers.slice();
  const idx = list.indexOf(emp_id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(emp_id);

  db.prepare(`UPDATE students SET bookmarked_teachers = ? WHERE roll_no = ?`).run(
    JSON.stringify(list),
    roll_no
  );
  return list;
}

// ---- Invitations -----------------------------------------------------------
function createInvitation({ email, name, department, employee_id }) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Email is required.");

  db.prepare(
    `UPDATE invitations SET revoked_at = ?
     WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL`
  ).run(new Date().toISOString(), norm);

  const invitation = {
    id: newId(),
    email: norm,
    name: name || null,
    employee_id: employee_id ? String(employee_id).trim() : null,
    department: department || null,
    created_at: new Date().toISOString(),
    revoked_at: null,
    used_at: null,
  };

  db.prepare(
    `INSERT INTO invitations
     (id, email, name, employee_id, department, created_at, revoked_at, used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
  ).run(
    invitation.id,
    invitation.email,
    invitation.name,
    invitation.employee_id,
    invitation.department,
    invitation.created_at
  );

  return sanitizeInvitation(invitation);
}

function sanitizeInvitation(inv) {
  if (!inv) return null;
  let status = "pending";
  if (inv.revoked_at) status = "revoked";
  else if (inv.used_at) status = "used";
  return { ...inv, status };
}

function listInvitations() {
  return db
    .prepare(`SELECT * FROM invitations ORDER BY created_at DESC`)
    .all()
    .map(sanitizeInvitation);
}

function findActiveInvitation(email) {
  const norm = normalizeEmail(email);
  const row = db
    .prepare(
      `SELECT * FROM invitations
       WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(norm);
  return row ? sanitizeInvitation(row) : null;
}

function revokeInvitation(id) {
  const row = db.prepare(`SELECT * FROM invitations WHERE id = ?`).get(id);
  if (!row) throw new Error("Invitation not found.");
  if (row.used_at) throw new Error("This invitation has already been used.");
  db.prepare(`UPDATE invitations SET revoked_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id
  );
  return sanitizeInvitation(db.prepare(`SELECT * FROM invitations WHERE id = ?`).get(id));
}

function markInvitationUsed(email) {
  const norm = normalizeEmail(email);
  db.prepare(
    `UPDATE invitations SET used_at = ?
     WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL`
  ).run(new Date().toISOString(), norm);
}

// ---- Enrollment codes ------------------------------------------------------
const ENROLLMENT_CODE_TTL_MINUTES = Number(process.env.ENROLLMENT_CODE_TTL_MINUTES) || 15;
const ENROLLMENT_RESEND_COOLDOWN_SEC = Number(process.env.ENROLLMENT_RESEND_COOLDOWN_SEC) || 60;
const ENROLLMENT_MAX_REQUESTS_PER_HOUR = Number(process.env.ENROLLMENT_MAX_REQUESTS_PER_HOUR) || 5;
const ENROLLMENT_MAX_VERIFY_ATTEMPTS = 5;

function hashEnrollmentCode(code, email) {
  const key = process.env.SESSION_SECRET || "eduvault-dev-only-key";
  return crypto.createHmac("sha256", key).update(`${email}:${code}`).digest("hex");
}

function generateEnrollmentCode() {
  const n = crypto.randomInt(0, 1000000);
  return `EDU-${String(n).padStart(6, "0")}`;
}

function canRequestEnrollmentCode(email) {
  const norm = normalizeEmail(email);
  const now = Date.now();
  const recent = db
    .prepare(`SELECT * FROM enrollment_codes WHERE email = ? ORDER BY created_at DESC`)
    .all(norm)
    .map(rowEnrollment);

  if (recent.length) {
    const lastMs = new Date(recent[0].created_at).getTime();
    const elapsedSec = (now - lastMs) / 1000;
    if (elapsedSec < ENROLLMENT_RESEND_COOLDOWN_SEC) {
      return {
        allowed: false,
        reason: "cooldown",
        retryAfterSec: Math.ceil(ENROLLMENT_RESEND_COOLDOWN_SEC - elapsedSec),
      };
    }
  }

  const lastHour = recent.filter((c) => now - new Date(c.created_at).getTime() < 60 * 60 * 1000);
  if (lastHour.length >= ENROLLMENT_MAX_REQUESTS_PER_HOUR) {
    return { allowed: false, reason: "hourly_limit", retryAfterSec: 60 * 60 };
  }

  return { allowed: true };
}

function createEnrollmentCode({ email, department, employee_id }) {
  const norm = normalizeEmail(email);

  db.prepare(
    `UPDATE enrollment_codes
     SET revoked_at = ?
     WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL`
  ).run(new Date().toISOString(), norm);

  const code = generateEnrollmentCode();
  const record = {
    id: newId(),
    code_hash: hashEnrollmentCode(code, norm),
    email: norm,
    employee_id: employee_id ? String(employee_id).trim() : null,
    department: department || null,
    attempts: 0,
    expires_at: new Date(Date.now() + ENROLLMENT_CODE_TTL_MINUTES * 60 * 1000).toISOString(),
    used_at: null,
    created_at: new Date().toISOString(),
    revoked_at: null,
  };

  db.prepare(
    `INSERT INTO enrollment_codes
     (id, code_hash, email, employee_id, department, attempts, expires_at, used_at, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL)`
  ).run(
    record.id,
    record.code_hash,
    record.email,
    record.employee_id,
    record.department,
    record.expires_at,
    record.created_at
  );

  return { code, record: sanitizeEnrollmentCode(record) };
}

function sanitizeEnrollmentCode(c) {
  if (!c) return null;
  const { code_hash, ...rest } = c;
  const now = Date.now();
  let status = "active";
  if (c.revoked_at) status = "revoked";
  else if (c.used_at) status = "used";
  else if (new Date(c.expires_at).getTime() < now) status = "expired";
  return { ...rest, status };
}

function listEnrollmentCodes() {
  return db
    .prepare(`SELECT * FROM enrollment_codes ORDER BY created_at DESC`)
    .all()
    .map((c) => sanitizeEnrollmentCode(rowEnrollment(c)));
}

function revokeEnrollmentCode(id) {
  const record = db.prepare(`SELECT * FROM enrollment_codes WHERE id = ?`).get(id);
  if (!record) throw new Error("Enrollment code not found.");
  if (record.used_at) throw new Error("This code has already been used and cannot be revoked.");
  db.prepare(`UPDATE enrollment_codes SET revoked_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    id
  );
  const updated = db.prepare(`SELECT * FROM enrollment_codes WHERE id = ?`).get(id);
  return sanitizeEnrollmentCode(rowEnrollment(updated));
}

function verifyEnrollmentCode(email, code) {
  const norm = normalizeEmail(email);
  const candidate = db
    .prepare(
      `SELECT * FROM enrollment_codes
       WHERE email = ? AND used_at IS NULL AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(norm);

  if (!candidate) return { ok: false, reason: "invalid" };
  if (new Date(candidate.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (candidate.attempts >= ENROLLMENT_MAX_VERIFY_ATTEMPTS) {
    db.prepare(`UPDATE enrollment_codes SET revoked_at = ? WHERE id = ?`).run(
      new Date().toISOString(),
      candidate.id
    );
    return { ok: false, reason: "locked" };
  }

  const suppliedHash = hashEnrollmentCode(String(code || "").trim().toUpperCase(), norm);
  const candidateHashBuf = Buffer.from(candidate.code_hash, "hex");
  const suppliedHashBuf = Buffer.from(suppliedHash, "hex");
  const matches =
    candidateHashBuf.length === suppliedHashBuf.length &&
    crypto.timingSafeEqual(candidateHashBuf, suppliedHashBuf);

  if (!matches) {
    db.prepare(`UPDATE enrollment_codes SET attempts = attempts + 1 WHERE id = ?`).run(candidate.id);
    return { ok: false, reason: "invalid" };
  }

  db.prepare(`UPDATE enrollment_codes SET used_at = ? WHERE id = ?`).run(
    new Date().toISOString(),
    candidate.id
  );
  const updated = db.prepare(`SELECT * FROM enrollment_codes WHERE id = ?`).get(candidate.id);
  return { ok: true, record: sanitizeEnrollmentCode(rowEnrollment(updated)) };
}

// ---- Admin -----------------------------------------------------------------
function ensureSeedAdmin() {
  const emp_id = process.env.ADMIN_EMP_ID || "mani@1774admin";
  const password = process.env.ADMIN_PASSWORD || "mani@1774";

  const existing = db.prepare(`SELECT * FROM teachers WHERE emp_id = ?`).get(emp_id);
  if (existing) {
    if (existing.role !== "admin" || !existing.seeded) {
      db.prepare(
        `UPDATE teachers SET role = 'admin', seeded = 1, email_verified = 1, active = 1 WHERE emp_id = ?`
      ).run(emp_id);
    }
    return sanitizeTeacher(rowTeacher(db.prepare(`SELECT * FROM teachers WHERE emp_id = ?`).get(emp_id)));
  }

  const password_hash = hashPassword(password);
  const created_at = new Date().toISOString();
  const email = process.env.ADMIN_EMAIL || "";

  db.prepare(
    `INSERT INTO teachers
     (emp_id, name, department, subjects_handled, email, password_hash, role, active, email_verified, seeded, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, 1, 1, ?)`
  ).run(emp_id, "System Administrator", "Administration", "", email, password_hash, created_at);

  return sanitizeTeacher(
    rowTeacher({
      emp_id,
      name: "System Administrator",
      department: "Administration",
      subjects_handled: "",
      email,
      password_hash,
      role: "admin",
      active: 1,
      email_verified: 1,
      seeded: 1,
      created_at,
    })
  );
}

function listAllTeachers() {
  return db.prepare(`SELECT * FROM teachers`).all().map((t) => sanitizeTeacher(rowTeacher(t)));
}

function listAllStudents() {
  return db.prepare(`SELECT * FROM students`).all().map((s) => sanitizeStudent(rowStudent(s)));
}

function setTeacherActive(emp_id, active) {
  const teacher = findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");
  if (teacher.seeded && !active) throw new Error("The system administrator account cannot be deactivated.");
  db.prepare(`UPDATE teachers SET active = ? WHERE emp_id = ?`).run(active ? 1 : 0, emp_id);
  return sanitizeTeacher(findTeacher(emp_id));
}

function setTeacherRole(emp_id, role) {
  if (!["teacher", "admin"].includes(role)) throw new Error("Invalid role.");
  const teacher = findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");
  db.prepare(`UPDATE teachers SET role = ? WHERE emp_id = ?`).run(role, emp_id);
  return sanitizeTeacher(findTeacher(emp_id));
}

function deleteTeacher(emp_id) {
  const teacher = findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");
  if (teacher.seeded) throw new Error("The system administrator account cannot be deleted.");
  db.prepare(`DELETE FROM teachers WHERE emp_id = ?`).run(emp_id);
  return sanitizeTeacher(teacher);
}

function setStudentActive(roll_no, active) {
  const student = findStudent(roll_no);
  if (!student) throw new Error("Student not found.");
  db.prepare(`UPDATE students SET active = ? WHERE roll_no = ?`).run(active ? 1 : 0, roll_no);
  return sanitizeStudent(findStudent(roll_no));
}

function deleteStudent(roll_no) {
  const student = findStudent(roll_no);
  if (!student) throw new Error("Student not found.");
  db.prepare(`DELETE FROM students WHERE roll_no = ?`).run(roll_no);
  return sanitizeStudent(student);
}

// ---- Materials -------------------------------------------------------------
function addMaterial({ emp_id, subject, title, unit, semester, file_url, original_name }) {
  const teacher = findTeacher(emp_id);
  if (!teacher) throw new Error("Unknown teacher Employee ID.");

  const material = {
    material_id: newId(),
    emp_id,
    subject,
    title,
    unit: unit || "",
    semester: semester || "",
    file_url,
    original_name,
    upload_date: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO materials
     (material_id, emp_id, subject, title, unit, semester, file_url, original_name, upload_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    material.material_id,
    material.emp_id,
    material.subject,
    material.title,
    material.unit,
    material.semester,
    material.file_url,
    material.original_name,
    material.upload_date
  );

  return material;
}

function materialsByTeacher(emp_id) {
  return db
    .prepare(`SELECT * FROM materials WHERE emp_id = ? ORDER BY upload_date DESC`)
    .all(emp_id)
    .map(rowMaterial);
}

function findMaterial(material_id) {
  const row = db.prepare(`SELECT * FROM materials WHERE material_id = ?`).get(material_id);
  return rowMaterial(row);
}

function findMaterialByStoredFilename(filename) {
  const rows = db.prepare(`SELECT * FROM materials`).all();
  const match = rows.find((m) => path.basename(m.file_url) === filename);
  return rowMaterial(match || null);
}

function deleteMaterial(material_id, emp_id) {
  const material = db
    .prepare(`SELECT * FROM materials WHERE material_id = ? AND emp_id = ?`)
    .get(material_id, emp_id);
  if (!material) throw new Error("Material not found for this teacher.");
  db.prepare(`DELETE FROM materials WHERE material_id = ? AND emp_id = ?`).run(material_id, emp_id);
  return rowMaterial(material);
}

// ---- Access log ------------------------------------------------------------
function logAccess({ roll_no, material_id }) {
  const log = {
    log_id: newId(),
    roll_no,
    material_id,
    accessed_on: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO access_logs (log_id, roll_no, material_id, accessed_on)
     VALUES (?, ?, ?, ?)`
  ).run(log.log_id, log.roll_no, log.material_id, log.accessed_on);
  return log;
}

function accessCountsForTeacher(emp_id) {
  const materialIds = materialsByTeacher(emp_id).map((m) => m.material_id);
  if (!materialIds.length) return {};

  const placeholders = materialIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT material_id, COUNT(*) AS cnt FROM access_logs
       WHERE material_id IN (${placeholders})
       GROUP BY material_id`
    )
    .all(...materialIds);

  const counts = {};
  rows.forEach((r) => {
    counts[r.material_id] = r.cnt;
  });
  return counts;
}

module.exports = {
  createTeacher,
  findTeacher,
  listTeachers,
  authenticateTeacher,
  authenticateTeacherByCard,
  sanitizeTeacher,
  createStudent,
  findStudent,
  authenticateStudent,
  authenticateStudentByCard,
  sanitizeStudent,
  toggleBookmark,
  addMaterial,
  materialsByTeacher,
  findMaterial,
  findMaterialByStoredFilename,
  deleteMaterial,
  logAccess,
  accessCountsForTeacher,

  isIdCardAlreadyRegistered,

  trustDevice,
  isDeviceTrusted,

  createEnrollmentCode,
  canRequestEnrollmentCode,
  verifyEnrollmentCode,
  listEnrollmentCodes,
  revokeEnrollmentCode,

  createInvitation,
  listInvitations,
  findActiveInvitation,
  revokeInvitation,
  markInvitationUsed,

  ensureSeedAdmin,
  listAllTeachers,
  listAllStudents,
  setTeacherActive,
  setTeacherRole,
  deleteTeacher,
  setStudentActive,
  deleteStudent,
};
