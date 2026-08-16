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
router.get("/invitations", async (req, res) => {
  try {
    const invitations = await db.listInvitations();
    res.json({ invitations });
  } catch (err) {
    console.error("[eduvault] Failed to list invitations:", err);
    res.status(500).json({ error: "Could not load invitations." });
  }
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

const invitation = await db.createInvitation({      email,
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

router.post("/invitations/:id/revoke", adminActionLimiter, async (req, res) => {
  try {
    const invitation = await db.revokeInvitation(req.params.id);
    res.json({ invitation });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Keep enrollment-codes list for issued codes
router.get("/enrollment-codes", async (req, res) => {
  try {
    const codes = await db.listEnrollmentCodes();
    res.json({ codes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/enrollment-codes/:id/revoke", adminActionLimiter, async (req, res) => {
  try {
    const code = await db.revokeEnrollmentCode(req.params.id);
    res.json({ code });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Employees (teachers) ---------------------------------------------
router.get("/teachers", async (req, res) => {
  try {
    const teachers = await db.listAllTeachers();
    res.json({ teachers });
  } catch (err) {
    console.error("[eduvault] Failed to list teachers:", err);
    res.status(500).json({ error: "Could not load teachers." });
  }
});

router.patch("/teachers/:emp_id/active", adminActionLimiter, async (req, res) => {
  try {
    const teacher = await db.setTeacherActive(req.params.emp_id, req.body.active);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch("/teachers/:emp_id/role", adminActionLimiter, async (req, res) => {
  try {
    const teacher = await db.setTeacherRole(req.params.emp_id, req.body.role);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/teachers/:emp_id", adminActionLimiter, async (req, res) => {
  try {
    const teacher = await db.deleteTeacher(req.params.emp_id);
    res.json({ teacher });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Students ---------------------------------------------------------
router.get("/students", async (req, res) => {
  try {
    const students = await db.listAllStudents();
    res.json({ students });
  } catch (err) {
    console.error("[eduvault] Failed to list students:", err);
    res.status(500).json({ error: "Could not load students." });
  }
});

router.patch("/students/:roll_no/active", adminActionLimiter, async (req, res) => {
  try {
    const student = await db.setStudentActive(req.params.roll_no, req.body.active);
    res.json({ student });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/students/:roll_no", adminActionLimiter, async (req, res) => {
  try {
    const student = await db.deleteStudent(req.params.roll_no);
    res.json({ student });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
