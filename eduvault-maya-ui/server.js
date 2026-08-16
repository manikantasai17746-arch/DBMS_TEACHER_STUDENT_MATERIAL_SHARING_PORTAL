const express = require("express");
const path = require("path");
const fs = require("fs");

// Minimal, dependency-free .env loader. Only applies keys that aren't
// already set in the environment, and only if a .env file exists -- this
// must run before requiring ./routes (and therefore ./lib/auth, which reads
// process.env.SESSION_SECRET as soon as it's loaded).
(function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  try {
    fs.readFileSync(envPath, "utf-8")
      .split("\n")
      .forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;
        const idx = trimmed.indexOf("=");
        if (idx === -1) return;
        const key = trimmed.slice(0, idx).trim();
        let value = trimmed.slice(idx + 1).trim();
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }
        if (!(key in process.env)) process.env[key] = value;
      });
  } catch (e) {
    console.warn("[eduvault] Could not read .env file:", e.message);
  }
})();

const teacherRoutes = require("./routes/teachers");
const studentRoutes = require("./routes/students");
const materialRoutes = require("./routes/materials");
const adminRoutes = require("./routes/admin");
const db = require("./db");
const storage = require("./lib/storage");

// Preconfigured system administrator (mani@1774admin / mani@1774 by
// default, overridable with ADMIN_EMP_ID / ADMIN_PASSWORD env vars -- see
// .env.example). Created once, idempotently, on every boot -- it never goes
// through the public Enrollment Code registration flow.
db.ensureSeedAdmin().catch((err) => {
  console.error("[eduvault] Failed to ensure seed admin:", err);
});
const app = express();
const PORT = process.env.PORT || 3000; // Render sets $PORT -- always read it, never hard-code a port

app.disable("x-powered-by");

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Basic security headers on every response.
app.use((req, res, next) => {
  res.set("X-Content-Type-Options", "nosniff");
  res.set("X-Frame-Options", "DENY");
  res.set("Referrer-Policy", "no-referrer-when-downgrade");
  next();
});

// Static frontend
app.use(express.static(path.join(__dirname, "public")));

// Uploaded files.
// SECURITY FIX: only file types that are safe to preview (PDFs, images,
// audio/video, plain text) are ever served inline. Everything else --
// Office docs, archives, and any file type that might slip past the
// upload allow-list in the future -- is forced to download via
// Content-Disposition: attachment, so it can never execute as script in
// the app's own origin even if it somehow contains HTML/JS.
//
// This static route is ONLY mounted when STORAGE_DRIVER=local (the
// default) -- with STORAGE_DRIVER=s3, files don't live on local disk at
// all, so every "View"/"Download" link goes through the storage-aware
// proxy routes in routes/materials.js (/api/materials/view/:id and
// /download/:id) instead. Those two routes work under either driver.
const INLINE_SAFE_EXT = new Set([
  ".pdf", ".jpg", ".jpeg", ".png", ".gif", ".webp",
  ".mp3", ".wav", ".mp4", ".webm", ".txt",
]);

const { contentDisposition: cd } = require("./lib/filename");

if (storage.driver === "local") {
  // Note: setHeaders is synchronous, so we cannot await a DB lookup here.
  // View/download API routes already set a proper Content-Disposition with
  // the human-readable title. The static path uses the stored filename.
  app.use(
    "/uploads",
    express.static(storage.localUploadDir, {
      setHeaders: (res, filePath) => {
        res.set("X-Content-Type-Options", "nosniff");
        const ext = path.extname(filePath).toLowerCase();
        const niceName = path.basename(filePath);
        if (!INLINE_SAFE_EXT.has(ext)) {
          res.set("Content-Disposition", cd("attachment", niceName));
        } else {
          res.set("Content-Disposition", cd("inline", niceName));
        }
      },
    })
  );
}

// API routes
app.use("/api/teachers", teacherRoutes);
app.use("/api/students", studentRoutes);
app.use("/api/materials", materialRoutes);
app.use("/api/admin", adminRoutes);

app.get("/api/health", (req, res) => res.json({ status: "ok", service: "EduVault" }));

// Fallback 404 for unknown API routes
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));

// Safe production error handler: never leak stack traces / internals to the
// client, but still log the full error server-side for debugging on Render.
app.use((err, req, res, next) => {
  console.error("[eduvault] Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong on our end. Please try again." });
});

// Vercel (and similar serverless hosts) import this file and handle the
// request lifecycle themselves. Only bind a port when running as a
// traditional long-lived Node process (local / Render / Railway / etc.).
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`EduVault server running on port ${PORT}`);
    console.log(`Storage driver: ${storage.driver}`);
    console.log(
      `Email sending: ${
        require("./lib/mailer").isConfigured()
          ? "configured"
          : "NOT configured (set MAIL_USER / MAIL_APP_PASSWORD)"
      }`
    );
  });
}

module.exports = app;
