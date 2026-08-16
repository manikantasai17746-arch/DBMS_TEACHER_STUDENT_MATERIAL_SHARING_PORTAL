// Shared helpers used across every page.
//
// Auth: the server issues a signed session token on register/login/
// card-login. It's stored in localStorage alongside the profile and sent
// automatically as an Authorization: Bearer header on every API call. The
// server is the source of truth for who you are -- emp_id/roll_no fields in
// request bodies are no longer trusted on their own for any action that
// changes data (upload, delete, bookmark, download-logging).
//
// Storing the token in localStorage (rather than an httpOnly cookie) is a
// simplification appropriate for a college demo project -- it's readable by
// any script running on the page, which is why the uploads folder no longer
// serves HTML/JS/CSS inline (see server.js). A production version would
// move to httpOnly, secure, SameSite cookies -- listed under Future Scope.

function toast(msg, isError) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = isError ? "err show" : "show";
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}

async function api(path, options = {}) {
  const opts = { ...options };
  opts.headers = { ...(options.headers || {}) };

  const token = getTeacherToken() || getStudentToken();
  if (token) opts.headers["Authorization"] = "Bearer " + token;

  if (opts.body && !(opts.body instanceof FormData)) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch("/api" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong.");
    // Carry over any extra fields the API sent alongside the error (e.g.
    // needs_password, new_card) so callers can branch on them, not just
    // show the message.
    Object.assign(err, data);
    throw err;
  }
  return data;
}

// A random, unguessable ID for THIS browser, used to prove "this is the
// same device that already logged in with a password" so a card scan can
// skip the password next time -- without making the roll number/emp ID
// printed on the card itself a substitute for a password. Persists in
// localStorage until the user clears site data.
function getDeviceToken() {
  let token = localStorage.getItem("eduvault_device_token");
  if (!token) {
    token = (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    localStorage.setItem("eduvault_device_token", token);
  }
  return token;
}

// Same auth/error handling as api(), but over XMLHttpRequest instead of
// fetch -- fetch has no reliable cross-browser upload progress event, XHR
// does (xhr.upload.onprogress), which is what powers the progress bar on
// the upload form. Speed itself is still bounded by the network and disk,
// same as any upload; this just makes that progress visible instead of a
// button that looks frozen for large files.
function apiUpload(path, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api" + path);

    const token = getTeacherToken() || getStudentToken();
    if (token) xhr.setRequestHeader("Authorization", "Bearer " + token);

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress({ loaded: e.loaded, total: e.total, percent: (e.loaded / e.total) * 100 });
        }
      };
    }

    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        const err = new Error(data.error || "Something went wrong.");
        Object.assign(err, data);
        reject(err);
      }
    };

    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));

    xhr.send(formData);
  });
}

function saveTeacher(teacher, token) {
  localStorage.setItem("eduvault_teacher", JSON.stringify(teacher));
  if (token) localStorage.setItem("eduvault_teacher_token", token);
}
function getTeacher() {
  try { return JSON.parse(localStorage.getItem("eduvault_teacher")); } catch { return null; }
}
function getTeacherToken() {
  return localStorage.getItem("eduvault_teacher_token");
}
function clearTeacher() {
  localStorage.removeItem("eduvault_teacher");
  localStorage.removeItem("eduvault_teacher_token");
}

function saveStudent(student, token) {
  localStorage.setItem("eduvault_student", JSON.stringify(student));
  if (token) localStorage.setItem("eduvault_student_token", token);
}
function getStudent() {
  try { return JSON.parse(localStorage.getItem("eduvault_student")); } catch { return null; }
}
function getStudentToken() {
  return localStorage.getItem("eduvault_student_token");
}
function clearStudent() {
  localStorage.removeItem("eduvault_student");
  localStorage.removeItem("eduvault_student_token");
}

function requireTeacher() {
  const t = getTeacher();
  if (!t || !getTeacherToken()) {
    window.location.href = "/teacher-login.html";
    return null;
  }
  return t;
}
function requireStudent() {
  const s = getStudent();
  if (!s || !getStudentToken()) {
    window.location.href = "/student-login.html";
    return null;
  }
  return s;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let val = bytes;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function fileIcon(name) {
  const ext = (name || "").split(".").pop().toLowerCase();
  if (["ppt", "pptx"].includes(ext)) return "PPT";
  if (ext === "pdf") return "PDF";
  if (["doc", "docx"].includes(ext)) return "DOC";
  if (["jpg", "jpeg", "png"].includes(ext)) return "IMG";
  return "FILE";
}

/* ---------- Subtle mouse-follow decoration (university-style) ----------
   Only elements with class "deco-interactive" inside a .deco-layer /
   .auth-deco move. Movement is limited so it stays elegant, not chaotic.
*/
(function initDecoParallax() {
  function setup() {
    const layers = document.querySelectorAll(".deco-layer, .auth-deco");
    if (!layers.length) return;

    layers.forEach((layer) => {
      const items = layer.querySelectorAll(".deco-interactive");
      if (!items.length) return;

      // Strength per element (data-depth or default)
      items.forEach((el, i) => {
        if (!el.dataset.depth) {
          // alternate depths for a layered feel
          el.dataset.depth = (0.018 + (i % 4) * 0.012).toFixed(3);
        }
      });

      let raf = null;
      let targetX = 0, targetY = 0;
      let currentX = 0, currentY = 0;

      function onMove(e) {
        const rect = layer.getBoundingClientRect();
        // only react when pointer is roughly over this layer area
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        targetX = (e.clientX - cx) / rect.width;   // -0.5 … 0.5-ish
        targetY = (e.clientY - cy) / rect.height;
        layer.classList.add("is-tracking");
        if (!raf) raf = requestAnimationFrame(tick);
      }

      function onLeave() {
        targetX = 0;
        targetY = 0;
        layer.classList.remove("is-tracking");
        if (!raf) raf = requestAnimationFrame(tick);
      }

      function tick() {
        // smooth lerp
        currentX += (targetX - currentX) * 0.12;
        currentY += (targetY - currentY) * 0.12;

        items.forEach((el) => {
          const d = parseFloat(el.dataset.depth) || 0.03;
          const x = currentX * 40 * d * 30;  // max ~ few dozen px
          const y = currentY * 40 * d * 30;
          el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        });

        if (Math.abs(currentX - targetX) > 0.001 || Math.abs(currentY - targetY) > 0.001) {
          raf = requestAnimationFrame(tick);
        } else {
          raf = null;
        }
      }

      // Use the nearest reasonably large parent so movement is local
      const zone = layer.closest(".hero, .auth-page, .page") || document.body;
      zone.addEventListener("mousemove", onMove, { passive: true });
      zone.addEventListener("mouseleave", onLeave, { passive: true });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();
