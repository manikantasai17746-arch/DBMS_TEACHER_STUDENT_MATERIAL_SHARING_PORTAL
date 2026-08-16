// ---------------------------------------------------------------------------
// Minimal in-memory rate limiter.
// ---------------------------------------------------------------------------
// Good enough to blunt naive brute-forcing of login/card-login/register in a
// single-process demo. It is NOT a substitute for a real limiter (e.g.
// nginx/Cloudflare rate limiting, or a Redis-backed limiter) in production,
// and it resets on restart and doesn't share state across processes.
// ---------------------------------------------------------------------------

const buckets = new Map();

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip || "unknown"}:${req.baseUrl}${req.path}`;
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfterSec = Math.ceil((bucket.start + windowMs - now) / 1000);
      res.set("Retry-After", String(Math.max(retryAfterSec, 1)));
      return res.status(429).json({ error: "Too many attempts. Please wait and try again." });
    }

    next();
  };
}

module.exports = rateLimit;
