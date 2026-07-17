/* Automated UI smoke — the frontend's safety net for the UI refactor.
   Builds the bundle, boots the server on a throwaway data dir, creates an admin,
   then drives headless Chrome over CDP (injecting the auth cookie) to visit each
   route. Fails a view on any console error / uncaught exception / empty #root,
   and writes a screenshot per view.

   Usage: node scripts/ui-smoke.mjs [--shots <dir>] [--keep]
   Env:   CHROME=/path/to/Chrome   PORT=5266   CDP=9223
*/
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import WebSocket from "ws";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = +(process.env.PORT || 5266);
const CDP = +(process.env.CDP || 9223);
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? process.argv[i + 1] : path.join(os.tmpdir(), "heapchat-ui-smoke"); })();
// route path → label (SPA reads location.pathname; "" = gallery home)
const ROUTES = [["", "gallery"], ["chat", "chat"], ["chats", "chats-hub"], ["kb", "knowledge-base"], ["manage", "manage"], ["activity", "activity"], ["settings", "settings"]];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, tries = 60, gap = 250) { for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); } throw new Error("poll timed out"); }

// minimal CDP client over one page target
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.on("message", buf => {
    const m = JSON.parse(buf);
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result); }
    else if (m.method) listeners.forEach(fn => fn(m));
  });
  const ready = new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
  return { ready, send, on: fn => listeners.push(fn), close: () => ws.close() };
}

async function main() {
  fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true });
  console.log("[ui-smoke] building bundle…");
  if (spawnSync(process.execPath, [path.join(ROOT, "build", "esbuild.mjs")], { stdio: "inherit" }).status !== 0) process.exit(1);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "heapchat-uismoke-data-"));
  const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), "heapchat-uismoke-chrome-"));
  const srv = spawn(process.execPath, [path.join(ROOT, "server.js")],
    { cwd: ROOT, env: { ...process.env, HEAPCHAT_DATA_DIR: dataDir, PORT: String(PORT), HOST: "127.0.0.1" }, stdio: "ignore" });
  let chrome;
  const rmQuiet = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} };
  const cleanup = () => { try { srv.kill(); } catch {} try { chrome && chrome.kill(); } catch {} if (!process.argv.includes("--keep")) { rmQuiet(dataDir); rmQuiet(chromeDir); } };
  process.on("exit", cleanup);

  await poll(async () => (await fetch(`${BASE}/api/auth/me`)).status >= 200);
  // create admin → grab the HttpOnly session cookie
  const r = await fetch(`${BASE}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "smoke", name: "Smoke", password: "smoke123" }) });
  const sid = String(r.headers.get("set-cookie") || "").match(/heapchat_sid=([^;]+)/)?.[1];
  if (!sid) throw new Error("no session cookie from /api/auth/setup");

  chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-allow-origins=*", `--remote-debugging-port=${CDP}`, `--user-data-dir=${chromeDir}`,
    "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  const pageWs = await poll(async () => {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
    const page = list.find(t => t.type === "page");
    return page && page.webSocketDebuggerUrl;
  });

  const c = cdp(pageWs); await c.ready;
  const errors = [];
  c.on(m => {
    if (m.method === "Runtime.exceptionThrown") errors.push("exception: " + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text || "?").split("\n")[0]);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error: " + m.params.args.map(a => a.value || a.description || "").join(" ").split("\n")[0]);
  });
  await c.send("Page.enable"); await c.send("Runtime.enable"); await c.send("Network.enable");
  await c.send("Network.setCookie", { name: "heapchat_sid", value: sid, domain: "127.0.0.1", path: "/", httpOnly: true });

  let pass = 0, fail = 0;
  for (const [route, label] of ROUTES) {
    errors.length = 0;
    await c.send("Page.navigate", { url: `${BASE}/${route}` });
    await sleep(1800);   // let React mount + async data settle
    const ev = await c.send("Runtime.evaluate", { expression: "({ kids: document.getElementById('root')?.childElementCount||0, title: document.title })", returnByValue: true });
    const { kids, title } = ev.result.value || {};
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(SHOTS, `${label}.png`), Buffer.from(shot.data, "base64"));
    const errs = [...new Set(errors)];
    const ok = kids > 0 && errs.length === 0;
    if (ok) { pass++; console.log(`  ✓ /${route.padEnd(9)} ${label} (root:${kids}, "${title}")`); }
    else { fail++; console.log(`  ✗ /${route.padEnd(9)} ${label} (root:${kids})`); errs.slice(0, 4).forEach(e => console.log(`       ${e}`)); }
  }
  // --chat: send a real message and wait for the streamed reply (exercises the
  // send loop, streaming, markdown render, and — if the model uses tools — the
  // agent trace). Uses whatever Ollama the server is configured for. Tolerant of
  // model latency (timeout = warn, not fail); a console error during streaming = fail.
  if (process.argv.includes("--chat")) {
    errors.length = 0;
    await c.send("Page.navigate", { url: `${BASE}/chat` });
    await sleep(1800);
    const set = await c.send("Runtime.evaluate", {
      expression: `(() => { const ta=document.querySelector('.composer textarea'); if(!ta) return 'no-textarea';
        const s=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; s.call(ta,'Reply with only the word: hello');
        ta.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`, returnByValue: true });
    if (set.result.value !== "ok") { console.log(`  ✗ chat-send: ${set.result.value}`); fail++; }
    else {
      await sleep(250);   // let React register the controlled value so .send-btn enables
      await c.send("Runtime.evaluate", { expression: `document.querySelector('.send-btn')?.click()` });
      let aiLen = 0;
      for (let i = 0; i < 60; i++) {   // up to ~60s for the model
        await sleep(1000);
        const r = await c.send("Runtime.evaluate", { expression: `(() => { const ai=[...document.querySelectorAll('.chat-inner .msg')].filter(m=>!m.classList.contains('user')); const l=ai[ai.length-1]; return l?l.textContent.trim().length:0; })()`, returnByValue: true });
        aiLen = r.result.value || 0;
        if (aiLen > 20) { await sleep(1500); break; }   // got a real reply; let it settle
      }
      const shot = await c.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, "chat-live.png"), Buffer.from(shot.data, "base64"));
      const errs = [...new Set(errors)];
      if (errs.length) { console.log(`  ✗ chat-send (console errors during streaming)`); errs.slice(0, 4).forEach(e => console.log(`       ${e}`)); fail++; }
      else if (aiLen > 20) { console.log(`  ✓ chat-send  (assistant replied, ${aiLen} chars, no console errors)`); pass++; }
      else { console.log(`  ⚠ chat-send  (no reply within 60s — model slow/offline; not failing)`); }
    }
  }

  c.close();
  console.log(`---\npass: ${pass}  fail: ${fail}   shots: ${SHOTS}`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error("[ui-smoke] error:", e.message); process.exit(2); });
