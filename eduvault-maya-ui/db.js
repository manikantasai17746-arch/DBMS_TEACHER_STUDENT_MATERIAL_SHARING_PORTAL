// ---------------------------------------------------------------------------
// EduVault data layer — PostgreSQL via pg (Supabase compatible)
// Supports both local PostgreSQL and Supabase deployments
// ---------------------------------------------------------------------------

const crypto = require("crypto");
const { Pool } = require("pg");

// Connection pool — works with local PostgreSQL and Supabase (Vercel serverless).
// CRITICAL for Supabase + Vercel:
// 1. Prefer Transaction pooler URI (port 6543) from Supabase → Settings → Database.
// 2. We auto-add sslmode=require and pgbouncer=true for pooler hosts.
// 3. max: 1 + query retries avoid transient SSL/handshake failures on cold starts.
function normalizeDatabaseUrl(raw) {
  let url = (raw || "postgresql://localhost/eduvault").trim();
  // Strip accidental quotes from Vercel env UI copy-paste
  if (
    (url.startsWith('"') && url.endsWith('"')) ||
    (url.startsWith("'") && url.endsWith("'"))
  ) {
    url = url.slice(1, -1);
  }

  const isLocal = /localhost|127\.0\.0\.1/.test(url);
  if (isLocal) return url;

  const isSupabase = /supabase\.(co|com)|pooler\.supabase/i.test(url);
  const isPooler = /pooler\.supabase|:6543\b/i.test(url);

  try {
    const u = new URL(url);
    // Always require TLS for remote hosts
    if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", "require");
    // Transaction-mode PgBouncer (port 6543) breaks prepared statements unless flagged
    if (isPooler || isSupabase) {
      if (!u.searchParams.has("pgbouncer")) u.searchParams.set("pgbouncer", "true");
    }
    return u.toString();
  } catch {
    // Fallback string append if URL parser fails on unusual schemes
    const join = url.includes("?") ? "&" : "?";
    if (!/sslmode=/i.test(url)) url += `${join}sslmode=require`;
    if ((isPooler || isSupabase) && !/pgbouncer=/i.test(url)) {
      url += (url.includes("?") ? "&" : "?") + "pgbouncer=true";
    }
    return url;
  }
}

function buildPoolConfig() {
  const connectionString = normalizeDatabaseUrl(
    process.env.DATABASE_URL || "postgresql://localhost/eduvault"
  );

  const isLocal =
    /localhost|127\.0\.0\.1/.test(connectionString) &&
    !process.env.DATABASE_SSL;

  const needsSsl =
    !isLocal ||
    process.env.DATABASE_SSL === "true" ||
    /supabase|sslmode=require/i.test(connectionString);

  const isServerless = !!(
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.FUNCTION_NAME
  );

  if (process.env.DATABASE_URL) {
    // Log host only (never password) so Vercel runtime logs help debugging
    try {
      const u = new URL(connectionString);
      console.log(
        `[eduvault] Postgres host=${u.hostname} port=${u.port || "5432"} ssl=${!!needsSsl} serverless=${isServerless}`
      );
    } catch (_) {}
  }

  return {
    connectionString,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: isServerless ? 1 : 10,
    idleTimeoutMillis: isServerless ? 5000 : 30000,
    connectionTimeoutMillis: 20000,
    allowExitOnIdle: isServerless,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

const pool = new Pool(buildPoolConfig());

// Handle connection errors
pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

// Retry transient SSL / connection drops (common on Vercel cold start + Supabase)
const TRANSIENT_RE =
  /ssl|tls|ECONNRESET|ECONNREFUSED|Connection terminated|timeout|EPROTO|handshake|Client has encountered a connection|Connection ended unexpectedly|sorry, too many clients/i;

const _rawQuery = pool.query.bind(pool);
pool.query = async function queryWithRetry(text, params) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await _rawQuery(text, params);
    } catch (err) {
      lastErr = err;
      const msg = String(err && err.message ? err.message : err);
      if (attempt < 3 && TRANSIENT_RE.test(msg)) {
        console.warn(
          `[eduvault] DB transient error (attempt ${attempt}/3):`,
          msg.slice(0, 180)
        );
        // Drop bad clients from the pool, then brief backoff
        await new Promise((r) => setTimeout(r, 300 * attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
};

// Initialize database schema on startup
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS teachers (
        emp_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department TEXT,
        subjects_handled TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'teacher',
        active BOOLEAN NOT NULL DEFAULT true,
        email_verified BOOLEAN NOT NULL DEFAULT false,
        seeded BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS students (
        roll_no TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        department TEXT,
        semester TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        active BOOLEAN NOT NULL DEFAULT true,
        bookmarked_teachers JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS materials (
        material_id TEXT PRIMARY KEY,
        emp_id TEXT NOT NULL REFERENCES teachers(emp_id),
        subject TEXT,
        title TEXT,
        unit TEXT,
        semester TEXT,
        file_url TEXT,
        original_name TEXT,
        upload_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS access_logs (
        log_id TEXT PRIMARY KEY,
        roll_no TEXT NOT NULL REFERENCES students(roll_no),
        material_id TEXT NOT NULL REFERENCES materials(material_id),
        accessed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS trusted_devices (
        id SERIAL PRIMARY KEY,
        owner_type TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(owner_type, owner_id, token_hash)
      );

      CREATE TABLE IF NOT EXISTS enrollment_codes (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL,
        email TEXT NOT NULL,
        employee_id TEXT,
        department TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        name TEXT,
        employee_id TEXT,
        department TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP,
        used_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_enrollment_email ON enrollment_codes(email);
      CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);
      CREATE INDEX IF NOT EXISTS idx_materials_emp ON materials(emp_id);
      CREATE INDEX IF NOT EXISTS idx_access_material ON access_logs(material_id);
    `);
    console.log("✓ Database schema initialized");
  } catch (err) {
    console.error("Error initializing database:", err);
  }
}

// Initialize on module load

// Ensure older Supabase schemas pick up columns added later (CREATE TABLE IF NOT EXISTS
// will not alter an existing table).
async function ensureStudentSchema() {
  try {
    await pool.query(`
      ALTER TABLE students ADD COLUMN IF NOT EXISTS semester TEXT;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS department TEXT;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS bookmarked_teachers JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE students ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
    `);
  } catch (err) {
    console.warn("[eduvault] ensureStudentSchema:", err.message);
  }
}
ensureStudentSchema();

initializeDatabase();

// ---- Utility Functions -----
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

function parseBookmarks(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  // pg sometimes returns JSON objects; only keep arrays
  return [];
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
    // pg may return boolean or (rarely) string/int depending on driver/settings
    active: s.active === true || s.active === 1 || s.active === "t" || s.active === "true",
    bookmarked_teachers: parseBookmarks(s.bookmarked_teachers),
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

// ---- Device Trust ----
async function trustDevice(owner_type, owner_id, device_token) {
  if (!device_token) return;
  const token_hash = hashDeviceToken(device_token);
  try {
    await pool.query(
      `INSERT INTO trusted_devices (owner_type, owner_id, token_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_type, owner_id, token_hash) DO NOTHING`,
      [owner_type, owner_id, token_hash]
    );
  } catch (_) {
    // ignore conflicts
  }
}

async function isDeviceTrusted(owner_type, owner_id, device_token) {
  if (!device_token) return false;
  const token_hash = hashDeviceToken(device_token);
  const result = await pool.query(
    `SELECT 1 as ok FROM trusted_devices
     WHERE owner_type = $1 AND owner_id = $2 AND token_hash = $3`,
    [owner_type, owner_id, token_hash]
  );
  return result.rows.length > 0;
}

async function isIdCardAlreadyRegistered(id) {
  const normalizedId = String(id).trim();
  const studentResult = await pool.query(
    `SELECT roll_no FROM students WHERE roll_no = $1`,
    [normalizedId]
  );
  if (studentResult.rows.length) return { exists: true, role: "student" };
  
  const teacherResult = await pool.query(
    `SELECT emp_id FROM teachers WHERE emp_id = $1`,
    [normalizedId]
  );
  if (teacherResult.rows.length) return { exists: true, role: "teacher" };
  
  return { exists: false, role: null };
}

// ---- Teachers ----
async function createTeacher({
  emp_id,
  name,
  department,
  subjects_handled,
  email,
  password,
  role,
  email_verified,
  seeded,
}) {
  const existing = await pool.query(`SELECT emp_id FROM teachers WHERE emp_id = $1`, [emp_id]);
  if (existing.rows.length) throw new Error("A teacher with this Employee ID already exists.");

  const password_hash = hashPassword(password);
  const roleVal = role === "admin" ? "admin" : "teacher";

  const result = await pool.query(
    `INSERT INTO teachers
     (emp_id, name, department, subjects_handled, email, password_hash, role, active, email_verified, seeded)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)
     RETURNING *`,
    [
      emp_id,
      name,
      department,
      subjects_handled,
      email,
      password_hash,
      roleVal,
      email_verified ? true : false,
      seeded ? true : false,
    ]
  );

  return sanitizeTeacher(rowTeacher(result.rows[0]));
}

async function findTeacher(emp_id) {
  const result = await pool.query(`SELECT * FROM teachers WHERE emp_id = $1`, [emp_id]);
  return result.rows.length ? rowTeacher(result.rows[0]) : null;
}

async function listTeachers() {
  const result = await pool.query(`SELECT * FROM teachers`);
  return result.rows.map((t) => sanitizeTeacher(rowTeacher(t)));
}

function sanitizeTeacher(t) {
  if (!t) return null;
  const { password_hash, ...rest } = t;
  return rest;
}

async function authenticateTeacher(emp_id, password) {
  const teacher = await findTeacher(emp_id);
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

async function authenticateTeacherByCard(emp_id, device_token) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) {
    const err = new Error("No teacher account is registered for this ID card yet.");
    err.code = "UNKNOWN_CARD";
    throw err;
  }
  if (!(await isDeviceTrusted("teacher", teacher.emp_id, device_token))) {
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

// ---- Students ----
async function createStudent({ roll_no, name, department, semester, email, password }) {
  const id = String(roll_no || "").trim();
  if (!id) throw new Error("Roll Number is required.");

  const existing = await pool.query(`SELECT roll_no FROM students WHERE roll_no = $1`, [id]);
  if (existing.rows.length) throw new Error("A student with this Roll Number already exists.");

  const password_hash = hashPassword(password);

  const result = await pool.query(
    `INSERT INTO students
     (roll_no, name, department, semester, email, password_hash, active, bookmarked_teachers)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7::jsonb)
     RETURNING *`,
    [
      id,
      String(name || "").trim(),
      department ? String(department).trim() : null,
      semester ? String(semester).trim() : null,
      email ? String(email).trim() : null,
      password_hash,
      "[]",
    ]
  );

  if (!result.rows.length) {
    throw new Error("Student was not saved. Please try again.");
  }

  return sanitizeStudent(rowStudent(result.rows[0]));
}

async function findStudent(roll_no) {
  const result = await pool.query(`SELECT * FROM students WHERE roll_no = $1`, [roll_no]);
  return result.rows.length ? rowStudent(result.rows[0]) : null;
}

function sanitizeStudent(s) {
  if (!s) return null;
  const { password_hash, ...rest } = s;
  return rest;
}

async function authenticateStudent(roll_no, password) {
  const student = await findStudent(roll_no);
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

async function authenticateStudentByCard(roll_no, device_token) {
  const student = await findStudent(roll_no);
  if (!student) {
    const err = new Error("No student account is registered for this ID card yet.");
    err.code = "UNKNOWN_CARD";
    throw err;
  }
  if (!(await isDeviceTrusted("student", student.roll_no, device_token))) {
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

async function toggleBookmark(roll_no, emp_id) {
  const student = await findStudent(roll_no);
  if (!student) throw new Error("Student not found.");
  
  let list = student.bookmarked_teachers.slice();
  const idx = list.indexOf(emp_id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(emp_id);

  await pool.query(
    `UPDATE students SET bookmarked_teachers = $1 WHERE roll_no = $2`,
    [JSON.stringify(list), roll_no]
  );
  return list;
}

// ---- Invitations ----
async function createInvitation({ email, name, department, employee_id }) {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Email is required.");

  const invitationId = newId();
  const now = new Date();

  await pool.query(
    `UPDATE invitations SET revoked_at = $1
     WHERE email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [now, norm]
  );

  const result = await pool.query(
    `INSERT INTO invitations
     (id, email, name, employee_id, department, created_at, revoked_at, used_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL)
     RETURNING *`,
    [invitationId, norm, name || null, employee_id ? String(employee_id).trim() : null, department || null, now]
  );

  return sanitizeInvitation(result.rows[0]);
}

function sanitizeInvitation(inv) {
  if (!inv) return null;
  let status = "pending";
  if (inv.revoked_at) status = "revoked";
  else if (inv.used_at) status = "used";
  return { ...inv, status };
}

async function listInvitations() {
  const result = await pool.query(
    `SELECT * FROM invitations ORDER BY created_at DESC`
  );
  return result.rows.map(sanitizeInvitation);
}

async function findActiveInvitation(email) {
  const norm = normalizeEmail(email);
  const result = await pool.query(
    `SELECT * FROM invitations
     WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [norm]
  );
  return result.rows.length ? sanitizeInvitation(result.rows[0]) : null;
}

async function revokeInvitation(id) {
  const result = await pool.query(`SELECT * FROM invitations WHERE id = $1`, [id]);
  if (!result.rows.length) throw new Error("Invitation not found.");
  if (result.rows[0].used_at) throw new Error("This invitation has already been used.");

  const now = new Date();
  await pool.query(`UPDATE invitations SET revoked_at = $1 WHERE id = $2`, [now, id]);

  const updated = await pool.query(`SELECT * FROM invitations WHERE id = $1`, [id]);
  return sanitizeInvitation(updated.rows[0]);
}

async function markInvitationUsed(email) {
  const norm = normalizeEmail(email);
  const now = new Date();
  await pool.query(
    `UPDATE invitations SET used_at = $1
     WHERE email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [now, norm]
  );
}

// ---- Enrollment Codes ----
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

async function canRequestEnrollmentCode(email) {
  const norm = normalizeEmail(email);
  const now = Date.now();
  
  const result = await pool.query(
    `SELECT * FROM enrollment_codes WHERE email = $1 ORDER BY created_at DESC`,
    [norm]
  );
  
  const recent = result.rows.map(rowEnrollment);

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

async function createEnrollmentCode({ email, department, employee_id }) {
  const norm = normalizeEmail(email);
  const now = new Date();

  await pool.query(
    `UPDATE enrollment_codes
     SET revoked_at = $1
     WHERE email = $2 AND used_at IS NULL AND revoked_at IS NULL`,
    [now, norm]
  );

  const code = generateEnrollmentCode();
  const codeId = newId();
  const expiresAt = new Date(Date.now() + ENROLLMENT_CODE_TTL_MINUTES * 60 * 1000);

  const result = await pool.query(
    `INSERT INTO enrollment_codes
     (id, code_hash, email, employee_id, department, attempts, expires_at, used_at, created_at, revoked_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6, NULL, $7, NULL)
     RETURNING *`,
    [
      codeId,
      hashEnrollmentCode(code, norm),
      norm,
      employee_id ? String(employee_id).trim() : null,
      department || null,
      expiresAt,
      now,
    ]
  );

  return { code, record: sanitizeEnrollmentCode(result.rows[0]) };
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

async function listEnrollmentCodes() {
  const result = await pool.query(
    `SELECT * FROM enrollment_codes ORDER BY created_at DESC`
  );
  return result.rows.map((c) => sanitizeEnrollmentCode(rowEnrollment(c)));
}

async function revokeEnrollmentCode(id) {
  const result = await pool.query(`SELECT * FROM enrollment_codes WHERE id = $1`, [id]);
  if (!result.rows.length) throw new Error("Enrollment code not found.");
  if (result.rows[0].used_at) throw new Error("This code has already been used and cannot be revoked.");

  const now = new Date();
  await pool.query(`UPDATE enrollment_codes SET revoked_at = $1 WHERE id = $2`, [now, id]);

  const updated = await pool.query(`SELECT * FROM enrollment_codes WHERE id = $1`, [id]);
  return sanitizeEnrollmentCode(rowEnrollment(updated.rows[0]));
}

async function verifyEnrollmentCode(email, code) {
  const norm = normalizeEmail(email);
  const result = await pool.query(
    `SELECT * FROM enrollment_codes
     WHERE email = $1 AND used_at IS NULL AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [norm]
  );

  if (!result.rows.length) return { ok: false, reason: "invalid" };
  
  const candidate = result.rows[0];
  if (new Date(candidate.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "expired" };
  }
  if (candidate.attempts >= ENROLLMENT_MAX_VERIFY_ATTEMPTS) {
    await pool.query(
      `UPDATE enrollment_codes SET revoked_at = $1 WHERE id = $2`,
      [new Date(), candidate.id]
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
    await pool.query(
      `UPDATE enrollment_codes SET attempts = attempts + 1 WHERE id = $1`,
      [candidate.id]
    );
    return { ok: false, reason: "invalid" };
  }

  const now = new Date();
  await pool.query(`UPDATE enrollment_codes SET used_at = $1 WHERE id = $2`, [now, candidate.id]);
  const updated = await pool.query(`SELECT * FROM enrollment_codes WHERE id = $1`, [candidate.id]);
  return { ok: true, record: sanitizeEnrollmentCode(rowEnrollment(updated.rows[0])) };
}

// ---- Admin ----
async function ensureSeedAdmin() {
  const emp_id = process.env.ADMIN_EMP_ID || "mani@1774admin";
  const password = process.env.ADMIN_PASSWORD || "mani@1774";

  const existing = await pool.query(`SELECT * FROM teachers WHERE emp_id = $1`, [emp_id]);
  if (existing.rows.length) {
    const teacher = existing.rows[0];
    if (teacher.role !== "admin" || !teacher.seeded) {
      await pool.query(
        `UPDATE teachers SET role = 'admin', seeded = true, email_verified = true, active = true WHERE emp_id = $1`,
        [emp_id]
      );
    }
    const updated = await pool.query(`SELECT * FROM teachers WHERE emp_id = $1`, [emp_id]);
    return sanitizeTeacher(rowTeacher(updated.rows[0]));
  }

  const password_hash = hashPassword(password);
  const email = process.env.ADMIN_EMAIL || "";

  const result = await pool.query(
    `INSERT INTO teachers
     (emp_id, name, department, subjects_handled, email, password_hash, role, active, email_verified, seeded)
     VALUES ($1, $2, $3, $4, $5, $6, 'admin', true, true, true)
     RETURNING *`,
    [emp_id, "System Administrator", "Administration", "", email, password_hash]
  );

  return sanitizeTeacher(rowTeacher(result.rows[0]));
}

async function listAllTeachers() {
  const result = await pool.query(`SELECT * FROM teachers`);
  return result.rows.map((t) => sanitizeTeacher(rowTeacher(t)));
}

async function listAllStudents() {
  const result = await pool.query(
    `SELECT * FROM students ORDER BY created_at DESC NULLS LAST, roll_no ASC`
  );
  const out = [];
  for (const row of result.rows) {
    try {
      const mapped = sanitizeStudent(rowStudent(row));
      if (mapped && mapped.roll_no) out.push(mapped);
    } catch (err) {
      // Never let one bad row wipe the whole admin list
      console.error("[eduvault] Skipping bad student row:", row && row.roll_no, err.message);
      if (row && row.roll_no) {
        out.push({
          roll_no: row.roll_no,
          name: row.name || "(unknown)",
          department: row.department || null,
          semester: row.semester || null,
          email: row.email || null,
          active: true,
          bookmarked_teachers: [],
          created_at: row.created_at || null,
        });
      }
    }
  }
  return out;
}

async function setTeacherActive(emp_id, active) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");
  if (teacher.seeded && !active) throw new Error("The system administrator account cannot be deactivated.");

  await pool.query(`UPDATE teachers SET active = $1 WHERE emp_id = $2`, [active, emp_id]);
  return sanitizeTeacher(await findTeacher(emp_id));
}

async function setTeacherRole(emp_id, role) {
  if (!["teacher", "admin"].includes(role)) throw new Error("Invalid role.");
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");

  await pool.query(`UPDATE teachers SET role = $1 WHERE emp_id = $2`, [role, emp_id]);
  return sanitizeTeacher(await findTeacher(emp_id));
}

async function deleteTeacher(emp_id) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Teacher not found.");
  if (teacher.seeded) throw new Error("The system administrator account cannot be deleted.");

  await pool.query(`DELETE FROM teachers WHERE emp_id = $1`, [emp_id]);
  return sanitizeTeacher(teacher);
}

async function setStudentActive(roll_no, active) {
  const student = await findStudent(roll_no);
  if (!student) throw new Error("Student not found.");

  await pool.query(`UPDATE students SET active = $1 WHERE roll_no = $2`, [active, roll_no]);
  return sanitizeStudent(await findStudent(roll_no));
}

async function deleteStudent(roll_no) {
  const student = await findStudent(roll_no);
  if (!student) throw new Error("Student not found.");

  await pool.query(`DELETE FROM students WHERE roll_no = $1`, [roll_no]);
  return sanitizeStudent(student);
}

// ---- Materials ----
async function addMaterial({ emp_id, subject, title, unit, semester, file_url, original_name }) {
  const teacher = await findTeacher(emp_id);
  if (!teacher) throw new Error("Unknown teacher Employee ID.");

  const materialId = newId();
  const result = await pool.query(
    `INSERT INTO materials
     (material_id, emp_id, subject, title, unit, semester, file_url, original_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [materialId, emp_id, subject, title, unit || "", semester || "", file_url, original_name]
  );

  return result.rows[0];
}

async function materialsByTeacher(emp_id) {
  const result = await pool.query(
    `SELECT * FROM materials WHERE emp_id = $1 ORDER BY upload_date DESC`,
    [emp_id]
  );
  return result.rows.map(rowMaterial);
}

async function findMaterial(material_id) {
  const result = await pool.query(`SELECT * FROM materials WHERE material_id = $1`, [material_id]);
  return result.rows.length ? rowMaterial(result.rows[0]) : null;
}

async function findMaterialByStoredFilename(filename) {
  // Match by trailing path segment without loading every row into memory.
  const result = await pool.query(
    `SELECT * FROM materials
     WHERE file_url = $1
        OR file_url LIKE $2
        OR file_url LIKE $3
     LIMIT 1`,
    [filename, `%/${filename}`, `%\\${filename}`]
  );
  return result.rows.length ? rowMaterial(result.rows[0]) : null;
}

async function deleteMaterial(material_id, emp_id) {
  const result = await pool.query(
    `SELECT * FROM materials WHERE material_id = $1 AND emp_id = $2`,
    [material_id, emp_id]
  );
  if (!result.rows.length) throw new Error("Material not found for this teacher.");

  const material = result.rows[0];
  await pool.query(
    `DELETE FROM materials WHERE material_id = $1 AND emp_id = $2`,
    [material_id, emp_id]
  );
  return rowMaterial(material);
}

// ---- Access Logs ----
async function logAccess({ roll_no, material_id }) {
  const logId = newId();
  const now = new Date();
  
  const result = await pool.query(
    `INSERT INTO access_logs (log_id, roll_no, material_id, accessed_on)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [logId, roll_no, material_id, now]
  );

  return result.rows[0];
}

async function accessCountsForTeacher(emp_id) {
  const materials = await materialsByTeacher(emp_id);
  const materialIds = materials.map((m) => m.material_id);
  
  if (!materialIds.length) return {};

  const placeholders = materialIds.map((_, i) => `$${i + 1}`).join(",");
  const result = await pool.query(
    `SELECT material_id, COUNT(*) AS cnt FROM access_logs
     WHERE material_id IN (${placeholders})
     GROUP BY material_id`,
    materialIds
  );

  const counts = {};
  result.rows.forEach((r) => {
    counts[r.material_id] = parseInt(r.cnt);
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
