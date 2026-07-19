/* Auth middleware: the wall that gates every /api route on a signed-in user,
   and the admin-only guard for user-management endpoints. */
const { userFromRequest } = require("./accounts");

// every /api route needs a signed-in user, except /api/auth/* (static + auth
// endpoints are open; /mcp checks bearer tokens itself)
function authWall(req, res, next) {
  if (!req.path.startsWith("/api/") || req.path.startsWith("/api/auth/")) return next();
  const user = userFromRequest(req);
  if (!user) return res.status(401).json({ error: "Not signed in" });
  req.user = user;
  next();
}

const requireAdmin = (req, res) => { if (req.user.role !== "admin") { res.status(403).json({ error: "Admin only" }); return false; } return true; };

/* Login brute-force guard: per-IP failure counter, in memory only (a restart resets it — fine,
   this is a speed bump against automated guessing, not a security boundary on its own). */
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginAttempts = new Map();   // ip -> { count, resetAt }
function loginLimiter(req, res, next) {
  const rec = loginAttempts.get(req.ip);
  if (rec && rec.resetAt <= Date.now()) loginAttempts.delete(req.ip);
  else if (rec && rec.count >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${Math.ceil((rec.resetAt - Date.now()) / 1000)}s.` });
  }
  next();
}
function recordLoginFailure(req) {
  const rec = loginAttempts.get(req.ip);
  if (!rec || rec.resetAt <= Date.now()) loginAttempts.set(req.ip, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  else rec.count++;
}
const clearLoginFailures = (req) => loginAttempts.delete(req.ip);

module.exports = { authWall, requireAdmin, loginLimiter, recordLoginFailure, clearLoginFailures };
