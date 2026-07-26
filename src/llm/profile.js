/* ============================================================
   User profile — the synthesized "how to talk to this user" block (LEARNING-LOOP-PLAN A2).
   Memory is otherwise a flat list of notes; this consolidates ONLY the durable
   COMMUNICATION-STYLE ones (preferences, standing instructions) into a few stable
   sentences injected at the TOP of the agent system prompt — a small, slow-changing
   block that's friendly to Ollama's cached prefix.

   Deliberately excludes `fact`/`episode` notes: those are specific and often narrow
   (a marathon someone's training for, a manager's name, a past task) — folding them
   into an ALWAYS-ON summary meant every conversation carried them regardless of
   relevance, and it visibly leaked into unrelated answers (confirmed live: a fact
   about training for a marathon changed word choice in an unrelated motivational
   quote). Facts/episodes still reach the model, just gated by query relevance via
   memoryBlock() in memory.js instead of unconditionally here.

   Rebuilt lazily + debounced (never on every message): a few-second timer armed
   when a preference/instruction lands, plus a daily idle tick. Degrades to no
   block if the model/embeddings are unavailable, exactly like memory.js.
   ============================================================ */
const { OLLAMA_MODEL } = require("../config");
const { storesFor } = require("../state/user-stores");
const { completeText } = require("./ollama");

const PROFILE_SYS =
  "You maintain a concise profile of how an AI assistant should communicate with a specific user. " +
  "From the notes below (their stated preferences and standing instructions), write 1–3 plain sentences capturing ONLY how they like answers delivered — tone, format, length, language, units, and any standing rules for responding. " +
  "Do NOT include or infer facts about who they are, what they work on, or anything else about their life — this profile is style/format guidance only, not a biography. " +
  "Write in the third person, present tense. Only state what the notes support — never invent details. No preamble, no bullet points, no headings — just the sentences.";

const REBUILD_DEBOUNCE_MS = +process.env.PROFILE_DEBOUNCE_MS || 8000;
const REBUILD_MIN_SOURCES = 2;   // not worth synthesizing a profile from a single note
const profileTimers = new Map();   // userId -> timeout

// the durable notes a profile is built from — communication style ONLY: preferences/instructions
// SCOPED GLOBALLY (apply to every response). `fact`/`episode` notes stay out entirely, and a
// TOPICAL preference/instruction ("when discussing my health, add a disclaimer") stays out too —
// both are relevance-gated per-query by memoryBlock() in memory.js instead, so nothing narrow
// gets stated as always-true context in every unrelated conversation. `scope` defaults to global
// when missing (not yet backfilled) so nothing regresses mid-backfill — see ensureMemoryReady.
function profileSources(st) {
  const pref = st.memory.filter(m => m.type === "preference" && m.scope !== "topical");
  const inst = st.memory.filter(m => m.type === "instruction" && m.scope !== "topical");
  return { pref, inst, count: pref.length + inst.length };
}

// force=true → a user-initiated rebuild: synthesize from whatever notes exist (even 1–2).
// The REBUILD_MIN_SOURCES floor only throttles the AUTOMATIC daily rebuild so it doesn't churn.
async function rebuildProfile(user, { force = false } = {}) {
  const st = storesFor(user);
  const src = profileSources(st);
  if (!src.count) {
    // an EXPLICIT rebuild with nothing to build from means any existing profile is now stale (e.g.
    // every global note got deleted or rescoped to topical) — clear it so the caller can explain
    // why, instead of silently serving outdated content forever. The automatic/background path
    // (force=false) leaves a stale profile alone rather than blanking it on a transient dip.
    if (force && st.profile) { st.profile = null; st.save("profile.json"); }
    return st.profile || null;
  }
  if (!force && src.count < REBUILD_MIN_SOURCES) return st.profile || null;
  const section = (label, items) => items.length ? `${label}:\n` + items.map(m => `- ${m.text}`).join("\n") : "";
  const input = [
    section("Preferences", src.pref),
    section("Standing instructions", src.inst),
  ].filter(Boolean).join("\n\n").slice(0, 4000);
  let summary = "";
  try { summary = (await completeText(OLLAMA_MODEL, PROFILE_SYS, input, 220, 0.2) || "").trim(); } catch { return st.profile || null; }
  summary = summary.replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!summary) return st.profile || null;
  st.profile = { summary, traits: {}, updatedAt: Date.now(), sourceCount: src.count };
  st.save("profile.json");
  console.log(`[profile] rebuilt for ${user.id} from ${src.count} note(s)`);
  return st.profile;
}

// debounced rebuild — call after a preference/instruction changes, or on a daily tick
function scheduleProfileRebuild(user, delay = REBUILD_DEBOUNCE_MS) {
  clearTimeout(profileTimers.get(user.id));
  profileTimers.set(user.id, setTimeout(() => {
    profileTimers.delete(user.id);
    rebuildProfile(user).catch(e => console.error("profile:", e.message));
  }, delay));
}

// the injected block — a short stable prefix at the top of the agent system prompt
function profileBlock(user) {
  const st = user ? storesFor(user) : null;
  const p = st && st.profile;
  if (!p || !p.summary) return "";
  return "ABOUT THE USER (your evolving model of them — apply it, and keep it in mind without mentioning it unless asked):\n" + p.summary + "\n\n";
}

module.exports = { rebuildProfile, scheduleProfileRebuild, profileBlock, profileSources };
