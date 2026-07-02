/* ============================================================
   Per-user content stores (lazy-loaded, debounced persist).
   Each user's KB, chats, memory, projects, agents, roster, people and MCP
   config live under data/users/<id>/. storesFor(user) loads them once and
   caches the bundle in `userStores`, keyed by user id.
   ============================================================ */
const fs = require("fs");
const path = require("path");
const { DATA_DIR } = require("../config");
const { writeJSONAtomic } = require("../util/json-store");

const USERS_DIR = path.join(DATA_DIR, "users");

const userStores = new Map();   // userId -> { kbDir, chats, memory, skills, profile, jobs, digests, mcp, mcpSessions, save }
function storesFor(user) {
  let s = userStores.get(user.id);
  if (s) return s;
  const dir = path.join(USERS_DIR, user.id);
  const kbDir = path.join(dir, "kb");
  fs.mkdirSync(kbDir, { recursive: true });
  const load = (f, fb) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return fb; } };
  const timers = {};
  s = {
    kbDir,
    projects: load("projects.json", []),
    agents: load("agents.json", []),
    roster: load("roster.json", []),
    people: load("people.json", {}),
    chats: load("chats.json", {}),
    memory: load("memory.json", []),
    skills: load("skills.json", []),          // reusable how-to procedures (learning loop)
    profile: load("profile.json", null),      // synthesized "what Cortex knows about you"
    jobs: load("jobs.json", []),              // scheduled agent runs
    digests: load("digests.json", []),        // activity feed: outputs of scheduled runs
    settings: load("settings.json", {}),      // per-user feature flags (e.g. { reflection: true })
    mcp: load("mcp.json", []),
    mcpSessions: load("mcp-sessions.json", {}),
    save(name) {   // debounced persist of one of the stores above
      clearTimeout(timers[name]);
      timers[name] = setTimeout(() => {
        const data = { "projects.json": s.projects, "agents.json": s.agents, "roster.json": s.roster, "people.json": s.people, "chats.json": s.chats, "memory.json": s.memory, "skills.json": s.skills, "profile.json": s.profile, "jobs.json": s.jobs, "digests.json": s.digests, "settings.json": s.settings, "mcp.json": s.mcp, "mcp-sessions.json": s.mcpSessions }[name];
        try { writeJSONAtomic(path.join(dir, name), data); } catch (e) { console.error(name, "persist:", e.message); }
      }, 150);
    },
  };
  userStores.set(user.id, s);
  return s;
}
const kbDirFor = user => storesFor(user).kbDir;
function projectKbDirFor(user, projectId) {
  const dir = path.join(USERS_DIR, user.id, "projects", projectId, "kb");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// is this path some user's knowledge-base dir? (KB indexes also fold in external searchable images)
function isKbDir(p) { return path.basename(p) === "kb" && path.dirname(path.dirname(p)) === USERS_DIR; }

module.exports = { USERS_DIR, userStores, storesFor, kbDirFor, projectKbDirFor, isKbDir };
