/* ============================================================
   Accounts & sessions (multi-tenant).
   Users in data/users.json (scrypt-hashed passwords); browser sessions in
   data/sessions.json via an HttpOnly cookie. Each user's content (KB, chats,
   memory, MCP connectors) lives under data/users/<id>/.

   `users` and `authSessions` are shared mutable state — exported by reference.
   Mutate in place (push/splice/delete); never reassign the bindings, or the
   helpers here would keep pointing at the old object.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DATA_DIR } = require("../config");
const { writeJSONAtomic } = require("../util/json-store");
const { USERS_DIR } = require("../state/user-stores");
const { tagStore, imageMeta, phashStore, pdfOcrStore, persistTags, persistImageMeta, persistPhash, persistPdfOcr } = require("../state/sidecars");

const USERS_FILE = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
let users = [];
try { users = JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); } catch { users = []; }
let authSessions = {};   // sid -> { userId, createdAt, lastSeen }
try { authSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")); } catch { authSessions = {}; }

function persistUsers() { try { writeJSONAtomic(USERS_FILE, users); } catch (e) { console.error("users persist:", e.message); } }
function persistAuthSessions() { try { writeJSONAtomic(SESSIONS_FILE, authSessions); } catch {} }
const newToken = (n = 24) => crypto.randomBytes(n).toString("hex");
function hashPassword(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString("hex"); }
function verifyPassword(u, pw) {
  try { return crypto.timingSafeEqual(crypto.scryptSync(String(pw), u.salt, 64), Buffer.from(u.passHash, "hex")); } catch { return false; }
}
function publicUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, folders: u.folders || [] }; }
function cleanFolders(v) { return (Array.isArray(v) ? v : []).map(s => String(s).trim()).filter(Boolean).map(s => path.resolve(s)); }
function createUser({ username, name, password, role = "user", folders }) {
  const uname = String(username || "").trim().toLowerCase().replace(/[^a-z0-9._-]/g, "");
  if (!uname) throw new Error("Username required (letters/digits/._- only)");
  if (String(password || "").length < 4) throw new Error("Password must be at least 4 characters");
  if (users.find(u => u.username === uname)) throw new Error(`Username "${uname}" is taken`);
  const salt = newToken(8);
  const u = { id: "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), username: uname,
    name: String(name || "").trim() || uname, salt, passHash: hashPassword(password, salt),
    role: role === "admin" ? "admin" : "user", folders: cleanFolders(folders), mcpToken: newToken(), createdAt: Date.now() };
  users.push(u); persistUsers();
  fs.mkdirSync(path.join(USERS_DIR, u.id, "kb"), { recursive: true });
  return u;
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach(p => { const i = p.indexOf("="); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function userFromRequest(req) {
  const sess = authSessions[parseCookies(req).heapchat_sid];
  return (sess && users.find(u => u.id === sess.userId)) || null;
}
function startSession(res, user) {
  const sid = newToken();
  authSessions[sid] = { userId: user.id, createdAt: Date.now(), lastSeen: Date.now() };
  persistAuthSessions();
  res.setHeader("Set-Cookie", `heapchat_sid=${sid}; HttpOnly; Path=/; SameSite=Lax; Max-Age=31536000`);
}
// first account adopts the single-tenant data layout: move kb/, chats, memory, mcp into its dir
// and re-key the path-keyed sidecars so vision descriptions/tags/hashes of old KB files survive.
function migrateLegacyData(u) {
  const dir = path.join(USERS_DIR, u.id);
  const oldKb = path.join(DATA_DIR, "kb"), newKb = path.join(dir, "kb");
  for (const f of ["chats.json", "memory.json", "mcp.json", "mcp-sessions.json"]) {
    const src = path.join(DATA_DIR, f), dest = path.join(dir, f);
    try { if (fs.existsSync(src) && !fs.existsSync(dest)) fs.renameSync(src, dest); } catch (e) { console.error("migrate", f, e.message); }
  }
  try {
    if (fs.existsSync(oldKb) && fs.readdirSync(oldKb).length) {
      fs.rmSync(newKb, { recursive: true, force: true });
      fs.renameSync(oldKb, newKb);
      for (const store of [tagStore, imageMeta, phashStore, pdfOcrStore]) {
        for (const k of Object.keys(store)) {
          if (k.startsWith(oldKb + path.sep)) { store[newKb + k.slice(oldKb.length)] = store[k]; delete store[k]; }
        }
      }
      persistTags(); persistImageMeta(); persistPhash(); persistPdfOcr();
      console.log(`[auth] migrated legacy data to user ${u.username}`);
    }
  } catch (e) { console.error("migrate kb:", e.message); }
  fs.mkdirSync(newKb, { recursive: true });
}

module.exports = {
  USERS_FILE, SESSIONS_FILE, users, authSessions,
  persistUsers, persistAuthSessions, newToken, hashPassword, verifyPassword,
  publicUser, cleanFolders, createUser, parseCookies, userFromRequest, startSession, migrateLegacyData,
};
