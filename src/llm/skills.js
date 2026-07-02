/* ============================================================
   Skills — reusable how-to procedure memory (the Hermes idea).
   A skill is distinct from a fact/episode: it's a procedure the agent wrote
   after solving something ("how to reconcile my bank statements from PDFs")
   that it can find and re-apply later instead of re-deriving it.

   Mirrors src/llm/memory.js: each skill carries an embedding (of title+trigger,
   so retrieval matches on WHEN to use it), provenance, and usage stats. The
   always-injected skillsBlock lists only title+trigger (cheap); the model calls
   recall_skill to expand the full steps of the one it needs. (LEARNING-LOOP-PLAN A1)
   ============================================================ */
const { storesFor } = require("../state/user-stores");
const { embed } = require("../rag/index");
const { cosine } = require("../rag/retrieve");

const MAX_SKILLS = 100;
const SKILL_TOPK = 3, SKILL_FLOOR = 0.45, SKILL_SUPERSEDE = 0.82, SKILL_BUDGET = 800;

const skillPublic = s => { const { vec, ...rest } = s; return rest; };
const skillKey = s => `${s.title || ""}\n${s.trigger || ""}`.trim();

// backfill embeddings for any skill missing one (lazy, best-effort) — mirrors ensureMemoryReady
async function ensureSkillsReady(user) {
  const st = storesFor(user);
  const missing = st.skills.filter(s => !s.vec);
  if (!missing.length) return;
  try {
    const vecs = await embed(missing.map(skillKey));
    missing.forEach((s, i) => { if (vecs[i]) s.vec = vecs[i]; });
    st.save("skills.json");
  } catch {}
}

// write or update a skill. A near-duplicate (same title/trigger embedding) is merged in place
// rather than stacking a second copy — keeps the store from filling with paraphrases.
async function addSkill(user, { title, steps, trigger, tags, source = "manual" } = {}) {
  const st = storesFor(user);
  title = String(title || "").trim();
  steps = String(steps || "").trim();
  trigger = String(trigger || "").trim();
  if (!title || !steps) return null;
  tags = Array.isArray(tags) ? tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8) : [];
  const now = Date.now();
  let vec = null; try { [vec] = await embed([`${title}\n${trigger}`]); } catch {}

  // exact title match → update in place
  const lc = title.toLowerCase();
  let dup = st.skills.find(s => (s.title || "").toLowerCase() === lc);
  // otherwise a very-close (title+trigger) embedding counts as the same procedure
  if (!dup && vec) {
    let best = null, bs = 0;
    for (const s of st.skills) if (s.vec) { const sc = cosine(vec, s.vec); if (sc > bs) { bs = sc; best = s; } }
    if (best && bs >= SKILL_SUPERSEDE) dup = best;
  }
  if (dup) {
    dup.title = title; dup.steps = steps; dup.trigger = trigger || dup.trigger;
    if (tags.length) dup.tags = tags;
    if (vec) dup.vec = vec;
    dup.updatedAt = now; dup.source = source;
    st.save("skills.json");
    return skillPublic(dup);
  }
  const s = { id: "s" + now + Math.random().toString(16).slice(2, 6), title, steps, trigger, tags,
    source, vec, createdAt: now, updatedAt: now, lastUsedAt: 0, useCount: 0, successCount: 0 };
  st.skills.unshift(s);
  if (st.skills.length > MAX_SKILLS) {   // evict the least-used, stalest skill (mirrors memory eviction)
    const sorted = [...st.skills].sort((a, b) =>
      (a.successCount || 0) - (b.successCount || 0) || (a.useCount || 0) - (b.useCount || 0) ||
      (a.lastUsedAt || a.updatedAt || 0) - (b.lastUsedAt || b.updatedAt || 0));
    if (sorted[0]) st.skills = st.skills.filter(x => x.id !== sorted[0].id);
  }
  st.save("skills.json");
  return skillPublic(s);
}

// patch an existing skill (used by the manage UI and reflection)
async function updateSkill(user, id, patch = {}) {
  const st = storesFor(user);
  const s = st.skills.find(x => x.id === id);
  if (!s) return null;
  let reembed = false;
  if (typeof patch.title === "string" && patch.title.trim()) { s.title = patch.title.trim(); reembed = true; }
  if (typeof patch.steps === "string" && patch.steps.trim()) s.steps = patch.steps.trim();
  if (typeof patch.trigger === "string") { s.trigger = patch.trigger.trim(); reembed = true; }
  if (Array.isArray(patch.tags)) s.tags = patch.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 8);
  if (reembed) { try { [s.vec] = await embed([`${s.title}\n${s.trigger}`]); } catch {} }
  s.updatedAt = Date.now();
  st.save("skills.json");
  return skillPublic(s);
}

function removeSkill(user, id) {
  const st = storesFor(user);
  const before = st.skills.length;
  st.skills = st.skills.filter(s => s.id !== id);
  if (st.skills.length !== before) st.save("skills.json");
  return st.skills.length !== before;
}

// retrieve the skills whose trigger best matches a query (cosine over the title+trigger vector)
async function findSkills(user, query, k = SKILL_TOPK) {
  const st = user ? storesFor(user) : null;
  if (!st || !st.skills.length || !String(query).trim()) return [];
  await ensureSkillsReady(user);
  let qv;
  try { [qv] = await embed([String(query).slice(0, 2000)]); } catch { return []; }
  if (!qv) return [];
  return st.skills.filter(s => s.vec).map(s => ({ s, score: cosine(qv, s.vec) }))
    .filter(x => x.score >= SKILL_FLOOR).sort((a, b) => b.score - a.score).slice(0, k).map(x => x.s);
}

// compact always-injected list — titles + triggers only (steps fetched on demand via recall_skill)
async function skillsBlock(user, query = "") {
  const matches = await findSkills(user, query);
  if (!matches.length) return "";
  const lines = []; let used = 0;
  for (const s of matches) {
    const line = `- ${s.title}${s.trigger ? ` — use when ${s.trigger}` : ""}`;
    if (used + line.length > SKILL_BUDGET) break;
    lines.push(line); used += line.length;
  }
  if (!lines.length) return "";
  return "\n\nLearned skills — procedures you saved earlier (call recall_skill with the title to get the full steps before applying one):\n" + lines.join("\n");
}

// bump usage stats when a recalled skill is actually used
function markSkillUsed(user, id, success = false) {
  const st = storesFor(user);
  const s = st.skills.find(x => x.id === id);
  if (!s) return;
  s.lastUsedAt = Date.now(); s.useCount = (s.useCount || 0) + 1;
  if (success) s.successCount = (s.successCount || 0) + 1;
  st.save("skills.json");
}

module.exports = {
  skillPublic, ensureSkillsReady, addSkill, updateSkill, removeSkill,
  findSkills, skillsBlock, markSkillUsed,
};
