/* ============================================================
   Folder grants: default-deny disk access for members.
   Admins see the whole disk. Members see their private KB plus the folder roots
   an admin granted them (user.folders) — enforced on every path-taking endpoint,
   with symlinks resolved so a link can't escape a grant.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { kbDirFor, USERS_DIR } = require("../state/user-stores");

function realResolve(p) { const rp = path.resolve(String(p || "")); try { return fs.realpathSync(rp); } catch { return rp; } }
function grantedRoots(user) { return (user.folders || []).map(realResolve); }
function canAccessPath(user, p) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const rp = realResolve(p);
  const kb = kbDirFor(user);
  if (rp === kb || rp.startsWith(kb + path.sep)) return true;
  const projBase = path.join(USERS_DIR, user.id, "projects");
  if (rp === projBase || rp.startsWith(projBase + path.sep)) return true;
  return grantedRoots(user).some(root => rp === root || rp.startsWith(root + path.sep));
}
function guardPath(req, res, p) {
  if (canAccessPath(req.user, p)) return true;
  res.status(403).json({ error: "You don't have access to this folder. Ask an admin to grant it in Settings." });
  return false;
}
const accessibleOnly = (req, paths) => paths.filter(p => canAccessPath(req.user, p));

module.exports = { realResolve, grantedRoots, canAccessPath, guardPath, accessibleOnly };
