const express = require("express");
const router = express.Router();
const db = require("../db");
const { issueToken, requireAuth, issueEnrollmentToken, verifyEnrollmentToken } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const mailer = require("../lib/mailer");

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });
const cardLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// Requesting/verifying an Enrollment Code is its own, tighter limiter --
// this is on top of the per-email cooldown/hourly cap enforced in db.js
// (canRequestEnrollmentCode), which is what actually stops "hundreds of
// emails" to one address; this one bounds total requests from one IP.
const enrollmentRequestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });
const enrollmentVerifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Enrollment Code: request
// ---------------------------------------------------------------------------
// Employee enters their Gmail + a few basic details and asks for a code.
// The code itself is generated, hashed, and stored server-side, then emailed
// -- it is never present anywhere in this endpoint's JSON response.
router.post("/enrollment/request", enrollmentRequestLimiter, async (req, res) => {
  try {
    const { email, name, department, emp_id } = req.body;
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    // Must have a valid (pending) invitation from admin first
    const invitation = db.findActiveInvitation(email);
    if (!invitation) {
      return res.status(403).json({
        error:
          "This email has not been invited by an administrator. Ask your admin to send you an invitation first.",
      });
    }

const gate = await db.canRequestEnrollmentCode(email);
    if (!gate.allowed) {
      res.set("Retry-After", String(gate.retryAfterSec));
      const msg =
        gate.reason === "hourly_limit"
          ? "Too many code requests for this email. Please try again later."
          : `Please wait ${gate.retryAfterSec}s before requesting another code.`;
      return res.status(429).json({ error: msg, retry_after_sec: gate.retryAfterSec });
    }

    if (!mailer.isConfigured()) {
      return res.status(503).json({
        error: "Email sending isn't configured on this server yet. Set MAIL_USER and MAIL_APP_PASSWORD (see .env.example).",
      });
    }

const { code, record } = await db.createEnrollmentCode({
  email,
      department: department || invitation.department,
      employee_id: emp_id || invitation.employee_id,
    });

    try {
      await mailer.sendEnrollmentCodeEmail({
        to: String(email).trim(),
        name: name || invitation.name,
        code,
        expiresMinutes: Math.round((new Date(record.expires_at) - new Date(record.created_at)) / 60000),
      });
    } catch (mailErr) {
      console.error("[eduvault] Failed to send enrollment email:", mailErr.message);
      return res.status(502).json({ error: "Could not send the email right now. Please try again in a minute." });
    }

    res.json({
      sent: true,
      message: `Enrollment code sent to ${String(email).trim()}. Check your Gmail inbox.`,
      expires_in_minutes: Math.round((new Date(record.expires_at) - new Date(record.created_at)) / 60000),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Enrollment Code: verify
// ---------------------------------------------------------------------------
// Checks existence / ownership (by email) / expiry / single-use, invalidates
// the code immediately on success, and returns a short-lived
// enrollment_token bound to that exact email. /register below refuses to
// create an account without a valid token for the same email -- so this
// check cannot be skipped by calling /register directly.
router.post("/enrollment/verify", enrollmentVerifyLimiter, (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: "Email and enrollment code are required." });
  }
  const result = db.verifyEnrollmentCode(email, code);
  if (!result.ok) {
    if (result.reason === "expired") {
      return res.status(410).json({ error: "This enrollment code has expired. Please request a new code." });
    }
    if (result.reason === "locked") {
      return res.status(429).json({ error: "Too many incorrect attempts. Please request a new code." });
    }
    return res.status(400).json({ error: "Invalid enrollment code. Please check the code sent to your email." });
  }

  const enrollment_token = issueEnrollmentToken({ email });
  res.json({ verified: true, message: "Enrollment verified successfully.", enrollment_token });
});

// Register a new teacher. Requires a valid enrollment_token proving the
// submitted email just passed Enrollment Code verification -- Employee ID +
// registration details alone are NOT sufficient (see security notes below).
router.post("/register", registerLimiter, (req, res) => {
  try {
    const { emp_id, name, department, subjects_handled, email, password, enrollment_token } = req.body;

    if (!emp_id || !name || !department || !email || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    // SECURITY: this is the server-side enforcement point. A stolen/guessed
    // Employee ID is not enough to create an account -- the request must
    // also carry proof (enrollment_token) that the *submitted email* just
    // completed Enrollment Code verification. This can't be bypassed by
    // calling this endpoint directly: the token is signed server-side
    // (lib/auth.js) and checked against this exact email.
    const enrollmentPayload = verifyEnrollmentToken(enrollment_token, email);
    if (!enrollmentPayload) {
      return res.status(403).json({
        error: "Please verify your Enrollment Code for this email before completing registration.",
      });
    }

    // Check whether this ID card is already registered as either a student
    // or a teacher.
    const existing = db.isIdCardAlreadyRegistered(emp_id);
    if (existing.exists) {
      return res.status(409).json({
        error: `This ID card is already registered as a ${existing.role}.`,
      });
    }

    const teacher = db.createTeacher({
      emp_id: String(emp_id).trim(),
      name,
      department,
      subjects_handled,
      email,
      password,
      email_verified: true,
    });

    // Mark the admin invitation as used for this email
    db.markInvitationUsed(email);

    // Registering proves ownership of the password just as much as logging
    // in does, so this device can be trusted for card-login right away.
    if (req.body.device_token) {
      db.trustDevice("teacher", teacher.emp_id, req.body.device_token);
    }

    const token = issueToken({ sub: teacher.emp_id, role: teacher.role });
    res.status(201).json({ teacher, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { emp_id, password } = req.body;
    if (!emp_id || !password) {
      return res.status(400).json({ error: "Employee ID and password are required." });
    }
const teacher = await db.authenticateTeacher(emp_id, password);
    // A correct password proves this browser/device belongs to the
    // account holder, so it's safe to trust for future card-login scans.
    if (req.body.device_token) {
      db.trustDevice("teacher", teacher.emp_id, req.body.device_token);
    }

    const token = issueToken({ sub: teacher.emp_id, role: teacher.role });
    res.json({ teacher, token });
  } catch (err) {
    res.status(err.code === "ACCOUNT_INACTIVE" ? 403 : 401).json({ error: err.message });
  }
});

// Login by scanning an ID card. The barcode on the card encodes the
// Employee ID itself -- and that ID alone is NOT treated as proof of
// identity, since it's printed on the card and often guessable/predictable
// (e.g. EMP1042). A scan only skips the password on a device this teacher
// has already logged into with their password (see db.js device trust).
// If the ID isn't registered yet, the frontend routes to registration with
// the scanned Employee ID pre-filled. If it IS registered but this device
// isn't trusted yet, the frontend falls back to the password form with the
// Employee ID pre-filled.
router.post("/card-login", cardLoginLimiter, async (req, res) => {
  const { emp_id, device_token } = req.body;
  if (!emp_id) return res.status(400).json({ error: "No Employee ID was scanned." });
  try {
const teacher = await db.authenticateTeacherByCard(
  String(emp_id).trim(),
  device_token
);
    const token = issueToken({ sub: teacher.emp_id, role: teacher.role });
    res.json({ teacher, token });
  } catch (err) {
    if (err.code === "DEVICE_NOT_TRUSTED") {
      return res.status(401).json({
        error: err.message,
        needs_password: true,
        emp_id: String(emp_id).trim(),
      });
    }
    if (err.code === "ACCOUNT_INACTIVE") {
      return res.status(403).json({ error: err.message });
    }
    res.status(404).json({ error: err.message, new_card: true, emp_id: String(emp_id).trim() });
  }
});

// Public: list/search teachers (needed for the student search typeahead).
// This intentionally requires no login -- looking a teacher up by Employee
// ID or name is the core feature -- but it is rate-limited to slow scraping.
router.get("/", searchLimiter, (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  let teachers = db.listTeachers();
  if (q) {
    teachers = teachers.filter(
      (t) => t.emp_id.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)
    );
  }
  res.json({ teachers });
});

// Public: single teacher lookup (used for the bookmark chips / result header)
router.get("/:emp_id", searchLimiter, (req, res) => {
  const teacher = db.sanitizeTeacher(db.findTeacher(req.params.emp_id));
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  res.json({ teacher });
});

// Analytics: access counts per material.
// SECURITY FIX: previously unauthenticated -- anyone could read any
// teacher's view counts. Now requires a valid teacher token whose subject
// matches the emp_id being queried.
router.get("/:emp_id/analytics", requireAuth("teacher"), (req, res) => {
  if (req.auth.sub !== req.params.emp_id) {
    return res.status(403).json({ error: "You can only view your own analytics." });
  }
  const teacher = db.findTeacher(req.params.emp_id);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const materials = db.materialsByTeacher(req.params.emp_id);
  const counts = db.accessCountsForTeacher(req.params.emp_id);
  const data = materials.map((m) => ({ ...m, access_count: counts[m.material_id] || 0 }));
  res.json({ materials: data });
});

module.exports = router;
