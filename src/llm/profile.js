/* ============================================================
   User profile — the synthesized "deepening model of you" (LEARNING-LOOP-PLAN A2).
   Memory is otherwise a flat list of notes; this consolidates the durable ones
   (preferences, instructions, top facts, recent past-task titles) into a few
   stable sentences that get injected at the TOP of the agent system prompt — a
   small, slow-changing block that's friendly to Ollama's cached prefix.

   Rebuilt lazily + debounced (never on every message): a few-second timer armed
   when a preference/instruction lands, plus a daily idle tick. Degrades to no
   block if the model/embeddings are unavailable, exactly like memory.js.
   ============================================================ */
const { OLLAMA_MODEL } = require("../config");
const { storesFor } = require("../state/user-stores");
const { completeText } = require("./ollama");

const PROFILE_SYS =
  "You maintain a concise profile of a user for an AI assistant — the stable picture of who they are and how they like to be helped. " +
  "From the notes below (their stated preferences, standing instructions, durable facts, and recent task lessons), write 2–4 plain sentences capturing: who they are / what they work on, how they like answers (tone, format, length), and any standing rules. " +
  "Write in the third person, present tense, starting with their name if known (e.g. \"Sid is …\"). Only state what the notes support — never invent details. No preamble, no bullet points, no headings — just the sentences.";

const REBUILD_DEBOUNCE_MS = +process.env.PROFILE_DEBOUNCE_MS || 8000;
const REBUILD_MIN_SOURCES = 3;   // not worth synthesizing a profile from one or two notes
const profileTimers = new Map();   // userId -> timeout

// the durable notes a profile is built from, most-signal first
function profileSources(st) {
  const pref = st.memory.filter(m => m.type === "preference");
  const inst = st.memory.filter(m => m.type === "instruction");
  const facts = st.memory.filter(m => m.type === "fact")
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 12);
  const episodes = st.memory.filter(m => m.type === "episode")
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 6);
  return { pref, inst, facts, episodes, count: pref.length + inst.length + facts.length + episodes.length };
}

// force=true → a user-initiated rebuild: synthesize from whatever notes exist (even 1–2).
// The REBUILD_MIN_SOURCES floor only throttles the AUTOMATIC daily rebuild so it doesn't churn.
async function rebuildProfile(user, { force = false } = {}) {
  const st = storesFor(user);
  const src = profileSources(st);
  if (!src.count) return st.profile || null;                       // nothing to build from at all
  if (!force && src.count < REBUILD_MIN_SOURCES) return st.profile || null;
  const section = (label, items) => items.length ? `${label}:\n` + items.map(m => `- ${m.text}`).join("\n") : "";
  const input = [
    section("Preferences", src.pref),
    section("Standing instructions", src.inst),
    section("Facts about them", src.facts),
    section("Recent task lessons", src.episodes),
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
