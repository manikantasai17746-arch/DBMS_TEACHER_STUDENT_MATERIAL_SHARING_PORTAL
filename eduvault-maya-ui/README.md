# EduVault

A centralized teacher–student academic material sharing system, built to replace
scattered WhatsApp groups for distributing PDFs, PPTs, and notes.

**The core problem it solves:** WhatsApp only shows chat history from the moment
you join a group — so a student who joins late (or a lateral entry student
joining mid-program) can never see material shared before they arrived.
EduVault stores material against the *teacher's* profile in a database instead
of inside a chat thread, so a student who selects a teacher's Employee ID
always sees the complete history, from day one, regardless of when their own
account was created.

## Features

- **Teacher accounts** — register with Employee ID, department, and subjects handled, gated behind email-verified Enrollment Codes (see below)
- **Enrollment Codes** — new faculty prove they own their college Gmail address before an account can be created for their Employee ID. A one-time code is emailed to them (or issued directly by an admin); it's single-use, expires, and is rate-limited per email. This is what stops a stranger who only knows someone's Employee ID from registering an account in their name.
- **Admin role** — a preconfigured System Administrator account (seeded on boot, see "Admin Access" below) that manages Enrollment Codes and every employee/student account from its own dashboard, without going through the public registration flow itself
- **Scan-to-login ID cards** — the barcode on a college ID card already encodes the Employee ID / Roll Number, so scanning it with the device camera is a direct, password-free login. Unrecognized cards route straight into a one-time registration form with the ID pre-filled; from then on, that same card logs the person in instantly.
- **Printable ID cards** — every teacher/admin can generate and print their own barcode ID card (`id-card.html`), and an admin can print one for any employee from the admin dashboard
- **Upload material** — PDF, PPT/PPTX, DOC/DOCX, TXT, JPG, PNG (up to 200MB), tagged by subject, unit, and semester, stored through a storage abstraction (local disk or S3-compatible — see "Deploying to Render" below)
- **Student accounts** — register once, then look up *any* teacher by Employee ID or name
- **Full history, always** — students see every file a teacher has ever uploaded, not just what's been posted since they joined
- **Bookmarks** — students can star frequently visited teachers for one-click access
- **Access analytics** — teachers see how many times each file has been accessed
- **Account management** — admins can activate/deactivate or delete any employee/student account, and promote/demote employees between the `teacher` and `admin` roles
- **JSON-file data layer** — data is stored in a local JSON file (`data/db.json`), which mirrors the relational design described in the project report (Teachers / Students / Materials / Access_Log tables) so it's a drop-in swap for real MySQL/MongoDB later

## Tech Stack

- **Backend:** Node.js + Express
- **File uploads:** Multer, written through `lib/storage.js` (local disk by default, optional S3-compatible driver — see "Deploying to Render")
- **Email:** Nodemailer over Gmail SMTP (`lib/mailer.js`) — sends Enrollment Code emails only; never logs or returns the code itself
- **Barcode scanning:** ZXing (`@zxing/library`, loaded from CDN) — reads the camera feed client-side and decodes standard 1D barcodes (Code128, EAN, UPC, Code39) and QR codes
- **Barcode generation:** JsBarcode (loaded from CDN in `id-card.html`) — renders a scannable Code128 barcode of the Employee ID for printing
- **Database:** Lightweight JSON file store (`db.js`) — structured exactly like the relational schema in the report, so swapping in MySQL/MongoDB later only means rewriting `db.js`
- **Frontend:** Plain HTML/CSS/JS (no build step, no framework — runs directly in the browser)
- **Auth:** Password hashing via Node's built-in `crypto.scrypt`, plus password-free card login. Every login method issues a signed session token (`lib/auth.js`) that the frontend stores and sends back on every API call — the server never trusts an Employee ID / Roll Number that just shows up in a request body (see "Security" below). A separate, purpose-typed, short-lived token gates Enrollment Code verification from registration itself.

## Requirements

- [Node.js](https://nodejs.org) version 18 or later (check with `node -v`)

## Setup & Run

```bash
# 1. Install dependencies
npm install

# 2. (Recommended) Set a session secret -- see .env.example
cp .env.example .env
# then edit .env and paste in a real value, e.g.:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Start the server
npm start

# 4. Open your browser to:
http://localhost:3000
```

That's it — no database server, no build step required. If you skip step 2,
the app still runs fine for a demo, but every logged-in session is
invalidated whenever the server restarts (see "Security" below).

To use a different port: `PORT=8080 npm start`

## Admin Access

A System Administrator account is seeded automatically every time the server
starts (`db.ensureSeedAdmin()` in `server.js`) — it never goes through the
public Enrollment Code / registration flow, so there's always at least one
account that can issue codes and manage everyone else.

**Default credentials (documented here on purpose, since they're public):**

| Employee ID | Password |
|---|---|
| `mani@1774admin` | `mani@1774` |

Log in at `/teacher-login.html` with these — the login page automatically
redirects an admin account to `/admin-dashboard.html` instead of the regular
teacher dashboard.

**Rotate these before any real deployment.** Set `ADMIN_EMP_ID`,
`ADMIN_PASSWORD`, and optionally `ADMIN_EMAIL` in your environment (see
`.env.example`) — the seeder picks them up on every boot, including
updating an already-seeded admin row if you change them later. Never leave
the default password active on a publicly reachable deployment.

From the admin dashboard you can:
- Issue an Enrollment Code to a new employee by email (they don't have to
  self-request one first)
- View, revoke, and audit every Enrollment Code ever issued
- Activate/deactivate or delete any employee or student account
- Promote an employee to `admin` or demote an admin back to `teacher`
  (the seeded admin account itself can't be demoted, deactivated, or
  deleted — only rotated via the env vars above)
- Print an ID card for any employee

## How to demo it

**With a real barcode (recommended for your review):**

1. Open `http://localhost:3000` and click **Register** under "I'm a Teacher".
   Enter your Employee ID (printed under your own college ID card's barcode,
   e.g. `EMP1042`) along with a real Gmail address, then **Send Enrollment
   Code**. You need `MAIL_USER` / `MAIL_APP_PASSWORD` set in `.env` for this
   to actually deliver an email (see `.env.example`) — without it, the
   server returns a clear "email isn't configured" error instead of failing
   silently. Enter the code from your inbox to verify, then set a password
   to finish.
   *(Alternative: log in as the seeded admin — see "Admin Access" above —
   and issue yourself a code from the admin dashboard instead of
   self-requesting one.)*
2. From the teacher dashboard, upload a PDF/PPT and tag it with a subject.
   From the topbar, **My ID Card** generates a printable barcode ID card for
   this account.
3. Open a new browser tab and click **Login** under "I'm a Student", then
   tap **Scan ID Card** and hold up a student ID card whose barcode has
   never been used here before. Since it's not registered, you'll be sent
   to registration with the Roll Number already filled in — finish the
   short form once.
4. Log out and tap **Scan ID Card** again with the *same* card. This time
   it logs in instantly — no typing, no password. That's the core feature.
5. On the student portal, search for the teacher by Employee ID or name.
   You'll see every file they've uploaded — including anything uploaded
   *before* this student account existed, which is the entire point.
6. Download a file — this logs an access event. Go back to the teacher
   dashboard and refresh: the "views" count updates.
7. Star the teacher from the student portal to bookmark them for next time.

**Without a physical barcode:** every "Scan ID Card" button also has a
"Can't scan? Enter code manually" fallback inside the camera modal — type
any Employee ID / Roll Number there to simulate a scan. The manual
Employee ID/Roll Number + password forms below the scan button work too.

> Camera access requires the browser to trust the page. `localhost` is
> trusted automatically, so this works out of the box on your laptop. If
> you deploy it elsewhere, it needs to be served over HTTPS for the camera
> to be allowed.

## Project Structure

```
eduvault/
├── server.js               Express app entry point, security headers, .env loader, admin seeding
├── db.js                   JSON-file data layer (Teachers/Students/Materials/Access_Log/EnrollmentCodes)
├── data/db.json             The "database" file itself
├── uploads/                 Uploaded files are stored here (STORAGE_DRIVER=local only)
├── lib/
│   ├── auth.js               Signed session tokens (issueToken/requireAuth) + Enrollment tokens
│   ├── mailer.js              Nodemailer/Gmail SMTP sender for Enrollment Code emails
│   ├── storage.js             Storage abstraction (local disk or S3-compatible)
│   ├── filename.js            Safe download filenames / Content-Disposition helpers
│   └── rateLimit.js           Minimal in-memory rate limiter for login/upload/download/enrollment
├── routes/
│   ├── teachers.js           Register (+ Enrollment Code request/verify), login, search, analytics
│   ├── students.js           Register, login, bookmarks
│   ├── materials.js          Upload, list-by-teacher, download (+access logging), delete
│   └── admin.js               Enrollment code management, employee/student account management
└── public/                  Frontend (static HTML/CSS/JS)
    ├── index.html             Landing page
    ├── teacher-*.html          Teacher registration/login/dashboard
    ├── student-*.html          Student registration/login/portal
    ├── admin-dashboard.html    Enrollment codes + employee/student management
    ├── id-card.html            Printable barcode ID card (own card, or any employee's via admin)
    ├── css/style.css
    └── js/
        ├── common.js            Shared fetch/auth/toast helpers (attaches session token)
        └── scanner.js           Camera barcode scanner (ZXing / native BarcodeDetector)
```

## Database Design (as implemented)

| "Table" (array in db.json) | Key Fields |
|---|---|
| `teachers` | `emp_id` (key), `name`, `department`, `subjects_handled`, `email`, `password_hash`, `role` (`teacher`\|`admin`), `active`, `email_verified`, `seeded` |
| `students` | `roll_no` (key), `name`, `department`, `semester`, `email`, `password_hash`, `active`, `bookmarked_teachers[]` |
| `materials` | `material_id`, `emp_id` (→ teachers), `subject`, `title`, `unit`, `semester`, `file_url`, `upload_date` |
| `accessLogs` | `log_id`, `roll_no` (→ students), `material_id` (→ materials), `accessed_on` |
| `enrollmentCodes` | `id`, `email`, `code_hash` (never the plaintext code), `employee_id`, `department`, `attempts`, `expires_at`, `used_at`, `revoked_at` |
| `trustedDevices` | `owner_type` (`teacher`\|`student`), `owner_id`, `token_hash` — backs password-free card login on a device that has already proven ownership |

`emp_id` is the anchor: every material links to exactly one teacher, and every
student lookup starts by resolving a teacher through this same field — which
is what guarantees full history regardless of when a student's account was
created.

## Security

This started as a functional demo and has since had its authorization model
fixed properly — the identity checks below are real, not just documented as
future work.

**Session tokens (`lib/auth.js`).** Every register/login/card-login call
returns a signed token (`issueToken`), separate from the profile object. The
frontend stores it in `localStorage` alongside the profile and `api()`
(`public/js/common.js`) attaches it as `Authorization: Bearer <token>` on
every request automatically. Tokens are HMAC-SHA256 signed with
`SESSION_SECRET`, expire after 12 hours, and are verified with
`crypto.timingSafeEqual` so they can't be forged or replayed after tampering.
**Set `SESSION_SECRET` in your environment for any real deployment** — see
`.env.example`. Without it, a random secret is generated at process start,
which is fine for a single local demo but invalidates all sessions on
restart and won't work across multiple server instances.

**Every state-changing action is now authorization-checked server-side,**
not just client-side:

| Action | Who can do it | Enforced by |
|---|---|---|
| Upload material | The authenticated teacher, for their own `emp_id` only | `requireAuth("teacher")` in `routes/materials.js` — `emp_id` comes from the verified token, never from the request body |
| Delete material | The authenticated teacher, for their own `emp_id` only | same as above |
| View analytics | The authenticated teacher, for their own `emp_id` only | `routes/teachers.js` checks `req.auth.sub === req.params.emp_id` |
| Toggle a bookmark | The authenticated student, for their own `roll_no` only | `routes/students.js` checks `req.auth.sub === req.params.roll_no` |
| Download + log access | Any authenticated student; the access log always records the *verified* `roll_no`, never a client-supplied one | `requireAuth("student")` in `routes/materials.js` (token passed as `?token=` since plain `<a href>` links can't set headers) |

Previously, all five of these took `emp_id` / `roll_no` straight from the
request body or URL with no verification at all — anyone who could see a
teacher's Employee ID (trivially discoverable via the public search endpoint)
could upload or delete files as that teacher, or forge another student's
access logs. That's fixed now.

Two endpoints remain intentionally public and unauthenticated by design —
looking up a teacher by Employee ID/name (`GET /api/teachers`) and listing
their materials (`GET /api/materials/teacher/:emp_id`) — because "any
student can look up any teacher's full history" is the whole point of the
app. Both are rate-limited to slow scraping.

**Uploaded-file safety.** `.html`, `.js`, and `.css` were removed from the
allowed upload extensions — serving user-uploaded script content from the
app's own origin is a stored-XSS risk (it could read other users' session
tokens out of `localStorage`). As a second layer of defense, `server.js`
also forces any file type that isn't safe to preview (PDF/image/audio/video/
plain text) to download via `Content-Disposition: attachment` instead of
rendering inline, so even a mis-typed extension can't execute as script.

**Rate limiting (`lib/rateLimit.js`).** Login, card-login, and registration
endpoints are rate-limited per IP to slow brute-force attempts. This is an
in-memory, single-process limiter — adequate for a demo, but a real
deployment behind a load balancer would want a shared (e.g. Redis-backed)
limiter instead.

**Passwords.** Hashed with `scrypt` (never stored in plain text), minimum 8
characters, enforced both client- and server-side.

**Employee registration requires proof of email ownership.** A stolen or
guessed Employee ID alone is no longer enough to create a teacher account.
`POST /api/teachers/register` requires a signed, short-lived
`enrollment_token` (`lib/auth.js`) proving the submitted email just passed
Enrollment Code verification for that *exact* email — this is checked
server-side on every request, not just enforced by the frontend UI, so it
can't be bypassed by calling the API directly. Enrollment Codes themselves
are 6-digit values generated with `crypto.randomInt` (not `Math.random()`),
stored only as an HMAC-SHA256 hash (never in plaintext), single-use, expire
after 15 minutes by default, and are both cooldown- and hourly-rate-limited
per email to stop someone from spamming a target's inbox.

**The admin role is a privileged, backend-enforced boundary.** Every route
in `routes/admin.js` requires a session token with `role: "admin"`
(`requireAuth("admin")`) — a valid, logged-in teacher token is rejected with
401 before any admin handler runs. The one seeded admin account
(`db.ensureSeedAdmin`) never goes through the public registration endpoint,
and can't be deactivated, deleted, or demoted through the admin API itself
(only by changing `ADMIN_EMP_ID`/`ADMIN_PASSWORD` and restarting) — so a
compromised or misused non-seeded admin can always be locked out by a
person with server access, without risking a total lockout.

**Card login is still identity-by-possession, not identity-by-secret** — the
barcode is the Employee ID / Roll Number itself, not a secret, so scanning it
proves you're holding that physical card, the same trust model as swiping a
badge at a door. That design choice is unchanged; what's fixed is that every
*subsequent* action taken while logged in is now actually tied to a verified
identity instead of a client-supplied one.

**What's still explicitly out of scope for a college demo:**
- Storing the session token in `localStorage` rather than an `httpOnly`
  cookie — readable by any script on the page. Acceptable given uploads can
  no longer execute script (see above), but a production version would move
  to `httpOnly`, `Secure`, `SameSite` cookies.
- The JSON-file "database" has no transactions/locking — fine for a single
  demo instance, not for concurrent writers. (Uploaded *files* no longer
  have this problem if you use `STORAGE_DRIVER=s3` — see "Deploying to
  Render" — but `data/db.json` itself is still a single local file either
  way.)
- No HTTPS in this repo itself — required for camera access anywhere but
  `localhost`. Render provides this automatically for you at the platform
  level; a self-hosted deployment would need to terminate TLS itself.
- The in-memory rate limiter (including the Enrollment Code cooldown) resets
  on restart and doesn't share state across multiple server processes.

## Deploying to Render

1. **Push this repo to GitHub** (or GitLab/Bitbucket), then create a new
   **Web Service** on [Render](https://render.com) pointing at it.
2. **Build command:** `npm install`. **Start command:** `npm start`. Render
   sets `$PORT` automatically — `server.js` already reads it, don't hard-code
   a port.
3. **Set environment variables** under Service → Environment (do **not**
   commit a `.env` file — it's already excluded via `.gitignore`):

   | Variable | Required? | Notes |
   |---|---|---|
   | `SESSION_SECRET` | Yes | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — without it, every session is invalidated on each redeploy |
   | `MAIL_USER` / `MAIL_APP_PASSWORD` | Yes, for Enrollment Codes to send | A Gmail address + [App Password](https://myaccount.google.com/apppasswords) (requires 2-Step Verification on that Gmail account) |
   | `ADMIN_EMP_ID` / `ADMIN_PASSWORD` / `ADMIN_EMAIL` | Strongly recommended | Overrides the public default admin credentials — see "Admin Access" above |
   | `STORAGE_DRIVER` | Recommended | See storage note below |

4. **Uploaded files and Render's disk.** Render's local filesystem is
   **ephemeral** — anything written to disk (the default
   `STORAGE_DRIVER=local` behavior) is wiped on every redeploy or restart.
   Two options:
   - **Render Disk** (persistent volume): attach one to the service, mount
     it (e.g. at `/var/data/uploads`), and set `UPLOAD_DIR` to that mount
     path. Simplest option, keeps `STORAGE_DRIVER=local`.
   - **S3-compatible storage** (recommended — survives redeploys *and*
     scaling to multiple instances): set `STORAGE_DRIVER=s3` plus
     `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`
     (and `S3_ENDPOINT` if you're using Cloudflare R2, Backblaze B2, or
     MinIO instead of real AWS S3). This requires
     `npm install @aws-sdk/client-s3` first — see `lib/storage.js` for the
     full driver contract. With this driver, `/uploads` is not statically
     served at all; every download/view goes through the storage-aware
     proxy routes in `routes/materials.js` instead.

   See every option, with inline explanations, in `.env.example`.
5. **`data/db.json` has the same ephemeral-disk problem** as local uploads,
   since it's also just a file on disk — it will reset on every redeploy
   unless it also lives on an attached Render Disk. For anything beyond a
   demo, plan to swap `db.js` for a real database (see "Future
   Improvements") rather than relying on the JSON file surviving redeploys.
6. **HTTPS** is required for camera access (the ID-card scanner) on any
   origin other than `localhost` — Render's default `*.onrender.com` URLs
   are served over HTTPS automatically, so this works out of the box.

## Future Improvements

(matches the "Future Scope" section of the project report)

- Swap `db.js` for real MySQL/MongoDB queries (the schema is already designed for it)
- Move session tokens from `localStorage` to `httpOnly` cookies
- Mobile app for offline access to downloaded material
- Push notifications when a teacher uploads new content
- AI-based auto-tagging of uploaded files by subject/unit
- Integration with college ERP for automatic student/teacher sync
- Shared/persistent rate limiting for multi-instance deployments
