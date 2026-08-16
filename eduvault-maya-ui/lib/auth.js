// ---------------------------------------------------------------------------
// EduVault auth tokens
// ---------------------------------------------------------------------------
// Lightweight, dependency-free, HMAC-signed session tokens (no JWT library
// needed). Issued on register/login/card-login, then required on every
// route that acts on behalf of a specific teacher or student -- so emp_id /
// roll_no is never taken on trust from a request body again.
//
// Token shape:  base64url(payload_json) + "." + hmac_sha256(base64url_body)
// ---------------------------------------------------------------------------

const crypto = require("crypto");

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

if (!process.env.SESSION_SECRET) {
  console.warn(
    "[eduvault] WARNING: SESSION_SECRET is not set. A random secret was " +
      "generated for this process, so every existing session will be " +
      "invalidated on restart. Set SESSION_SECRET in your environment for " +
      "any real deployment (see .env.example)."
  );
}

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function sign(body) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(body).digest("base64url");
}

// payload: { sub: emp_id | roll_no, role: "teacher" | "student" }
function issueToken({ sub, role }) {
  const payload = { sub, role, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(body);
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;

  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const expectedSig = sign(body);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null; // tampered or forged
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf-8"));
  } catch {
    return null;
  }

  if (!payload || !payload.exp || Date.now() > payload.exp) return null; // expired
  return payload;
}

// Reads a token from (in order): Authorization: Bearer header, ?token=
// query param (needed for plain <a href> download links, which can't set
// custom headers), or a `token` field in a JSON body.
function getAuthFromRequest(req) {
  const header = req.headers.authorization || "";
  const headerToken = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const token = headerToken || req.query.token || (req.body && req.body.token);
  return verifyToken(token);
}

// Express middleware. Pass a role ("teacher" | "student" | "admin"), or an
// array of roles, to enforce the token was issued for one of them. Sets
// req.auth = { sub, role }.
function requireAuth(role) {
  const allowed = role ? (Array.isArray(role) ? role : [role]) : null;
  return (req, res, next) => {
    const payload = getAuthFromRequest(req);
    if (!payload || (allowed && !allowed.includes(payload.role))) {
      return res.status(401).json({ error: "Not authenticated. Please log in again." });
    }
    req.auth = payload;
    next();
  };
}

// ---------------------------------------------------------------------------
// Enrollment verification tokens
// ---------------------------------------------------------------------------
// Separate, short-lived, purpose-tagged tokens (same HMAC scheme as session
// tokens, but never accepted by requireAuth -- they only prove "this exact
// email address just verified an Enrollment Code", nothing more). Issued by
// POST /api/teachers/enrollment/verify, and required by POST
// /api/teachers/register. This is what makes the Enrollment Code check a
// server-side gate instead of a frontend-only step: registration is
// rejected without a valid, unexpired, email-matching token, regardless of
// what the client claims in the request body.
// ---------------------------------------------------------------------------
const ENROLLMENT_TOKEN_TTL_MS = 20 * 60 * 1000; // 20 minutes to complete the registration form

function issueEnrollmentToken({ email }) {
  const payload = {
    purpose: "employee_enrollment",
    email: String(email).trim().toLowerCase(),
    iat: Date.now(),
    exp: Date.now() + ENROLLMENT_TOKEN_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = sign(body);
  return `${body}.${sig}`;
}

// Verifies the token AND that it was issued for the given email, so a
// verified token for teacher1@gmail.com can never be reused for
// teacher2@gmail.com (see verifyToken's signature/expiry checks above).
function verifyEnrollmentToken(token, email) {
  const payload = verifyToken(token);
  if (!payload || payload.purpose !== "employee_enrollment") return null;
  if (payload.email !== String(email || "").trim().toLowerCase()) return null;
  return payload;
}

module.exports = {
  issueToken,
  verifyToken,
  getAuthFromRequest,
  requireAuth,
  issueEnrollmentToken,
  verifyEnrollmentToken,
};
