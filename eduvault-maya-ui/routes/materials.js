const express = require("express");
const os = require("os");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const { toSafeFilename, contentDisposition } = require("../lib/filename");
const storage = require("../lib/storage");

// Multer always writes to a scratch temp directory first, regardless of
// which storage driver is active -- lib/storage.js then moves the finished
// file into permanent storage (local uploads/ dir, or an S3-compatible
// bucket). This keeps memory usage flat for large files either way, and
// means this route file never talks to `fs` against the final storage
// location directly -- see lib/storage.js for why that matters on Render.
const TEMP_DIR = path.join(os.tmpdir(), "eduvault-uploads-tmp");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// SECURITY FIX: .html, .css and .js were removed from this list.
// Serving user-uploaded HTML/JS from the same origin as the app is a
// stored-XSS vector -- a malicious "material" could run script with access
// to every logged-in user's localStorage session tokens. server.js also now
// forces non-preview file types to download rather than render, as a second
// layer of defense, but the allow-list itself shouldn't accept them either.
const ALLOWED_EXT = [
  ".pdf",
  ".ppt",
  ".pptx",
  ".doc",
  ".docx",
  ".txt",
  ".csv",
  ".xls",
  ".xlsx",

  // Archives
  ".zip",
  ".rar",
  ".7z",

  // Images
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",

  // Audio
  ".mp3",
  ".wav",

  // Video
  ".mp4",
  ".webm",

  // Source code (plain text -- forced to download, never rendered inline)
  ".py",
  ".java",
  ".cpp",
  ".c",
];

const INLINE_SAFE_EXT = new Set([
  ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".mp3", ".wav", ".mp4", ".webm", ".txt",
]);

function extToContentType(ext) {
  const map = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".webp": "image/webp",
    ".mp3": "audio/mpeg", ".wav": "audio/wav",
    ".mp4": "video/mp4", ".webm": "video/webm",
    ".txt": "text/plain; charset=utf-8",
  };
  return map[ext] || "application/octet-stream";
}

const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TEMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage: tempStorage,
  limits: {
    fileSize: 200 * 1024 * 1024, // 200 MB
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(
        new Error(
          "Unsupported file type. Allowed: PDF, PPT/PPTX, DOC/DOCX, TXT, CSV, XLS/XLSX, ZIP, RAR, 7Z, images, audio, video and a few source-code formats."
        )
      );
    }
    cb(null, true);
  },
});

const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 20 });
const downloadLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const listLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });
const viewLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

// Teacher uploads a material.
// SECURITY: requires a valid teacher session token -- emp_id always comes
// from that token, never the request body. On top of that, the account
// behind the token must have completed Enrollment Code verification
// (email_verified) -- this is the flow's final gate: even a forged/expired
// client-side "registration complete" state can't reach this route,
// because the token itself was only ever issued to an account that already
// passed verification (see routes/teachers.js /register).
router.post("/upload", requireAuth("teacher"), uploadLimiter, (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const cleanupTemp = () => {
      if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    };
    try {
      const emp_id = req.auth.sub;
      const account = db.findTeacher(emp_id);
      if (!account || !account.email_verified) {
        cleanupTemp();
        return res.status(403).json({
          error: "Your account hasn't completed Enrollment Code verification yet, so it can't upload files.",
        });
      }

      const { subject, title, unit, semester } = req.body;
      if (!subject || !title) {
        cleanupTemp();
        return res.status(400).json({ error: "subject and title are required." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "A file is required." });
      }

      const ext = path.extname(req.file.originalname).toLowerCase();
      const storedKey = req.file.filename; // uuid + ext, chosen by multer above
      await storage.saveFromTempPath(req.file.path, storedKey, extToContentType(ext));

      const material = db.addMaterial({
        emp_id,
        subject,
        title,
        unit,
        semester,
        file_url: `/uploads/${storedKey}`, // kept for backward-compatible display; actual access always goes through /api/materials/view|download
        original_name: req.file.originalname,
      });
      res.status(201).json({ material });
    } catch (e) {
      cleanupTemp();
      res.status(400).json({ error: e.message });
    }
  });
});

// List materials for a given teacher (this is what a student sees after
// looking up a teacher by Employee ID + name -- the full permanent history,
// regardless of when the student's account was created). Intentionally
// public -- that's the core feature -- but rate-limited against scraping.
router.get("/teacher/:emp_id", listLimiter, (req, res) => {
  const teacher = db.findTeacher(req.params.emp_id);
  if (!teacher) return res.status(404).json({ error: "Teacher not found." });
  const materials = db.materialsByTeacher(req.params.emp_id);
  res.json({ teacher: db.sanitizeTeacher(teacher), materials });
});

// Inline "View" (no access-log entry -- that's what /download is for).
// Works identically regardless of storage driver, since it streams through
// lib/storage.js rather than assuming a local file path. Requires any
// logged-in teacher, student or admin -- same trust level as before
// (materials were always visible to anyone who could see the teacher's list).
router.get("/view/:material_id", requireAuth(["teacher", "student", "admin"]), viewLimiter, async (req, res) => {
  const material = db.findMaterial(req.params.material_id);
  if (!material) return res.status(404).json({ error: "Material not found." });

  const ext = path.extname(material.original_name || material.file_url).toLowerCase();
  const niceName = toSafeFilename(material.title, ext);
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Type", extToContentType(ext));
  res.set(
    "Content-Disposition",
    contentDisposition(INLINE_SAFE_EXT.has(ext) ? "inline" : "attachment", niceName)
  );

  try {
    await storage.streamTo(res, path.basename(material.file_url));
  } catch (e) {
    if (!res.headersSent) res.status(404).json({ error: "File missing from storage." });
  }
});

// Download a material.
// SECURITY FIX: previously logged whatever roll_no was passed as a query
// param, with no verification -- access logs could be forged, and anyone
// (no account at all) could hit this endpoint directly. Now requires a
// valid student token (sent as ?token= since this is a plain <a href>
// link that can't set an Authorization header) and logs the *verified*
// roll_no from that token, not a client-supplied one.
router.get("/download/:material_id", requireAuth("student"), downloadLimiter, async (req, res) => {
  const material = db.findMaterial(req.params.material_id);
  if (!material) return res.status(404).json({ error: "Material not found." });

  db.logAccess({ roll_no: req.auth.sub, material_id: material.material_id });

  const ext = path.extname(material.original_name || material.file_url).toLowerCase();
  const downloadName = toSafeFilename(material.title, ext);
  res.set("Content-Disposition", contentDisposition("attachment", downloadName));
  res.set("Content-Type", extToContentType(ext));

  try {
    await storage.streamTo(res, path.basename(material.file_url));
  } catch (e) {
    if (!res.headersSent) res.status(404).json({ error: "File missing on server." });
  }
});

// Delete a material.
// SECURITY FIX: previously took emp_id straight from the request body, so
// anyone who knew a teacher's Employee ID could delete that teacher's
// files. Now requires a valid teacher token, and emp_id always comes from
// that token.
router.delete("/:material_id", requireAuth("teacher"), async (req, res) => {
  try {
    const emp_id = req.auth.sub;
    const removed = db.deleteMaterial(req.params.material_id, emp_id);
    await storage.deleteFile(path.basename(removed.file_url));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
