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

module.exports = { authWall, requireAdmin };
