/* ============================================================
   Long-term memory — typed, per user (see AGENT-MEMORY.md).
   preference / instruction → always injected (tiny, keyed class)
   fact / episode           → retrieved top-K by similarity to the question
   Entries carry an embedding (computed once at write), provenance, and usage
   stats; near-duplicates of the same type are superseded, and the cap evicts by
   staleness/uselessness instead of age. Also hosts episodic-memory distillation
   (finished sessions → "past task" entries) and auto chat titles.
   ============================================================ */
const { OLLAMA_MODEL, OLLAMA_AGENT_MODEL } = require("../config");
const { storesFor } = require("../state/user-stores");
const { embed } = require("../rag/index");
const { cosine } = require("../rag/retrieve");
const { completeJSON, completeText } = require("./ollama");
const { addSkill, updateSkill } = require("./skills");
const { scheduleProfileRebuild } = require("./profile");

const MAX_MEMORIES = 200;
const MEM_TYPES = new Set(["preference", "fact", "instruction", "episode"]);
const MEM_ALWAYS = new Set(["preference", "instruction"]);
const MEM_TOPK = 4, MEM_FLOOR = 0.45, MEM_SUPERSEDE = 0.8, MEM_MAYBE = 0.55, MEM_BUDGET = 2400;   // budget ≈ 600 tokens
function guessMemType(t) {
  const s = String(t).toLowerCase();
  if (/\b(always|never|do not|don't|must|avoid|stop)\b/.test(s) && /\b(answer|reply|respond|use|show|format|ask|cite|delete|write|include)\b/.test(s)) return "instruction";
  if (/\b(prefer|prefers|likes?|loves?|favorite|favourite|style|format|tone|language|units?|concise|short|detailed|bullet)\b/.test(s)) return "preference";
  return "fact";
}
const memPublic = m => { const { vec, ...rest } = m; return rest; };
// migrate untyped legacy entries + backfill missing embeddings (lazy, batched, best-effort)
async function ensureMemoryReady(user) {
  const st = storesFor(user);
  let changed = false;
  for (const m of st.memory) {
    if (!MEM_TYPES.has(m.type)) { m.type = guessMemType(m.text); m.updatedAt = m.updatedAt || m.createdAt || Date.now(); changed = true; }
  }
  const missing = st.memory.filter(m => !m.vec);
  if (missing.length) {
    try { const vecs = await embed(missing.map(m => m.text)); missing.forEach((m, i) => { if (vecs[i]) m.vec = vecs[i]; }); changed = true; } catch {}
  }
  if (changed) st.save("memory.json");
}
async function addMemory(user, text, source = "manual", type = null, origin = null) {
  const st = storesFor(user);
  const t = String(text || "").trim();
  if (!t) return null;
  type = MEM_TYPES.has(type) ? type : guessMemType(t);
  const now = Date.now();
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const nt = norm(t);
  let vec = null; try { [vec] = await embed([t]); } catch {}
  // exact/substring duplicate → keep one, prefer the more detailed wording
  const dup = st.memory.find(m => { const nm = norm(m.text); return nm === nt || nm.includes(nt) || nt.includes(nm); });
  if (dup) {
    if (nt.length > norm(dup.text).length) { dup.text = t; dup.updatedAt = now; if (vec) dup.vec = vec; st.save("memory.json"); }
    return memPublic(dup);
  }
  // supersede: an update/correction of an existing same-type entry replaces it instead of stacking a contradiction.
  // Embeddings alone can't separate "updated fact" from "merely related fact" (measured: the two bands overlap
  // around 0.55–0.8), so clear paraphrases merge directly and the ambiguous band asks the model.
  if (vec) {
    let best = null, bs = 0;
    for (const m of st.memory) if (m.type === type && m.vec) { const s = cosine(vec, m.vec); if (s > bs) { bs = s; best = m; } }
    let replace = !!(best && bs >= MEM_SUPERSEDE);
    if (best && !replace && bs >= MEM_MAYBE) {
      try {
        const j = await completeJSON(OLLAMA_MODEL,
          'You maintain a user-memory store. Decide if note B is an UPDATE/correction of note A — the same subject with newer information (changed job, moved city, switched preference). If B is a different fact that should coexist with A (a different person, a different account, a different topic), it is not an update. Reply ONLY with JSON {"replace": true} or {"replace": false}.',
          `A: ${best.text}\nB: ${t}`, 40);
        replace = !!(j && j.replace === true);
      } catch {}
    }
    if (replace) {
      best.text = t; best.vec = vec; best.updatedAt = now; best.source = source;
      if (origin) best.origin = origin;
      st.save("memory.json");
      if (MEM_ALWAYS.has(type)) scheduleProfileRebuild(user);   // a changed preference/instruction → refresh the profile
      return memPublic(best);
    }
  }
  const m = { id: "m" + now + Math.random().toString(16).slice(2, 6), type, text: t, source, origin: origin || undefined,
    createdAt: now, updatedAt: now, lastUsedAt: 0, useCount: 0, vec };
  st.memory.unshift(m);
  if (st.memory.length > MAX_MEMORIES) {   // evict the stalest, least-used non-instruction entry
    const evictable = st.memory.filter(x => x.type !== "instruction");
    evictable.sort((a, b) => (a.useCount || 0) - (b.useCount || 0) || (a.lastUsedAt || a.updatedAt || 0) - (b.lastUsedAt || b.updatedAt || 0));
    if (evictable[0]) st.memory = st.memory.filter(x => x.id !== evictable[0].id);
  }
  st.save("memory.json");
  if (MEM_ALWAYS.has(type)) scheduleProfileRebuild(user);   // a new preference/instruction → refresh the profile
  return memPublic(m);
}
// fresh per-request system context so the model can resolve "today", "this week", file ages, etc.
function sysInfoBlock() {
  // DATE only (no clock time): the system prompt is the cached prefix Ollama reuses to skip
  // re-prefilling every turn — a per-minute timestamp would invalidate that cache each message.
  // Date is enough to resolve "today"/"yesterday"; it only changes once a day.
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const stamp = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return `\n\nCURRENT DATE: ${stamp} (${tz}). Resolve relative dates like "today", "yesterday", or "last month" against this — never guess the date from your training data.`;
}

// the prompt block: always-on instructions/preferences + the few facts/episodes relevant to THIS question
async function memoryBlock(user, query = "", recall = null) {   // recall: pass [] to learn which entries were injected
  const st = user ? storesFor(user) : null;
  if (!st || !st.memory.length) return "";
  await ensureMemoryReady(user);
  const always = st.memory.filter(m => MEM_ALWAYS.has(m.type));
  const pool = st.memory.filter(m => !MEM_ALWAYS.has(m.type));
  let picked = [];
  if (pool.length && String(query).trim()) {
    try {
      const [qv] = await embed([String(query).slice(0, 2000)]);
      picked = pool.filter(m => m.vec).map(m => ({ m, s: cosine(qv, m.vec) }))
        .filter(x => x.s >= MEM_FLOOR).sort((a, b) => b.s - a.s).slice(0, MEM_TOPK).map(x => x.m);
    } catch { picked = pool.slice(0, MEM_TOPK); }   // embeddings unavailable → degrade to the most recent few
  }
  const chosen = [...always, ...picked];
  if (!chosen.length) return "";
  const now = Date.now();
  chosen.forEach(m => { m.lastUsedAt = now; m.useCount = (m.useCount || 0) + 1; });
  st.save("memory.json");
  const lines = []; let used = 0;
  for (const m of chosen) {
    const line = `- [${m.type === "episode" ? "past task" : m.type}] ${m.text}`;
    if (used + line.length > MEM_BUDGET) break;
    lines.push(line); used += line.length;
    if (recall) recall.push({ type: m.type, text: m.text });
  }
  return "\n\nLong-term memory — things known about the user (apply when relevant):\n" + lines.join("\n");
}

/* ---------------- episodic memory: distill finished sessions into "past task" entries ----------------
   When a session has been idle for a while and contains a real task (≥4 user turns),
   one model call extracts a single reusable lesson — or nothing, for chit-chat. The
   result is stored as type "episode" and retrieved like any fact. (AGENT-MEMORY.md §3) */
const EPISODE_IDLE_MS = +process.env.EPISODE_IDLE_MS || 10 * 60 * 1000;
const EPISODE_MIN_TURNS = 4;
const EPISODE_SYS = 'You extract a reusable lesson from a finished assistant session. If it contains a completed task with durable, user-specific takeaways (how they like things done, decisions made, what worked), reply ONLY {"episode":"one dense factual sentence, max 40 words, starting with what was done"}. For chit-chat, one-off questions, general knowledge, or failed/abandoned tasks reply ONLY {"episode":null}. Never invent details.';
const episodeTimers = new Map();   // "userId:fileId:sessionId" -> timeout
function scheduleEpisode(user, fileId, sessionId) {
  const key = user.id + ":" + fileId + ":" + sessionId;
  clearTimeout(episodeTimers.get(key));
  episodeTimers.set(key, setTimeout(() => {
    episodeTimers.delete(key);
    // three passes off the same finished session, all independent + best-effort:
    //   (1) a reusable lesson (episode), (2) a reusable how-to (skill), and — if the user
    //   enabled it — (3) reflection: correct any existing skill/memory the session proved wrong.
    distillEpisode(user, fileId, sessionId).catch(e => console.error("episode:", e.message));
    distillSkill(user, fileId, sessionId).catch(e => console.error("skill:", e.message));
    reflectOnSession(user, fileId, sessionId).catch(e => console.error("reflect:", e.message));
  }, EPISODE_IDLE_MS));
}
async function distillEpisode(user, fileId, sessionId) {
  const st = storesFor(user);
  const s = (st.chats[fileId] || {})[sessionId];
  if (!s) return;
  if ((s.messages || []).filter(m => m.role === "user").length < EPISODE_MIN_TURNS) return;   // promotion gate: real tasks only
  if (s.episodeAt && s.episodeAt >= s.updatedAt) return;                                      // already distilled this state
  s.episodeAt = Date.now(); st.save("chats.json");                                            // mark first so a flaky model can't loop
  const transcript = (s.messages || []).slice(-24)
    .map(m => (m.role === "user" ? "USER: " : "ASSISTANT: ") + String(m.text || "").replace(/\s+/g, " ").slice(0, 280))
    .join("\n").slice(0, 3500);
  const j = await completeJSON(OLLAMA_MODEL, EPISODE_SYS, `SESSION TITLE: ${s.title || "(untitled)"}\n\n${transcript}`, 160);
  const ep = j && typeof j.episode === "string" && j.episode.trim();
  if (!ep) return;
  await addMemory(user, ep, "auto", "episode", { fileId, sessionId });
  console.log(`[memory] episode captured from "${s.title}"`);
}

/* ---------------- skill capture: distill a reusable how-to from a finished session ----------------
   The procedural sibling of distillEpisode (LEARNING-LOOP-PLAN A1). When a finished session worked
   out a repeatable, multi-step procedure, one model call emits a {title, steps, trigger} skill the
   agent can re-apply later. For chit-chat, one-off Q&A, or non-procedural tasks it emits null. */
const SKILL_SYS = 'You extract a REUSABLE how-to procedure from a finished assistant session. Only if the session worked out a repeatable, multi-step procedure the user is likely to need AGAIN (e.g. how to reconcile their statements from PDFs, how to format their weekly report, a workflow they established), reply ONLY with JSON {"skill":{"title":"short name","steps":"numbered Markdown how-to, concrete and repeatable","trigger":"one line: when to use this"}}. For chit-chat, one-off questions, general knowledge, simple lookups, or anything not a reusable procedure, reply ONLY {"skill":null}. Never invent steps the session did not actually establish.';
async function distillSkill(user, fileId, sessionId) {
  const st = storesFor(user);
  const s = (st.chats[fileId] || {})[sessionId];
  if (!s) return;
  if ((s.messages || []).filter(m => m.role === "user").length < EPISODE_MIN_TURNS) return;   // real tasks only
  if (s.skillAt && s.skillAt >= s.updatedAt) return;                                           // already processed this state
  s.skillAt = Date.now(); st.save("chats.json");                                               // mark first so a flaky model can't loop
  const transcript = (s.messages || []).slice(-24)
    .map(m => (m.role === "user" ? "USER: " : "ASSISTANT: ") + String(m.text || "").replace(/\s+/g, " ").slice(0, 320))
    .join("\n").slice(0, 4000);
  const j = await completeJSON(OLLAMA_MODEL, SKILL_SYS, `SESSION TITLE: ${s.title || "(untitled)"}\n\n${transcript}`, 400);
  const sk = j && j.skill;
  if (!sk || !sk.title || !sk.steps) return;
  await addSkill(user, { title: sk.title, steps: sk.steps, trigger: sk.trigger || "", source: "auto" });
  console.log(`[skills] captured "${sk.title}" from "${s.title}"`);
}

/* ---------------- reflection: self-correct memory & skills (LEARNING-LOOP-PLAN A3) ----------------
   Off by default (per-user `settings.reflection`). After a finished session, one model call checks the
   session against what the assistant already believes — and rewrites any existing durable note or saved
   skill the session proved WRONG or outdated. Corrections are applied in place (provenance "reflection")
   so the user can see/undo them in Manage. Conservative: references existing items by number; only
   rewrites when the session clearly contradicts them; never invents. */
const reflectionEnabled = user => { try { return storesFor(user).settings.reflection === true; } catch { return false; } };
const REFLECT_SYS = 'You audit a finished assistant session against what the assistant already believes about the user, to fix anything now WRONG or outdated. You get EXISTING NOTES (durable facts/preferences/instructions) and EXISTING SKILLS (saved procedures), each numbered (M1, M2… / S1, S2…). Using ONLY clear evidence from the SESSION, decide which existing items were contradicted, corrected, or improved. Reply ONLY with JSON {"memory":[{"ref":"M2","text":"the corrected note, one full sentence"}],"skills":[{"ref":"S1","steps":"the corrected how-to, numbered Markdown"}]}. Include an item ONLY if the session clearly shows the existing one is wrong/outdated/improvable — otherwise omit it. If nothing changed, reply {"memory":[],"skills":[]}. Never invent corrections or reference an item that is not listed.';
const refIndex = r => { const n = parseInt(String(r).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n - 1 : -1; };
async function reflectOnSession(user, fileId, sessionId) {
  if (!reflectionEnabled(user)) return;
  const st = storesFor(user);
  const s = (st.chats[fileId] || {})[sessionId];
  if (!s) return;
  if ((s.messages || []).filter(m => m.role === "user").length < EPISODE_MIN_TURNS) return;   // real tasks only
  if (s.reflectAt && s.reflectAt >= s.updatedAt) return;                                       // already reflected this state
  const mems = st.memory.filter(m => ["preference", "instruction", "fact"].includes(m.type)).slice(0, 12);
  const skills = (st.skills || []).slice(0, 12);
  if (!mems.length && !skills.length) return;                                                  // nothing to reflect against
  s.reflectAt = Date.now(); st.save("chats.json");                                             // mark first so a flaky model can't loop
  const memList = mems.map((m, i) => `M${i + 1} [${m.type}] ${m.text}`).join("\n") || "(none)";
  const skillList = skills.map((sk, i) => `S${i + 1} ${sk.title}${sk.trigger ? " — " + sk.trigger : ""}`).join("\n") || "(none)";
  const transcript = (s.messages || []).slice(-24)
    .map(m => (m.role === "user" ? "USER: " : "ASSISTANT: ") + String(m.text || "").replace(/\s+/g, " ").slice(0, 280))
    .join("\n").slice(0, 3500);
  const j = await completeJSON(OLLAMA_MODEL, REFLECT_SYS, `EXISTING NOTES:\n${memList}\n\nEXISTING SKILLS:\n${skillList}\n\nSESSION:\n${transcript}`, 500);
  if (!j) return;
  let applied = 0;
  for (const c of (Array.isArray(j.memory) ? j.memory : [])) {
    const m = mems[refIndex(c && c.ref)];
    const text = String((c && c.text) || "").trim();
    if (m && text && text.toLowerCase() !== m.text.toLowerCase()) {
      m.text = text; m.updatedAt = Date.now(); m.source = "reflection";
      try { [m.vec] = await embed([text]); } catch {}
      applied++;
    }
  }
  if (applied) st.save("memory.json");
  for (const c of (Array.isArray(j.skills) ? j.skills : [])) {
    const sk = skills[refIndex(c && c.ref)];
    const steps = String((c && c.steps) || "").trim();
    if (sk && steps && steps !== sk.steps) { await updateSkill(user, sk.id, { steps }); applied++; }
  }
  if (applied) console.log(`[reflect] corrected ${applied} item(s) from "${s.title}"`);
}

/* ---------------- auto chat titles ----------------
   After the first real exchange, name the chat from its content (like the big chat apps).
   Generated once, then `titleLocked` so repeat saves and manual renames are never clobbered. */
const TITLE_SYS = "You generate a concise title (3 to 6 words) summarizing what a chat is about, from its opening messages. Use Title Case. No surrounding quotes, no trailing punctuation, no preamble — reply with ONLY the title.";
const titleTimers = new Map();   // "userId:fileId:sessionId" -> timeout
// cancel every pending per-session timer (episode/skill/reflection distillation + auto-title) for a user.
// Called on "start fresh" so a queued idle pass can't fire against — or re-seed — just-wiped data.
function cancelUserTimers(user) {
  const prefix = user.id + ":";
  for (const [key, t] of episodeTimers) if (key.startsWith(prefix)) { clearTimeout(t); episodeTimers.delete(key); }
  for (const [key, t] of titleTimers) if (key.startsWith(prefix)) { clearTimeout(t); titleTimers.delete(key); }
}
function cleanTitle(t) {
  t = String(t || "").split("\n")[0].trim();
  t = t.replace(/^["'`*]+|["'`*]+$/g, "").replace(/[.?!,:;]+$/, "").trim();   // strip wrapping quotes/markdown + end punctuation
  return t.slice(0, 60);
}
function scheduleTitle(user, fileId, sessionId) {
  const key = user.id + ":" + fileId + ":" + sessionId;
  clearTimeout(titleTimers.get(key));
  titleTimers.set(key, setTimeout(() => {
    titleTimers.delete(key);
    generateTitle(user, fileId, sessionId).catch(e => console.error("title:", e.message));
  }, 1200));
}
async function generateTitle(user, fileId, sessionId) {
  const st = storesFor(user);
  const s = (st.chats[fileId] || {})[sessionId];
  if (!s || s.titleLocked) return;
  const msgs = s.messages || [];
  const userTurns = msgs.filter(m => m.role === "user" && String(m.text || "").trim());
  const hasAi = msgs.some(m => m.role === "ai" && String(m.text || "").trim());
  if (!userTurns.length || !hasAi) return;   // wait for a real question-and-answer before naming the chat
  if (userTurns.length > 2) return;           // only name a chat early on — never relabel an ongoing/older conversation
  const transcript = msgs.filter(m => String(m.text || "").trim()).slice(0, 6)
    .map(m => (m.role === "user" ? "USER: " : "ASSISTANT: ") + String(m.text).replace(/\s+/g, " ").slice(0, 400))
    .join("\n").slice(0, 2000);
  // reuse the model the chat just used so it's already warm (avoids a slow Ollama model swap)
  let titleModel = OLLAMA_MODEL;
  const customAgent = s.agentId ? (st.agents.find(a => a.id === s.agentId) || null) : null;
  if (customAgent && customAgent.model) titleModel = customAgent.model;
  else if (s.agentId || (s.source && s.source.scope === "agent")) titleModel = OLLAMA_AGENT_MODEL;
  const title = cleanTitle(await completeText(titleModel, TITLE_SYS, transcript, 24, 0.3));
  const s2 = (st.chats[fileId] || {})[sessionId];   // re-fetch: a manual rename may have landed while the model ran
  if (!s2 || s2.titleLocked || !title) return;
  s2.title = title; s2.titleLocked = true; st.save("chats.json");
  console.log(`[chat] auto-titled "${title}"`);
}

module.exports = {
  guessMemType, memPublic, ensureMemoryReady, addMemory, sysInfoBlock, memoryBlock,
  scheduleEpisode, distillEpisode, distillSkill, reflectOnSession, reflectionEnabled,
  scheduleTitle, generateTitle, cleanTitle, cancelUserTimers,
};
