// ---------------------------------------------------------------------------
// Turns a teacher's free-text "Title" into a safe download filename, so
// students see e.g. "Normal Forms — Slides.pdf" instead of the random UUID
// the file is actually stored under on disk (uploads/<uuid>.pdf).
// Shared by routes/materials.js (the dedicated download endpoint) and
// server.js (the raw /uploads/... static route, used by "View" links).
// ---------------------------------------------------------------------------

function toSafeFilename(title, fallbackExt) {
  const cleaned = String(title || "")
    .replace(/[\\/:*?"<>|]/g, "") // characters invalid in Windows/most filesystems
    .replace(/\s+/g, " ")
    .trim();
  const base = cleaned || "material";
  return `${base}${fallbackExt}`;
}

// Builds a Content-Disposition header value that works for both old
// (ASCII filename=) and modern (UTF-8 filename*=) clients.
function contentDisposition(disposition, filename) {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  const encoded = encodeURIComponent(filename);
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

module.exports = { toSafeFilename, contentDisposition };
