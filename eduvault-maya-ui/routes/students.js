const express = require("express");
const router = express.Router();
const db = require("../db");
const { issueToken, requireAuth } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15 });
const cardLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

// Register a new student
router.post("/register", registerLimiter, async (req, res) => {
  try {
    const { roll_no, name, department, semester, email, password } = req.body;

    if (!roll_no || !name || !department || !semester || !email || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }

    // Check whether this ID card is already registered as either a student
    // or a teacher.
    const existing = await db.isIdCardAlreadyRegistered(roll_no);
    if (existing.exists) {
      return res.status(409).json({
        error: `This ID card is already registered as a ${existing.role}.`,
      });
    }

    const student = await db.createStudent({
      roll_no: String(roll_no).trim(),
      name,
      department,
      semester,
      email,
      password,
    });

    // Registering proves ownership of the password just as much as logging
    // in does, so this device can be trusted for card-login right away.
    // Device trust is best-effort — never fail registration if it errors.
    if (req.body.device_token) {
      try {
        await db.trustDevice("student", student.roll_no, req.body.device_token);
      } catch (trustErr) {
        console.warn("[eduvault] trustDevice after student register:", trustErr.message);
      }
    }

    const token = issueToken({ sub: student.roll_no, role: "student" });
    res.status(201).json({ student, token });
  } catch (err) {
    console.error("[eduvault] student register failed:", err);
    res.status(400).json({ error: err.message });
  }
});

// Login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const { roll_no, password } = req.body;
    if (!roll_no || !password) {
      return res.status(400).json({ error: "Roll Number and password are required." });
    }
    const student = await db.authenticateStudent(roll_no, password);

    // A correct password proves this browser/device belongs to the
    // account holder, so it's safe to trust for future card-login scans.
    if (req.body.device_token) {
      await db.trustDevice("student", student.roll_no, req.body.device_token);
    }

    const token = issueToken({ sub: student.roll_no, role: "student" });
    res.json({ student, token });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

// Login by scanning an ID card. The barcode encodes the Roll Number itself
// -- and that number alone is NOT treated as proof of identity, since it's
// printed on the card and often guessable/predictable (e.g. 22CS1042). A
// scan only skips the password on a device this student has already logged
// into with their password (see db.js device trust). If the roll number
// isn't registered yet, the frontend routes to registration with it
// pre-filled. If it IS registered but this device isn't trusted yet, the
// frontend falls back to the password form with the Roll Number pre-filled.
router.post("/card-login", cardLoginLimiter, async (req, res) => {
  const { roll_no, device_token } = req.body;
  if (!roll_no) return res.status(400).json({ error: "No Roll Number was scanned." });
  try {
    const student = await db.authenticateStudentByCard(
      String(roll_no).trim(),
      device_token
    );
    const token = issueToken({ sub: student.roll_no, role: "student" });
    res.json({ student, token });
  } catch (err) {
    if (err.code === "DEVICE_NOT_TRUSTED") {
      return res.status(401).json({
        error: err.message,
        needs_password: true,
        roll_no: String(roll_no).trim(),
      });
    }
    res.status(404).json({
      error: err.message,
      new_card: true,
      roll_no: String(roll_no).trim(),
    });
  }
});

// Toggle bookmark on a teacher.
// SECURITY FIX: previously unauthenticated -- anyone could edit any
// student's bookmark list just by putting their roll_no in the URL. Now
// requires a valid student token whose subject matches the URL's roll_no.
router.post("/:roll_no/bookmark", requireAuth("student"), async (req, res) => {
  try {
    if (req.auth.sub !== req.params.roll_no) {
      return res.status(403).json({ error: "You can only edit your own bookmarks." });
    }
    const { emp_id } = req.body;
    if (!emp_id) return res.status(400).json({ error: "emp_id is required." });
    const bookmarks = await db.toggleBookmark(req.params.roll_no, emp_id);
    res.json({ bookmarked_teachers: bookmarks });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
