/* ============================================================
   Scheduled agents (LEARNING-LOOP-PLAN Part B). A single process-wide ticker
   runs saved agent jobs on a cadence and delivers the result to an activity
   feed (and optionally saves a note). Turns Cortex from reactive to proactive.

   Concurrency is 1 (a single local GPU serializes generation anyway): each tick
   runs at most one due job. Headless runs get NO destructive/interactive tools
   (HEADLESS_BLOCKED in core.js) — a scheduled run must never delete/rename files
   or block waiting on a human. The ticker also does a daily profile rebuild.
   ============================================================ */
const path = require("path");
const { storesFor, kbDirFor, projectKbDirFor } = require("../state/user-stores");
const { users } = require("../auth/accounts");
const { canAccessPath } = require("../auth/access");
const { OLLAMA_AGENT_MODEL } = require("../config");
const { agentSys, agentToolMechanics, runAgentTurn } = require("./core");
const { memoryBlock } = require("../llm/memory");
const { skillsBlock } = require("../llm/skills");
const { profileBlock, rebuildProfile } = require("../llm/profile");

const TICK_MS = +process.env.SCHEDULER_TICK_MS || 60 * 1000;
const MAX_DIGESTS = 200;
const PROFILE_REFRESH_MS = 24 * 60 * 60 * 1000;   // daily idle profile rebuild
const CADENCES = {                                 // preset → period in ms (avoids a cron dependency)
  hourly: 60 * 60 * 1000,
  every6h: 6 * 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};
const DEFAULT_CADENCE = "daily";

function cadenceMs(c) { return CADENCES[c] || CADENCES[DEFAULT_CADENCE]; }
// next run = now + period (anchored to "first run roughly one period out", or run-now if no nextRunAt yet)
function computeNextRun(job, from = Date.now()) { return from + cadenceMs(job.cadence); }

const jobPublic = j => ({ ...j });

// normalize an incoming job (create/update) — fills id, cadence, nextRunAt, delivery defaults
function normalizeJob(input = {}, existing = null) {
  const now = Date.now();
  const j = existing ? { ...existing } : { id: "j" + now + Math.random().toString(16).slice(2, 6), createdAt: now, lastRunAt: 0, lastResult: null };
  if (typeof input.name === "string") j.name = input.name.trim();
  if (typeof input.prompt === "string") j.prompt = input.prompt.trim();
  if ("agentId" in input) j.agentId = input.agentId || null;
  // what the job runs against: "kb" (knowledge base) | "project" | "folder" (any folder on disk)
  if (input.scope && ["kb", "project", "folder"].includes(input.scope)) j.scope = input.scope;
  if ("projectId" in input) j.projectId = input.projectId || null;
  if ("folderPath" in input) j.folderPath = input.folderPath ? String(input.folderPath) : null;
  if (typeof input.web === "boolean") j.web = input.web;
  if (typeof input.enabled === "boolean") j.enabled = input.enabled;
  if (input.cadence && CADENCES[input.cadence]) j.cadence = input.cadence;
  if (Array.isArray(input.deliver)) j.deliver = input.deliver.filter(d => ["feed", "note", "notify"].includes(d));
  j.name = j.name || "Scheduled task";
  // infer scope from whichever target is set (back-compat with jobs saved before scope existed)
  j.scope = j.scope || (j.folderPath ? "folder" : j.projectId ? "project" : "kb");
  if (j.scope !== "project") j.projectId = null;   // clear the targets that don't apply to the chosen scope
  if (j.scope !== "folder") j.folderPath = null;
  j.cadence = j.cadence || DEFAULT_CADENCE;
  j.enabled = j.enabled !== false;
  j.deliver = j.deliver && j.deliver.length ? j.deliver : ["feed"];
  j.web = !!j.web;
  // (re)arm the next run: run ~one cadence after a create/edit, unless the caller pinned a time
  if (typeof input.runNow === "boolean" && input.runNow) j.nextRunAt = now;
  else if (!j.nextRunAt || existing) j.nextRunAt = computeNextRun(j, now);
  return j;
}

// run one job headlessly and return { text, steps }
async function runJob(user, job) {
  const st = storesFor(user);
  const agent = job.agentId ? (st.agents || []).find(a => a.id === job.agentId) : null;
  const model = (agent && agent.model) || OLLAMA_AGENT_MODEL;
  const userKb = kbDirFor(user);

  // resolve what the job searches against. The agent always SAVES notes into the user's KB
  // (ctx.kbDir), but its file tools READ from the scope target (ctx.path/key).
  let searchDir = userKb, domainLabel = "the user's knowledge base";
  if (job.scope === "folder") {
    if (!job.folderPath) throw new Error("This schedule targets a folder, but no folder is set.");
    // re-check access on every run — a folder reachable at create time may have moved or been revoked
    if (!canAccessPath(user, job.folderPath)) throw new Error(`No access to the scheduled folder: ${job.folderPath}`);
    searchDir = path.resolve(job.folderPath);
    domainLabel = `the folder "${path.basename(searchDir)}"`;
  } else if (job.scope === "project") {
    const project = job.projectId ? (st.projects || []).find(p => p.id === job.projectId) : null;
    if (!project) throw new Error("This schedule targets a project that no longer exists.");
    searchDir = projectKbDirFor(user, project.id);
    domainLabel = `the "${project.name}" project`;
  }
  const ctx = { isFile: false, path: searchDir, key: searchDir, user, kbDir: userKb, model, convoImages: [] };

  const toolOpts = { user, files: true, memory: true, connectors: true, headless: true };
  const mechanics = agentToolMechanics({ autoMem: false, web: job.web, memory: true, connectors: true, user });
  const base = (agent && agent.systemPrompt && agent.systemPrompt.trim())
    ? agent.systemPrompt.trim() + "\n\n" + mechanics
    : agentSys(domainLabel, false, job.web, false, user, "");
  const role = profileBlock(user) +
    "You are running on a schedule, unattended — there is no user to ask. Be thorough and self-contained; produce a finished result the user can read later.\n\n" + base;

  // per-question memory + learned skills ride with the task (mirrors the live chat path)
  const memBlock = await memoryBlock(user, job.prompt).catch(() => "");
  const skillBlock = await skillsBlock(user, job.prompt).catch(() => "");
  const task = job.prompt + memBlock + skillBlock;

  const steps = [];
  const write = (o) => { if (o.step) steps.push({ name: o.step.name, args: o.step.args }); };
  const synthetic = { kind: "scheduled", label: job.name, role, tools: true, model, maxToolSteps: 6, maxTokens: 1600, temperature: 0.4 };
  const acc = { sources: new Map(), evidence: [], forceSources: new Set(), searched: false };
  const text = await runAgentTurn({ agent: synthetic, task, chosen: model, ctx, write, toolOpts, contextWindow: 0, web: job.web, richRender: false, acc });
  return { text: (text || "").trim(), steps, sources: [...acc.sources.values()] };
}

// deliver a finished run: push onto the activity feed and/or save a KB note
async function deliver(user, job, out) {
  const st = storesFor(user);
  const now = Date.now();
  // notify implies a feed record (the notification points at it). A feed entry carries the
  // notify flag; the renderer polls /api/notifications, fires the native ping, and marks it shown.
  const wantsNotify = job.deliver.includes("notify");
  if (job.deliver.includes("feed") || wantsNotify) {
    const entry = { id: "d" + now + Math.random().toString(16).slice(2, 6), jobId: job.id, jobName: job.name,
      text: out.text || "(no output)", steps: out.steps, createdAt: now,
      notify: wantsNotify, notified: false };
    st.digests.unshift(entry);
    if (st.digests.length > MAX_DIGESTS) st.digests.length = MAX_DIGESTS;
    st.save("digests.json");
  }
  if (job.deliver.includes("note") && out.text) {
    try {
      const { execTool } = require("./core");
      const kbDir = job.projectId ? projectKbDirFor(user, job.projectId) : kbDirFor(user);
      const stamp = new Date(now).toLocaleString();
      await execTool("save_note", { title: `${job.name} — ${stamp}`, text: out.text }, { user, kbDir, convoImages: [] });
    } catch (e) { console.error("[scheduler] note delivery:", e.message); }
  }
}

let running = false;   // concurrency 1 — never overlap GPU-bound runs
async function tick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    for (const u of users) {
      const st = storesFor(u);
      // run at most one due job per user per tick (keeps the loop fair + GPU serialized)
      const job = (st.jobs || []).find(j => j.enabled && (j.nextRunAt || 0) <= now);
      if (job) {
        console.log(`[scheduler] running job "${job.name}" for ${u.id}`);
        try {
          const out = await runJob(u, job);
          await deliver(u, job, out);
          job.lastRunAt = now; job.lastResult = { ok: true, summary: (out.text || "").slice(0, 200), at: now };
        } catch (e) {
          console.error(`[scheduler] job "${job.name}" failed:`, e.message);
          job.lastRunAt = now; job.lastResult = { ok: false, summary: e.message, at: now };
        }
        job.nextRunAt = computeNextRun(job, Date.now());
        st.save("jobs.json");
      }
      // daily idle profile rebuild
      const p = st.profile;
      if (!p || (now - (p.updatedAt || 0)) > PROFILE_REFRESH_MS) {
        rebuildProfile(u).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

let timer = null;
function startScheduler() {
  if (timer) return;
  timer = setInterval(() => { tick().catch(e => console.error("[scheduler] tick:", e.message)); }, TICK_MS);
  if (timer.unref) timer.unref();   // don't keep the process alive just for the ticker
  console.log(`[scheduler] started (tick every ${Math.round(TICK_MS / 1000)}s)`);
}

module.exports = { startScheduler, runJob, deliver, normalizeJob, jobPublic, CADENCES, tick };
