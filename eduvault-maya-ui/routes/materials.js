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

async function withDbRetry(fn, label) {
  let last;
  for (let i = 1; i <= 3; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message ? e.message : e);
      if (
        i < 3 &&
        /ssl|tls|ECONNRESET|timeout|EPROTO|handshake|Connection terminated|too many clients/i.test(
          msg
        )
      ) {
        console.warn(`[eduvault] ${label} retry ${i}/3:`, msg.slice(0, 160));
        await new Promise((r) => setTimeout(r, 300 * i));
        continue;
      }
      throw e;
    }
  }
  throw last;
}


// ---------------------------------------------------------------------------
// TEMP UPLOAD DIRECTORY
// ---------------------------------------------------------------------------

const TEMP_DIR = path.join(os.tmpdir(), "eduvault-uploads-tmp");

if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// ALLOWED FILE TYPES
// ---------------------------------------------------------------------------

const ALLOWED_EXT = [
  // Documents
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

  // Source code
  ".py",
  ".java",
  ".cpp",
  ".c",
];

// ---------------------------------------------------------------------------
// FILE TYPES THAT MAY BE DISPLAYED INLINE
// ---------------------------------------------------------------------------

const INLINE_SAFE_EXT = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".mp3",
  ".wav",
  ".mp4",
  ".webm",
  ".txt",
]);

// ---------------------------------------------------------------------------
// CONTENT TYPE
// ---------------------------------------------------------------------------

function extToContentType(ext) {
  const map = {
    ".pdf": "application/pdf",

    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",

    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",

    ".mp4": "video/mp4",
    ".webm": "video/webm",

    ".txt": "text/plain; charset=utf-8",
  };

  return map[ext] || "application/octet-stream";
}

// ---------------------------------------------------------------------------
// MULTER TEMP STORAGE
// ---------------------------------------------------------------------------

const tempStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, TEMP_DIR);
  },

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

// ---------------------------------------------------------------------------
// MULTER UPLOAD CONFIGURATION
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// RATE LIMITERS
// ---------------------------------------------------------------------------

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
});

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

const listLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

const viewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
});

// ---------------------------------------------------------------------------
// TEACHER UPLOAD
// ---------------------------------------------------------------------------

router.post(
  "/upload",
  requireAuth("teacher"),
  uploadLimiter,
  (req, res) => {
    upload.single("file")(req, res, async (err) => {
      // Multer error
      if (err) {
        return res.status(400).json({
          error: err.message,
        });
      }

      // Remove temporary file if something fails
      const cleanupTemp = () => {
        if (req.file) {
          fs.promises
            .unlink(req.file.path)
            .catch(() => {});
        }
      };

      try {
        // ---------------------------------------------------------------
        // GET EMPLOYEE ID FROM AUTH TOKEN
        // ---------------------------------------------------------------

        const emp_id = req.auth.sub;

        // IMPORTANT:
        // findTeacher() is async in db.js
        const account = await withDbRetry(
          () => db.findTeacher(emp_id),
          "findTeacher"
        );

        if (!account || !account.email_verified) {
          cleanupTemp();

          return res.status(403).json({
            error:
              "Your account hasn't completed Enrollment Code verification yet, so it can't upload files.",
          });
        }

        // ---------------------------------------------------------------
        // FORM DATA
        // ---------------------------------------------------------------

        const {
          subject,
          title,
          unit,
          semester,
        } = req.body;

        if (!subject || !title) {
          cleanupTemp();

          return res.status(400).json({
            error: "subject and title are required.",
          });
        }

        if (!req.file) {
          return res.status(400).json({
            error: "A file is required.",
          });
        }

        // ---------------------------------------------------------------
        // FILE INFORMATION
        // ---------------------------------------------------------------

        const ext = path
          .extname(req.file.originalname)
          .toLowerCase();

        const storedKey = req.file.filename;

        // ---------------------------------------------------------------
        // SAVE FILE TO PERMANENT STORAGE
        // ---------------------------------------------------------------

        await storage.saveFromTempPath(
          req.file.path,
          storedKey,
          extToContentType(ext)
        );

        // ---------------------------------------------------------------
        // SAVE MATERIAL RECORD TO POSTGRESQL
        // ---------------------------------------------------------------

        // IMPORTANT:
        // addMaterial() is async in db.js
        const material = await withDbRetry(
          () =>
            db.addMaterial({
              emp_id,
              subject,
              title,
              unit,
              semester,
              file_url: `/uploads/${storedKey}`,
              original_name: req.file.originalname,
            }),
          "addMaterial"
        );

        // Temporary file has already been moved to permanent storage.
        // Prevent cleanup from deleting the permanent file.

        req.file = null;

        // ---------------------------------------------------------------
        // RETURN SUCCESS
        // ---------------------------------------------------------------

        return res.status(201).json({
          material,
        });
      } catch (e) {
        console.error(
          "[eduvault] Material upload failed:",
          e
        );

        cleanupTemp();

        // Never leak low-level SSL / connection internals to the browser.
        const msg = String(e && e.message ? e.message : e);
        const isInfra =
          /ssl|tls|econnrefused|enotfound|timeout|handshake|EPROTO|self-signed/i.test(
            msg
          );
        return res.status(isInfra ? 503 : 400).json({
          error: isInfra
            ? "Database connection failed. Check DATABASE_URL (use Supabase Transaction pooler, port 6543) and SSL settings."
            : msg,
        });
      }
    });
  }
);

// ---------------------------------------------------------------------------
// LIST MATERIALS FOR A TEACHER
// ---------------------------------------------------------------------------
//
// This is the important fix.
//
// db.findTeacher() and db.materialsByTeacher() are async PostgreSQL
// functions, so they MUST be awaited.
// ---------------------------------------------------------------------------

router.get(
  "/teacher/:emp_id",
  listLimiter,
  async (req, res) => {
    try {
      const emp_id = req.params.emp_id;

      // IMPORTANT: await
      const teacher = await db.findTeacher(emp_id);

      if (!teacher) {
        return res.status(404).json({
          error: "Teacher not found.",
        });
      }

      // IMPORTANT: await
      const materials = await db.materialsByTeacher(emp_id);

      console.log(
        `[eduvault] Loaded ${materials.length} materials for teacher ${emp_id}`
      );

      return res.json({
        teacher: db.sanitizeTeacher(teacher),
        materials,
      });
    } catch (err) {
      console.error(
        "[eduvault] Failed to load teacher materials:",
        err
      );

      return res.status(500).json({
        error: "Could not load teacher materials.",
      });
    }
  }
);

// ---------------------------------------------------------------------------
// VIEW MATERIAL INLINE
// ---------------------------------------------------------------------------

router.get(
  "/view/:material_id",
  requireAuth(["teacher", "student", "admin"]),
  viewLimiter,
  async (req, res) => {
    try {
      // IMPORTANT: await
      const material = await db.findMaterial(
        req.params.material_id
      );

      if (!material) {
        return res.status(404).json({
          error: "Material not found.",
        });
      }

      const ext = path
        .extname(
          material.original_name ||
            material.file_url
        )
        .toLowerCase();

      const niceName = toSafeFilename(
        material.title,
        ext
      );

      res.set(
        "X-Content-Type-Options",
        "nosniff"
      );

      res.set(
        "Content-Type",
        extToContentType(ext)
      );

      res.set(
        "Content-Disposition",
        contentDisposition(
          INLINE_SAFE_EXT.has(ext)
            ? "inline"
            : "attachment",
          niceName
        )
      );

      await storage.streamTo(
        res,
        path.basename(material.file_url)
      );
    } catch (e) {
      console.error(
        "[eduvault] Failed to view material:",
        e
      );

      if (!res.headersSent) {
        return res.status(404).json({
          error: "File missing from storage.",
        });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// DOWNLOAD MATERIAL
// ---------------------------------------------------------------------------

router.get(
  "/download/:material_id",
  requireAuth("student"),
  downloadLimiter,
  async (req, res) => {
    try {
      // IMPORTANT: await
      const material = await db.findMaterial(
        req.params.material_id
      );

      if (!material) {
        return res.status(404).json({
          error: "Material not found.",
        });
      }

      // ---------------------------------------------------------------
      // LOG ACCESS USING VERIFIED STUDENT ID
      // ---------------------------------------------------------------

      // IMPORTANT: logAccess() is async
      await db.logAccess({
        roll_no: req.auth.sub,
        material_id: material.material_id,
      });

      const ext = path
        .extname(
          material.original_name ||
            material.file_url
        )
        .toLowerCase();

      const downloadName = toSafeFilename(
        material.title,
        ext
      );

      res.set(
        "Content-Disposition",
        contentDisposition(
          "attachment",
          downloadName
        )
      );

      res.set(
        "Content-Type",
        extToContentType(ext)
      );

      await storage.streamTo(
        res,
        path.basename(material.file_url)
      );
    } catch (e) {
      console.error(
        "[eduvault] Failed to download material:",
        e
      );

      if (!res.headersSent) {
        return res.status(404).json({
          error: "File missing on server.",
        });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// DELETE MATERIAL
// ---------------------------------------------------------------------------
//
// Teacher can delete only their own material.
// Employee ID comes from authentication token.
// ---------------------------------------------------------------------------

router.delete(
  "/:material_id",
  requireAuth("teacher"),
  async (req, res) => {
    try {
      const emp_id = req.auth.sub;

      // IMPORTANT: deleteMaterial() is async
      const removed = await db.deleteMaterial(
        req.params.material_id,
        emp_id
      );

      // Delete physical file from storage
      await storage.deleteFile(
        path.basename(removed.file_url)
      );

      return res.json({
        success: true,
      });
    } catch (err) {
      console.error(
        "[eduvault] Failed to delete material:",
        err
      );

      return res.status(400).json({
        error: err.message,
      });
    }
  }
);

// ---------------------------------------------------------------------------
// EXPORT ROUTER
// ---------------------------------------------------------------------------

module.exports = router;
