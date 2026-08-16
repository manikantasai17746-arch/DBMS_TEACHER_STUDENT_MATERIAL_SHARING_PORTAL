const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const mailer = require("../lib/mailer");

router.use(requireAuth("admin"));

const adminActionLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Invitations (no code yet) -----------------------------------------
router.get("/invitations", (req, res) => {
  res.json({ invitations: db.listInvitations() });
});

// Admin enters one email → send invitation only (code is sent later by employee)
router.post("/invitations", adminActionLimiter, async (req, res) => {
  try {
    const { email, department, emp_id, name } = req.body;
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!mailer.isConfigured()) {
      return res.status(503).json({
        error: "Email isn't configured on this server (MAIL_USER / MAIL_APP_PASSWORD).",
      });
    }

    const invitation = db.createInvitation({
      email,
      department,
      employee_id: emp_id,
      name,
    });

    const registerUrl =
      process.env.PUBLIC_REGISTER_URL ||
      `${req.protocol}://${req.get("host")}/teacher-register.html`;

    try {
      await mailer.sendInvitationEmail({
        to: String(email).trim(),
        name,
        registerUrl,
      });
    } catch (mailErr) {
      console.error("[eduvault] Failed to send invitation email:", mailErr.message);
      return res.status(502).json({
        error: "Could not send the invitation email right now. Please try again.",
      });
    }

    res.status(201).json({
      sent: true,
      message: `Invitation sent to ${String(email).trim()}. The employee must open the registration page and click "Send verification code" to receive the code.`,
      invitation,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/invitations/:id/revoke", adminActionLimiter, (req, res) => {
  try {
    const invitation = db.revokeInvitation(req.params.id);
    res.json({ invitation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Keep enrollment-codes list for issued codes
router.get("/enrollment-codes", (req, res) => {
  res.json({ codes: db.listEnrollmentCodes() });
});

router.post("/enrollment-codes/:id/revoke", adminActionLimiter, (req, res) => {
  try {
    const code = db.revokeEnrollmentCode(req.params.id);
    res.json({ code });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Employees (teachers) ---------------------------------------------
router.get("/teachers", (req, res) => {
  res.json({ teachers: db.listAllTeachers() });
});

router.patch("/teachers/:emp_id/active", adminActionLimiter, (req, res) => {
  try {
    const teacher = db.setTeacherActive(req.params.emp_id, req.body.active);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/teachers/:emp_id/role", adminActionLimiter, (req, res) => {
  try {
    const teacher = db.setTeacherRole(req.params.emp_id, req.body.role);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/teachers/:emp_id", adminActionLimiter, (req, res) => {
  try {
    const teacher = db.deleteTeacher(req.params.emp_id);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Students ---------------------------------------------------------
router.get("/students", (req, res) => {
  res.json({ students: db.listAllStudents() });
});

router.patch("/students/:roll_no/active", adminActionLimiter, (req, res) => {
  try {
    const student = db.setStudentActive(req.params.roll_no, req.body.active);
    res.json({ student });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/students/:roll_no", adminActionLimiter, (req, res) => {
  try {
    const student = db.deleteStudent(req.params.roll_no);
    res.json({ student });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
