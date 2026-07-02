#!/usr/bin/env node
/* eval/run.js — agent regression harness.
   Boots a throwaway Cortex instance in a temp dir (own data/, fixture KB),
   runs the golden questions through /api/agent, and scores the answers.

     node eval/run.js                  # all questions, models from .env
     node eval/run.js --model qwen2.5:latest
     node eval/run.js --filter invoice # only questions whose id matches

   Exit code 0 = every question passed. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : null; };
const MODEL = flag("model");
const FILTER = flag("filter");
const PORT = 5300 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const Q_TIMEOUT_MS = 240000;

// repo .env supplies the Ollama endpoint/models unless overridden
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m) env[m[1]] = m[2];
  }
} catch {}

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, "golden.json"), "utf8"))
  .filter(g => !FILTER || g.id.includes(FILTER));

async function main() {
  // ---- sandbox ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-eval-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"));
  fs.symlinkSync(path.join(ROOT, "public"), path.join(dir, "public"));
  fs.copyFileSync(path.join(ROOT, "server.js"), path.join(dir, "server.js"));
  // server.js delegates to modules under src/ — make them resolvable from the sandbox
  if (fs.existsSync(path.join(ROOT, "src"))) fs.symlinkSync(path.join(ROOT, "src"), path.join(dir, "src"));
  const agentModel = MODEL || env.OLLAMA_AGENT_MODEL || env.OLLAMA_MODEL || "llama3.1:8b";
  fs.writeFileSync(path.join(dir, ".env"), [
    // pin the data dir to the sandbox: src/ is symlinked, so config.js's __dirname
    // resolves to the real repo (Node follows symlinks) — without this the server
    // would read the real data/ instead of the isolated sandbox copy.
    `CORTEX_DATA_DIR=${path.join(dir, "data")}`,
    `PORT=${PORT}`,
    `OLLAMA_URL=${env.OLLAMA_URL || "http://localhost:11434"}`,
    `OLLAMA_MODEL=${agentModel}`,
    `OLLAMA_AGENT_MODEL=${agentModel}`,
    `OLLAMA_EMBED_MODEL=${env.OLLAMA_EMBED_MODEL || "nomic-embed-text:latest"}`,
  ].join("\n"));
  const child = spawn(process.execPath, ["server.js"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let serverLog = "";
  child.stdout.on("data", d => serverLog += d);
  child.stderr.on("data", d => serverLog += d);
  const cleanup = () => { try { child.kill(); } catch {} try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  process.on("exit", cleanup);

  // wait for boot
  let cookie = null;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 250));
    try { const r = await fetch(`${BASE}/api/auth/me`); if (r.status === 200 || r.status === 401) break; } catch {}
    if (i === 39) { console.error("server did not boot:\n" + serverLog); process.exit(2); }
  }
  {
    const r = await fetch(`${BASE}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "eval", password: "eval-pass" }) });
    cookie = (r.headers.get("set-cookie") || "").split(";")[0];
    if (!cookie) { console.error("setup failed"); process.exit(2); }
  }
  const api = (p, init = {}) => fetch(BASE + p, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers || {}) } });

  // fixture KB + index
  const cfg = await (await api("/api/config")).json();
  for (const f of fs.readdirSync(path.join(__dirname, "fixtures")))
    fs.copyFileSync(path.join(__dirname, "fixtures", f), path.join(cfg.kb, f));
  process.stdout.write(`model: ${agentModel} · indexing fixtures… `);
  await api("/api/index", { method: "POST", body: JSON.stringify({ path: cfg.kb }) });
  console.log("done\n");

  // ---- run questions ----
  async function ask(q) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Q_TIMEOUT_MS);
    try {
      const r = await api("/api/agent", { method: "POST", signal: ctl.signal, body: JSON.stringify({ scope: "kb", autoMemory: false, temperature: 0.2, messages: [{ role: "user", content: q }] }) });
      const raw = await r.text();
      let text = "", grounding = null, sources = [], revised = false;
      for (const line of raw.split("\n")) {
        let o; try { o = JSON.parse(line); } catch { continue; }
        if (o.message && o.message.content) text += o.message.content;
        if (o.revision && o.revision.text) { text = o.revision.text; revised = true; }
        if (o.grounding) grounding = o.grounding;
        if (o.sources) sources = o.sources.map(s => s.name);
      }
      return { text, grounding, sources, revised };
    } finally { clearTimeout(t); }
  }

  const results = [];
  for (const g of golden) {
    const started = Date.now();
    let res, err = null;
    try { res = await ask(g.q); } catch (e) { err = e.name === "AbortError" ? "timeout" : e.message; }
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const fails = [];
    if (err) fails.push("request failed: " + err);
    else {
      const t = res.text.toLowerCase();
      for (const pat of g.expect_contains || []) {
        if (!new RegExp(pat, "i").test(res.text)) fails.push(`missing: ${pat}`);
      }
      for (const pat of g.expect_not_contains || []) {
        if (new RegExp(pat, "i").test(res.text)) fails.push(`forbidden present: ${pat}`);
      }
      if (g.expect_grounded === true && (!res.grounding || res.grounding.mode !== "grounded")) fails.push(`not grounded (got ${res.grounding ? res.grounding.mode : "none"})`);
      if (g.expect_grounded === false && res.grounding && res.grounding.mode === "grounded") fails.push("grounded but should be general");
      if (g.expect_source && !res.sources.includes(g.expect_source)) fails.push(`source ${g.expect_source} not cited (got ${res.sources.join(",") || "none"})`);
      if (!t.trim()) fails.push("empty answer");
    }
    const pass = fails.length === 0;
    results.push({ id: g.id, pass, fails, secs, revised: res && res.revised, answer: res ? res.text.slice(0, 200) : "" });
    console.log(`${pass ? "✅" : "❌"} ${g.id.padEnd(22)} ${secs}s${res && res.revised ? " (self-corrected)" : ""}${pass ? "" : "\n     " + fails.join("; ") + "\n     answer: " + (res ? res.text.replace(/\s+/g, " ").slice(0, 140) : "")}`);
  }

  const passed = results.filter(r => r.pass).length;
  console.log(`\nscore: ${passed}/${results.length} (${Math.round(passed / results.length * 100)}%) · model: ${agentModel}`);
  try {
    fs.mkdirSync(path.join(__dirname, "results"), { recursive: true });
    fs.writeFileSync(path.join(__dirname, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}.json`),
      JSON.stringify({ model: agentModel, date: new Date().toISOString(), passed, total: results.length, results }, null, 2));
  } catch {}
  cleanup();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(2); });
