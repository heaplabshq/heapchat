import { fmt } from "./markdown.jsx";
import { Icon } from "./icons.jsx";
import { Reasoning } from "./chat-cards.jsx";
// settings.jsx — admin / settings page (Ollama)
const { useState: useStateS } = React;

// Base defaults; the live endpoint/model are merged in from /api/config at startup.
const DEFAULT_SETTINGS = {
  provider: "ollama",
  model: "",
  agentModel: "",
  embedModel: "",
  rerankModel: "",
  endpoint: "",
  thinking: false,
  factCheck: true,
  autoMemory: true,
  richRender: true,
  webSearch: false,
  placeLookup: false,
  autoExtract: false,
  imageGen: false,                 // enable the generate_image / edit_image tools
  imageBackend: "comfyui",         // "comfyui" (default) | "drawthings"
  comfyUrl: "http://localhost:8000",
  comfyModel: "",                  // optional default checkpoint filename; blank = auto-pick
  imageQuality: "fast",            // ComfyUI only: "fast" (SD, seconds) | "best" (Flux, minutes) — the agent can still ask for the other explicitly per request
  drawThingsUrl: "http://localhost:7860",
  drawThingsModel: "",             // optional default model; blank = use the model loaded in the app
  drawThingsSecret: "",            // optional shared secret if the server requires one
  imageSteps: 4,                   // sampling steps for create + edit (FLUX-fast models do well at 4; ComfyUI ignores this and uses its own default)
  imageGuidance: 1.5,              // guidance scale (low suits FLUX)
  imageWidth: 512,                 // default canvas size for /image-create (multiple of 64)
  imageHeight: 512,
  imageStrength: 0.99,             // edit (img2img) drift — lower keeps the source closer
  imageEditFullRes: false,         // edit at the source's original resolution (off = cap the longest side at 1024)
  imageEnhance: true,              // auto-enhance prompts by default
  imageDefaultsV: 2,               // bump to re-apply the steps/guidance/strength defaults over stale saved settings
  temperature: 0.7,
  maxTokens: 4096,
  contextWindow: 8192,
  topP: 0.9,
  facePhotoCount: 5,   // how many of a person's photos the agent analyzes when asked about their appearance
  systemPrompt:
    "You are Heap Chat, a helpful assistant that answers questions about the user's selected file. " +
    "Be concise, specific, and ground every answer in the file's actual content and metadata.",
};

function Slider({ label, hint, value, min, max, step, fmt, onChange }) {
  return (
    <div className="slider-row">
      <div className="slider-top">
        <div className="col" style={{ gap: 2 }}>
          <span className="field-label">{label}</span>
          {hint && <span className="field-hint">{hint}</span>}
        </div>
        <span className="slider-val">{fmt ? fmt(value) : value}</span>
      </div>
      <input className="range" type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))} />
    </div>
  );
}

// "nvidia/z-ai/glm-5.2" -> "z-ai/glm-5.2 · NVIDIA" for display — the prefix is an internal
// routing marker (src/llm/router.js) naming one of the live provider connections, not part of
// the real model id. Matched against the actual provider list (not a naive first-"/" split)
// since a provider's own model ids (like NVIDIA's) can contain slashes too.
function modelOptLabel(m, providers) {
  if (!m) return m;
  const hit = (providers || []).find(p => m.startsWith(p.id + "/"));
  return hit ? m.slice(hit.id.length + 1) + " · " + hit.name : m;
}

// Searchable model dropdown — a styled button that opens a dd-menu with a filter box once the
// list is long enough to need one. `allowDefault` adds a "use the chat's/parent's default" row
// that clears the value to "" (used for per-agent model overrides, which fall back otherwise).
function ModelSelect({ value, models, providers, onChange, allowDefault, defaultLabel = "Default" }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const opts = (models && models.length) ? models : (value ? [value] : []);
  const missing = value && !opts.includes(value);
  const full = missing ? [value, ...opts] : opts;
  const needle = q.trim().toLowerCase();
  const filtered = needle ? full.filter(m => modelOptLabel(m, providers).toLowerCase().includes(needle)) : full;
  const label = value ? (modelOptLabel(value, providers) + (missing ? " (not installed)" : "")) : defaultLabel;
  return (
    <div className="dropdown" style={{ position: "relative", display: "inline-block" }}>
      <button type="button" className="select mono" style={{ maxWidth: 360, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, cursor: "pointer" }}
        onClick={() => { setOpen(o => !o); setQ(""); }}>
        <span className="truncate">{label}</span>
        <Icon name="chevD" size={12} style={{ color: "var(--ink-3)", flexShrink: 0 }} />
      </button>
      {open && <>
        <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
        <div className="dd-menu" style={{ left: 0, right: "auto", width: 320, maxHeight: 320, overflow: "auto" }}>
          {full.length > 6 && (
            <div className="search" style={{ marginBottom: 6 }}>
              <Icon name="search" size={14} style={{ color: "var(--ink-3)" }} />
              <input autoFocus value={q} placeholder="Search models…" onChange={e => setQ(e.target.value)} />
              {q && <button className="btn icon sm ghost" onClick={() => setQ("")}><Icon name="x" size={12} /></button>}
            </div>
          )}
          {allowDefault && (
            <div className={"dd-item" + (!value ? " on" : "")} onClick={() => { onChange(""); setOpen(false); }}>
              <span style={{ fontSize: 12.5 }}>{defaultLabel}</span>
              {!value && <Icon name="check" size={14} style={{ marginLeft: "auto" }} />}
            </div>
          )}
          {full.length > 0 && filtered.length === 0 && <div className="t-xs ink-3" style={{ padding: "8px 10px" }}>No models match "{q}"</div>}
          {filtered.map(m => (
            <div key={m} className={"dd-item" + (m === value ? " on" : "")} onClick={() => { onChange(m); setOpen(false); }}>
              <span className="mono truncate" style={{ fontSize: 12.5 }}>{modelOptLabel(m, providers)}{missing && m === value ? " (not installed)" : ""}</span>
              {m === value && <Icon name="check" size={14} style={{ marginLeft: "auto", flexShrink: 0 }} />}
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}

function McpConnectors() {
  const [servers, setServers] = React.useState([]);
  const [form, setForm] = React.useState({ name: "", url: "", authHeader: "" });
  const [status, setStatus] = React.useState({});   // id -> {testing, ok, tools, error}

  function load() { fetch("/api/mcp").then(r => r.json()).then(j => setServers(j.servers || [])).catch(() => {}); }
  React.useEffect(() => { load(); }, []);

  async function add() {
    if (!form.url.trim()) return;
    const r = await fetch("/api/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }).then(r => r.json()).catch(() => null);
    if (r && r.id) { setServers(s => [...s, r]); setForm({ name: "", url: "", authHeader: "" }); test(r.id); }
  }
  async function toggle(s) {
    const r = await fetch("/api/mcp/" + s.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !s.enabled }) }).then(r => r.json()).catch(() => null);
    if (r) setServers(list => list.map(x => x.id === s.id ? r : x));
  }
  async function remove(id) {
    await fetch("/api/mcp/" + id, { method: "DELETE" }).catch(() => {});
    setServers(list => list.filter(x => x.id !== id));
  }
  async function test(id) {
    setStatus(st => ({ ...st, [id]: { testing: true } }));
    const r = await fetch("/api/mcp/" + id + "/test", { method: "POST" }).then(r => r.json()).catch(() => ({ ok: false, error: "request failed" }));
    setStatus(st => ({ ...st, [id]: { testing: false, ok: r.ok, tools: r.tools, error: r.error } }));
  }

  return (
    <div className="set-section">
      <div className="set-title"><Icon name="layers" size={18} style={{ color: "var(--accent)" }} /> Connectors (MCP)</div>
      <div className="set-sub">Point the agent at running MCP servers by URL. Enabled connectors' tools become available via the agent's list_connectors / use_connector tools.</div>

      <div className="col" style={{ gap: 8, marginBottom: 14 }}>
        <div className="row gap-2 wrap">
          <input className="input" style={{ flex: "1 1 160px" }} placeholder="Name (optional)" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <input className="input mono" style={{ flex: "2 1 260px", fontSize: 13 }} placeholder="https://host/mcp" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} />
        </div>
        <div className="row gap-2 wrap">
          <input className="input mono" style={{ flex: "2 1 260px", fontSize: 13 }} placeholder="Auth header e.g. Bearer xxx (optional)" value={form.authHeader} onChange={e => setForm(f => ({ ...f, authHeader: e.target.value }))} />
          <button className="btn primary" disabled={!form.url.trim()} onClick={add}><Icon name="plus" size={15} /> Add connector</button>
        </div>
      </div>

      {servers.length === 0 ? <div className="ink-3 t-sm">No connectors yet.</div> : (
        <div className="col" style={{ gap: 8 }}>
          {servers.map(s => {
            const st = status[s.id] || {};
            return (
              <div key={s.id} className="row-set">
                <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                  <span className="semi truncate">{s.name}{s.hasAuth ? <span className="img-badge" style={{ marginLeft: 6 }}>auth</span> : null}</span>
                  <span className="t-xs ink-3 mono truncate">{s.url}</span>
                  {st.testing && <span className="t-xs ink-3">testing…</span>}
                  {st.ok && <span className="t-xs" style={{ color: "var(--good)" }}>✓ online · {st.tools ? st.tools.length : 0} tools{st.tools && st.tools.length ? ": " + st.tools.slice(0, 6).map(t => t.name).join(", ") : ""}</span>}
                  {st.ok === false && <span className="t-xs" style={{ color: "var(--warn)" }}>offline: {st.error}</span>}
                </div>
                <div className="row gap-2 none">
                  <button className="btn sm" onClick={() => test(s.id)}>Test</button>
                  <button className={"toggle" + (s.enabled ? " on" : "")} title={s.enabled ? "Enabled" : "Disabled"} onClick={() => toggle(s)} />
                  <button className="btn icon sm ghost" onClick={() => remove(s.id)} style={{ color: "var(--warn)" }}><Icon name="x" size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DeepWorkAgents({ models, providers }) {
  const [roster, setRoster] = React.useState(null);
  const [openKind, setOpenKind] = React.useState(null);
  const [draft, setDraft] = React.useState({});      // kind -> edited fields (seeded on first open)
  const [saving, setSaving] = React.useState(null);
  const [msg, setMsg] = React.useState(null);
  function note(m) { setMsg(m); setTimeout(() => setMsg(null), 2000); }
  function load() { fetch("/api/roster").then(r => r.json()).then(j => setRoster(j.roster || [])).catch(() => {}); }
  React.useEffect(() => { load(); }, []);

  function edit(a) {
    setOpenKind(o => o === a.kind ? null : a.kind);
    setDraft(d => d[a.kind] ? d : ({ ...d, [a.kind]: { role: a.role, whenToUse: a.whenToUse, temperature: a.temperature, maxTokens: a.maxTokens, model: a.model || "", toolNames: [...(a.toolNames || [])] } }));
  }
  const setField = (kind, k, v) => setDraft(d => ({ ...d, [kind]: { ...d[kind], [k]: v } }));
  const toggleTool = (kind, name) => setDraft(d => { const cur = d[kind].toolNames || []; return { ...d, [kind]: { ...d[kind], toolNames: cur.includes(name) ? cur.filter(n => n !== name) : [...cur, name] } }; });

  async function put(kind, body) {
    setSaving(kind);
    const r = await fetch("/api/roster/" + kind, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => null);
    setSaving(null);
    if (r && r.roster) { setRoster(r.roster); note("Saved"); } else note("Could not save");
  }
  async function save(a) { const d = draft[a.kind] || {}; await put(a.kind, { role: d.role, whenToUse: d.whenToUse, temperature: d.temperature, maxTokens: d.maxTokens, model: d.model || "", ...(a.tools ? { toolNames: d.toolNames } : {}) }); }
  async function reset() {
    if (!window.confirm("Reset all Deep work agents to their defaults? Your prompt edits will be lost.")) return;
    const r = await fetch("/api/roster/reset", { method: "POST" }).then(r => r.json()).catch(() => null);
    if (r && r.roster) { setRoster(r.roster); setDraft({}); setOpenKind(null); note("Reset to defaults"); }
  }

  return (
    <div className="set-section">
      <div className="set-title"><Icon name="layers" size={18} style={{ color: "var(--accent)" }} /> Deep work agents</div>
      <div className="set-sub">The specialist team used by <b>Deep work</b> mode in chat. They take turns — an orchestrator picks who acts next given the work so far — then the Drafter writes the final answer. Tune each agent's prompt and sampling, pick the Researcher's tools, or turn one off. The Drafter always runs.</div>

      {roster === null ? <div className="ink-3 t-sm">Loading…</div> : (
        <div className="col" style={{ gap: 8 }}>
          {roster.map(a => {
            const open = openKind === a.kind, d = draft[a.kind] || {};
            return (
              <div key={a.kind} className="col" style={{ gap: 0, border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px" }}>
                <div className="row-set" style={{ border: "none", padding: 0 }}>
                  <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                    <span className="semi truncate">{a.label}{a.required ? <span className="img-badge" style={{ marginLeft: 6 }}>always on</span> : (!a.enabled ? <span className="img-badge" style={{ marginLeft: 6 }}>off</span> : null)}{a.model ? <span className="img-badge" style={{ marginLeft: 6 }} title={a.model}>{a.model.split("/").pop().split(":")[0]}</span> : null}</span>
                    <span className="t-xs ink-3 truncate">{a.whenToUse}</span>
                  </div>
                  <div className="row gap-2 none">
                    <button className="btn sm" onClick={() => edit(a)}>{open ? "Close" : "Edit"}</button>
                    <button className={"toggle" + (a.enabled ? " on" : "")} disabled={a.required} title={a.required ? "The Drafter always runs" : (a.enabled ? "Enabled" : "Disabled")} onClick={() => !a.required && put(a.kind, { enabled: !a.enabled })} />
                  </div>
                </div>
                {open && (
                  <div className="col" style={{ gap: 12, paddingTop: 12, marginTop: 10, borderTop: "1px solid var(--line)" }}>
                    <div className="field">
                      <span className="field-label">Role prompt</span>
                      <textarea className="textarea mono" style={{ fontSize: 12.5, minHeight: 120 }} value={d.role ?? a.role} onChange={e => setField(a.kind, "role", e.target.value)} />
                    </div>
                    <div className="field">
                      <span className="field-label">When the orchestrator should pick it</span>
                      <input className="input" value={d.whenToUse ?? a.whenToUse} onChange={e => setField(a.kind, "whenToUse", e.target.value)} />
                    </div>
                    <Slider label="Temperature" hint="Lower = focused/consistent, higher = creative" value={d.temperature ?? a.temperature} min={0} max={1} step={0.05} fmt={v => v.toFixed(2)} onChange={v => setField(a.kind, "temperature", v)} />
                    <div className="field">
                      <span className="field-label">Max tokens</span>
                      <input className="input" type="number" min={128} max={8192} step={64} style={{ maxWidth: 140 }} value={d.maxTokens ?? a.maxTokens} onChange={e => setField(a.kind, "maxTokens", parseInt(e.target.value) || a.maxTokens)} />
                    </div>
                    <div className="field">
                      <span className="field-label">Model</span>
                      <ModelSelect value={d.model ?? a.model ?? ""} models={models} providers={providers} allowDefault defaultLabel="Default — the chat's model"
                        onChange={m => setField(a.kind, "model", m)} />
                      <span className="field-hint">Run this agent on a different local model — e.g. a coding model for the Drafter. Leave on Default to use whatever model the chat is using.</span>
                    </div>
                    {a.tools && a.allToolNames && (
                      <div className="field">
                        <span className="field-label">Tools the Researcher may use</span>
                        <div className="row wrap" style={{ gap: 6 }}>
                          {a.allToolNames.map(n => {
                            const on = (d.toolNames ?? a.toolNames ?? []).includes(n);
                            return <button key={n} className="btn sm" onClick={() => toggleTool(a.kind, n)}
                              style={{ fontSize: 11, padding: "3px 9px", opacity: on ? 1 : .45, borderColor: on ? "var(--accent)" : undefined, color: on ? "var(--accent)" : undefined }}>{n}</button>;
                          })}
                        </div>
                      </div>
                    )}
                    <div className="row gap-2">
                      <button className="btn primary sm" disabled={saving === a.kind} onClick={() => save(a)}><Icon name="check" size={14} /> {saving === a.kind ? "Saving…" : "Save agent"}</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          <div className="row gap-2" style={{ marginTop: 4, alignItems: "center" }}>
            <button className="btn sm" onClick={reset}>Reset agents to defaults</button>
            {msg && <span className="t-xs ink-3">{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

function AccountSection({ account }) {
  const isAdmin = account && account.role === "admin";
  const [list, setList] = React.useState([]);
  const [form, setForm] = React.useState({ username: "", name: "", password: "", role: "user" });
  const [token, setToken] = React.useState(null);
  const [showToken, setShowToken] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const [grantDraft, setGrantDraft] = React.useState({ id: null, value: "" });   // folder-grant input per user
  const [net, setNet] = React.useState(null);   // { lanAccess, urls } — admin network toggle
  function note(m) { setMsg(m); setTimeout(() => setMsg(null), 2500); }
  function loadUsers() { fetch("/api/users").then(r => r.json()).then(j => setList(j.users || [])).catch(() => {}); }
  React.useEffect(() => {
    if (isAdmin) { loadUsers(); fetch("/api/admin/server").then(r => r.json()).then(setNet).catch(() => {}); }
    fetch("/api/auth/mcp-token").then(r => r.json()).then(j => setToken(j.token || null)).catch(() => {});
  }, []);
  async function toggleLan() {
    if (net && net.lanAccess && !window.confirm("Turn off network access? Phones and other devices using Heap Chat right now will be disconnected.")) return;
    const r = await fetch("/api/admin/server", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lanAccess: !(net && net.lanAccess) }) }).then(r => r.json()).catch(() => null);
    if (r) { setNet(r); note(r.lanAccess ? "Network access on" : "Network access off"); }
  }
  async function addUser() {
    const r = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) }).then(r => r.json()).catch(() => null);
    if (r && r.id) { setForm({ username: "", name: "", password: "", role: "user" }); loadUsers(); note(`Added ${r.username}`); }
    else note((r && r.error) || "Could not add user");
  }
  async function setFolders(u, folders) {
    const r = await fetch("/api/users/" + u.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folders }) }).then(r => r.json()).catch(() => null);
    if (r && r.id) setList(ls => ls.map(x => x.id === u.id ? r : x));
    else note((r && r.error) || "Could not update folders");
  }
  async function removeUser(u) {
    if (!window.confirm(`Delete user "${u.username}"? Their data stays on disk but they can no longer sign in.`)) return;
    await fetch("/api/users/" + u.id, { method: "DELETE" }).catch(() => {});
    loadUsers();
  }
  async function resetPw(u) {
    const p = window.prompt(`New password for ${u.username}:`);
    if (!p) return;
    const r = await fetch(`/api/users/${u.id}/password`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: p }) }).then(r => r.json()).catch(() => null);
    note(r && r.ok ? "Password updated" : (r && r.error) || "Failed");
  }
  async function clearChats() {
    if (!window.confirm("Delete ALL your saved conversations? This cannot be undone.")) return;
    const r = await fetch("/api/chats", { method: "DELETE" }).then(r => r.json()).catch(() => null);
    note(r && r.ok ? `Deleted ${r.deleted} conversation${r.deleted === 1 ? "" : "s"}` : "Could not clear chats");
  }
  async function resetEverything() {
    if (!window.confirm("Start completely fresh?\n\nThis permanently deletes your chats, memory, knowledge-base files, projects, people and connectors. Your custom agents and Deep work roster are kept. Your account stays, but the rest is erased.\n\nThis cannot be undone.")) return;
    if (!window.confirm("Are you absolutely sure? There is no undo.")) return;
    const r = await fetch("/api/account/data", { method: "DELETE" }).then(r => r.json()).catch(() => null);
    if (r && r.ok) { note("Everything deleted — your account is now empty"); setTimeout(() => window.location.reload(), 1200); }
    else note((r && r.error) || "Could not reset data");
  }
  async function regenToken() {
    if (!window.confirm("Regenerate your MCP token? Clients using the old token will stop working.")) return;
    const r = await fetch("/api/auth/mcp-token", { method: "POST" }).then(r => r.json()).catch(() => null);
    if (r && r.token) { setToken(r.token); setShowToken(true); note("New token generated"); }
  }
  function copyToken() { try { navigator.clipboard.writeText(token || ""); note("Token copied"); } catch {} }

  return (
    <div className="set-section">
      <div className="set-title"><Icon name="layers" size={18} style={{ color: "var(--accent)" }} /> Account{isAdmin ? " & users" : ""}</div>
      <div className="set-sub">Signed in as <b>{account ? account.user : "…"}</b>{isAdmin ? " (admin)" : ""}. Each user has their own knowledge base, chats, memory, and connectors.</div>

      <div className="field">
        <span className="field-label">Chat history</span>
        <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
          <button className="btn sm" style={{ color: "var(--warn)" }} onClick={clearChats}><Icon name="x" size={13} /> Clear all chats</button>
          <span className="field-hint">Permanently deletes every saved conversation in your account (yours only — other users keep theirs).</span>
        </div>
      </div>

      <div className="field" style={{ marginTop: 6, padding: 12, border: "1px solid var(--warn)", borderRadius: 10 }}>
        <span className="field-label" style={{ color: "var(--warn)" }}>Start fresh</span>
        <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
          <button className="btn sm" style={{ color: "var(--warn)" }} onClick={resetEverything}><Icon name="alert" size={13} /> Reset everything</button>
          <span className="field-hint">Erases your chats, memory, knowledge base, projects, people and connectors — and resets the account to a clean slate. Your <b>custom agents</b> and <b>Deep work roster</b> are kept, and your sign-in stays. <b>Cannot be undone.</b></span>
        </div>
      </div>

      <div className="field">
        <span className="field-label">MCP token</span>
        <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
          <span className="mono t-sm" style={{ padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--surface-2)", userSelect: "all" }}>
            {token ? (showToken ? token : "•".repeat(16)) : "…"}
          </span>
          <button className="btn sm" onClick={() => setShowToken(s => !s)}>{showToken ? "Hide" : "Show"}</button>
          <button className="btn sm" onClick={copyToken}><Icon name="copy" size={13} /> Copy</button>
          <button className="btn sm" onClick={regenToken}><Icon name="refresh" size={13} /> Regenerate</button>
        </div>
        <span className="field-hint">Lets MCP clients query <b>your</b> knowledge base: <span className="mono">claude mcp add --transport http heapchat http://localhost:5174/mcp --header "Authorization: Bearer &lt;token&gt;"</span></span>
      </div>

      {isAdmin && (
        <>
          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">Network access</span>
            <div className="row-set">
              <div className="col" style={{ gap: 3, minWidth: 0 }}>
                <span className="field-hint">When on, other devices on your Wi-Fi can reach Heap Chat (everyone still has to sign in). Applies instantly — no restart.</span>
                {net && net.lanAccess && net.urls.map(u => <span key={u} className="t-xs mono" style={{ color: "var(--good)" }}>{u}</span>)}
              </div>
              <button className={"toggle" + (net && net.lanAccess ? " on" : "")} onClick={toggleLan} aria-label="Toggle network access" />
            </div>
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">Users</span>
            <div className="col" style={{ gap: 10 }}>
              {list.map(u => (
                <div key={u.id} className="col" style={{ gap: 6, padding: "10px 12px", border: "1px solid var(--line)", borderRadius: 10 }}>
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                      <span className="semi truncate">{u.name} <span className="t-xs ink-3 mono">@{u.username}</span>{u.role === "admin" && <span className="img-badge" style={{ marginLeft: 6 }}>admin</span>}</span>
                    </div>
                    <div className="row gap-2 none">
                      <button className="btn sm" onClick={() => resetPw(u)}>Reset password</button>
                      {u.id !== account.userId && <button className="btn icon sm ghost" title="Delete user" onClick={() => removeUser(u)} style={{ color: "var(--warn)" }}><Icon name="x" size={15} /></button>}
                    </div>
                  </div>
                  {u.role === "admin" ? (
                    <span className="t-xs ink-3"><Icon name="folder" size={11} /> Full disk access (admin)</span>
                  ) : (
                    <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                      <span className="t-xs ink-3 none"><Icon name="folder" size={11} /> Folders:</span>
                      {(u.folders || []).length === 0 && <span className="t-xs ink-4">none — private KB only</span>}
                      {(u.folders || []).map(f => (
                        <span key={f} className="chip mono" style={{ fontSize: 11 }} title={f}>
                          {f.split("/").filter(Boolean).slice(-1)[0] || f}
                          <button className="side-chats-clear" style={{ marginLeft: 4 }} title={"Remove access to " + f}
                            onClick={() => setFolders(u, (u.folders || []).filter(x => x !== f))}><Icon name="x" size={10} /></button>
                        </span>
                      ))}
                      <input className="input mono" style={{ flex: "1 1 180px", fontSize: 11.5, padding: "4px 8px" }} placeholder="/path/to/grant — Enter to add"
                        value={grantDraft.id === u.id ? grantDraft.value : ""}
                        onChange={e => setGrantDraft({ id: u.id, value: e.target.value })}
                        onKeyDown={e => { if (e.key === "Enter" && grantDraft.value.trim()) { setFolders(u, [...(u.folders || []), grantDraft.value.trim()]); setGrantDraft({ id: null, value: "" }); } }} />
                    </div>
                  )}
                </div>
              ))}
            </div>
            <span className="field-hint">Members see only their private knowledge base plus the folder roots you grant here (subfolders included). Admins see the whole disk.</span>
          </div>
          <div className="field">
            <span className="field-label">Add user</span>
            <div className="row gap-2 wrap">
              <input className="input" style={{ flex: "1 1 120px" }} placeholder="username" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} autoCapitalize="none" />
              <input className="input" style={{ flex: "1 1 120px" }} placeholder="Display name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              <input className="input" style={{ flex: "1 1 120px" }} type="password" placeholder="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} autoComplete="new-password" />
              <select className="select" style={{ width: 100 }} value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="user">user</option><option value="admin">admin</option>
              </select>
              <button className="btn primary" disabled={!form.username.trim() || form.password.length < 4} onClick={addUser}><Icon name="plus" size={15} /> Add</button>
            </div>
            <span className="field-hint">Every signed-in user can browse this machine's folders; only their KB, chats, memory, and connectors are private.</span>
          </div>
        </>
      )}
      {msg && <div className="t-xs" style={{ color: "var(--good)", marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

function ImageGenSection({ settings, set }) {
  const [test, setTest] = React.useState(null);   // null | {testing} | {ok, models, error}
  const backend = settings.imageBackend === "drawthings" ? "drawthings" : "comfyui";
  async function runTest() {
    setTest({ testing: true });
    const endpoint = backend === "drawthings" ? "/api/drawthings/test" : "/api/comfyui/test";
    const body = backend === "drawthings"
      ? { url: settings.drawThingsUrl, secret: settings.drawThingsSecret }
      : { url: settings.comfyUrl };
    const r = await fetch(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(r => r.json()).catch(() => ({ ok: false, error: "request failed" }));
    setTest({ testing: false, ...r });
  }
  return (
    <div className="set-section">
      <div className="set-title row gap-2" style={{ alignItems: "center" }}>
        <Icon name="image" size={18} style={{ color: "var(--accent)" }} /> Image generation
        <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: "var(--accent)", background: "var(--accent-soft)", border: "1px solid var(--accent)", borderRadius: 999, padding: "2px 8px" }}>Experimental · Beta</span>
      </div>
      <div className="set-sub">Let the agent create and edit images with a local image server — <b>ComfyUI</b> (default) or <b>Draw Things</b>. Adds the <span className="mono">generate_image</span> and <span className="mono">edit_image</span> tools. Fully local — nothing leaves your machine.</div>

      <div className="row-set">
        <div className="col" style={{ gap: 3 }}>
          <span className="field-label">Enable image generation</span>
          <span className="field-hint">When on, the agent can generate images from a prompt and edit images you attach or have in your library.</span>
        </div>
        <button className={"toggle" + (settings.imageGen ? " on" : "")} onClick={() => set({ imageGen: !settings.imageGen })} aria-label="Toggle image generation" />
      </div>

      {settings.imageGen && (
        <>
          <div className="field" style={{ marginTop: 18 }}>
            <span className="field-label">Backend</span>
            <div className="row gap-2" style={{ marginTop: 4 }}>
              <button className={"btn sm" + (backend === "comfyui" ? " primary" : "")} onClick={() => { setTest(null); set({ imageBackend: "comfyui" }); }}>ComfyUI</button>
              <button className={"btn sm" + (backend === "drawthings" ? " primary" : "")} onClick={() => { setTest(null); set({ imageBackend: "drawthings" }); }}>Draw Things</button>
            </div>
          </div>

          {backend === "comfyui" ? (
            <>
              <div className="field">
                <span className="field-label">ComfyUI server URL</span>
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <input className="input mono" style={{ maxWidth: 320, fontSize: 13 }} placeholder="http://localhost:8000"
                    value={settings.comfyUrl || ""} onChange={e => set({ comfyUrl: e.target.value })} />
                  <button className="btn sm" onClick={runTest} disabled={test && test.testing}>
                    <Icon name={test && test.testing ? "clock" : "refresh"} size={13} /> {test && test.testing ? "Testing…" : "Test connection"}
                  </button>
                </div>
                {test && !test.testing && test.ok && (
                  <span className="t-xs" style={{ color: "var(--good)" }}>
                    ✓ Connected{test.models && test.models.length ? ` · ${test.models.length} checkpoint(s): ${test.models.slice(0, 8).join(", ")}` : " · no checkpoints reported"}
                  </span>
                )}
                {test && !test.testing && !test.ok && <span className="t-xs" style={{ color: "var(--warn)" }}>✗ {test.error || "unreachable"}</span>}
              </div>

              <div className="field">
                <span className="field-label">Default checkpoint <span className="ink-3">(optional)</span></span>
                <input className="input mono" style={{ maxWidth: 360, fontSize: 13 }} placeholder="e.g. realisticVisionV60B1_v60B1VAE.safetensors — blank = auto-pick"
                  value={settings.comfyModel || ""} onChange={e => set({ comfyModel: e.target.value })} />
                <span className="field-hint">The checkpoint filename as ComfyUI knows it (use Test connection to discover names). Blank = the first image checkpoint found.</span>
              </div>

              <div className="field">
                <span className="field-label">Quality</span>
                <div className="row gap-2" style={{ marginTop: 4 }}>
                  <button className={"btn sm" + ((settings.imageQuality || "fast") === "fast" ? " primary" : "")} onClick={() => set({ imageQuality: "fast" })}>Fast</button>
                  <button className={"btn sm" + (settings.imageQuality === "best" ? " primary" : "")} onClick={() => set({ imageQuality: "best" })}>Best (Flux)</button>
                </div>
                <span className="field-hint">
                  {(settings.imageQuality || "fast") === "fast"
                    ? "The default checkpoint above — a few seconds per image."
                    : "Flux.2 Klein — sharper results and edits that only change what you asked, but takes a few minutes per image."}
                  {" "}The agent can still ask for the other tier when it makes sense for your request.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <span className="field-label">Draw Things HTTP endpoint</span>
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <input className="input mono" style={{ maxWidth: 320, fontSize: 13 }} placeholder="http://localhost:7860"
                    value={settings.drawThingsUrl || ""} onChange={e => set({ drawThingsUrl: e.target.value })} />
                  <button className="btn sm" onClick={runTest} disabled={test && test.testing}>
                    <Icon name={test && test.testing ? "clock" : "refresh"} size={13} /> {test && test.testing ? "Testing…" : "Test connection"}
                  </button>
                </div>
                <span className="field-hint">In the app, turn on <span className="mono">Advanced → API Server</span> with <b>Protocol: HTTP</b> (default port 7860).</span>
                {test && !test.testing && test.ok && (
                  <span className="t-xs" style={{ color: "var(--good)" }}>
                    ✓ Connected{test.models && test.models.length ? ` · ${test.models.length} model(s): ${test.models.slice(0, 8).join(", ")}` : " · no models reported"}
                  </span>
                )}
                {test && !test.testing && !test.ok && <span className="t-xs" style={{ color: "var(--warn)" }}>✗ {test.error || "unreachable"}</span>}
                {test && !test.testing && test.sharedSecretMissing && <span className="t-xs" style={{ color: "var(--warn)" }}>Server requires a shared secret — set it below.</span>}
              </div>

              <div className="field">
                <span className="field-label">Default model <span className="ink-3">(optional)</span></span>
                <input className="input mono" style={{ maxWidth: 360, fontSize: 13 }} placeholder="e.g. sd_v1.5_f16.ckpt — blank = auto-pick"
                  value={settings.drawThingsModel || ""} onChange={e => set({ drawThingsModel: e.target.value })} />
                <span className="field-hint">The model filename as the server knows it (use Test connection to discover names). Blank = use the first installed model.</span>
              </div>

              <div className="field">
                <span className="field-label">Shared secret <span className="ink-3">(optional)</span></span>
                <input className="input mono" type="password" style={{ maxWidth: 360, fontSize: 13 }} placeholder="only if your server requires one"
                  value={settings.drawThingsSecret || ""} onChange={e => set({ drawThingsSecret: e.target.value })} />
              </div>
              <div className="set-sub" style={{ color: "var(--warn)" }}><b>Beta:</b> edit quality depends on Draw Things, which can't clear its canvas over the API — results may vary.</div>
            </>
          )}

          <div className="field">
            <span className="field-label">Generation defaults</span>
            <span className="field-hint">Used by <span className="mono">/image-create</span>, <span className="mono">/image-edit</span>, and the Edit-with-AI dialog. Editing regenerates the image text-to-image, so size follows the source.</span>
            <div className="row gap-3 wrap" style={{ marginTop: 8 }}>
              {backend === "drawthings" && (
                <>
                  <label className="col" style={{ gap: 3 }}>
                    <span className="t-xs ink-3">Steps</span>
                    <input className="input" type="number" min={1} max={150} style={{ width: 90, fontSize: 13 }}
                      value={settings.imageSteps ?? 4} onChange={e => set({ imageSteps: Math.max(1, Math.min(150, +e.target.value || 4)) })} />
                  </label>
                  <label className="col" style={{ gap: 3 }}>
                    <span className="t-xs ink-3">Guidance</span>
                    <input className="input" type="number" min={0} max={30} step={0.5} style={{ width: 90, fontSize: 13 }}
                      value={settings.imageGuidance ?? 7.5} onChange={e => set({ imageGuidance: Math.max(0, Math.min(30, +e.target.value || 7.5)) })} />
                  </label>
                </>
              )}
              <label className="col" style={{ gap: 3 }}>
                <span className="t-xs ink-3">Width</span>
                <input className="input" type="number" min={64} max={2048} step={64} style={{ width: 100, fontSize: 13 }}
                  value={settings.imageWidth ?? 512} onChange={e => set({ imageWidth: Math.max(64, Math.min(2048, Math.round((+e.target.value || 512) / 64) * 64)) })} />
              </label>
              <label className="col" style={{ gap: 3 }}>
                <span className="t-xs ink-3">Height</span>
                <input className="input" type="number" min={64} max={2048} step={64} style={{ width: 100, fontSize: 13 }}
                  value={settings.imageHeight ?? 512} onChange={e => set({ imageHeight: Math.max(64, Math.min(2048, Math.round((+e.target.value || 512) / 64) * 64)) })} />
              </label>
            </div>
            {(backend === "comfyui" && settings.imageQuality === "best") ? (
              <div className="t-xs ink-3" style={{ marginTop: 12, maxWidth: 420 }}>Flux edits precisely apply what you ask for and leave everything else untouched — there's no "strength" knob for this tier.</div>
            ) : (
              <label className="col" style={{ gap: 3, marginTop: 12, maxWidth: 420 }}>
                <span className="t-xs ink-3">Edit strength — how much an edit changes the original ({Math.round((settings.imageStrength ?? 0.7) * 100)}%)</span>
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <span className="t-xs ink-4" style={{ flex: "none" }}>Keep original</span>
                  <input type="range" min={0.05} max={1} step={0.01} style={{ flex: 1 }}
                    value={settings.imageStrength ?? 0.7} onChange={e => set({ imageStrength: +e.target.value })} />
                  <span className="t-xs ink-4" style={{ flex: "none" }}>Reimagine</span>
                </div>
              </label>
            )}
          </div>

          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Edit at original resolution</span>
              <span className="field-hint">When off, edits downscale the source so its longest side is at most 1024px (faster, less memory). When on, the image is edited at its original size — larger and slower, and very large photos may fail.</span>
            </div>
            <button className={"toggle" + (settings.imageEditFullRes ? " on" : "")} onClick={() => set({ imageEditFullRes: !settings.imageEditFullRes })} aria-label="Toggle original-resolution edits" />
          </div>

          <div className="row-set" style={{ marginBottom: 0 }}>
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Enhance prompts by default</span>
              <span className="field-hint">Rewrite short prompts into vivid, detailed ones with your chat model before generating. You can still override per-edit.</span>
            </div>
            <button className={"toggle" + (settings.imageEnhance !== false ? " on" : "")} onClick={() => set({ imageEnhance: !(settings.imageEnhance !== false) })} aria-label="Toggle prompt enhancement" />
          </div>
        </>
      )}
    </div>
  );
}

// shared "test connection" probe — hits the given base URL/key live and returns its model list
// ({ ok, models, error }), used both to validate a connection and to populate the model picker
// before the connection is even saved. type: "ollama" (native /api/tags) | "openai" (GET /models).
async function testProviderConnection(type, baseUrl, apiKey) {
  return fetch("/api/admin/providers/test", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, baseUrl, apiKey }),
  }).then(r => r.json()).catch(() => ({ ok: false, error: "Request failed" }));
}

// the built-in Ollama connection: base URL + an optional API key (for a secured/proxied
// Ollama-compatible endpoint — plain local Ollama needs neither). Same test → save flow as
// every other provider below, it's just not removable.
function OllamaConnectionField({ ollamaInfo, online, onSaved }) {
  const [open, setOpen] = React.useState(false);
  const [form, setForm] = React.useState({ baseUrl: "", apiKey: "" });
  const [test, setTest] = React.useState(null);   // "busy" | { ok, models, error } | null
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  function note(m) { setMsg(m); setTimeout(() => setMsg(null), 2500); }

  function toggleOpen() {
    if (open) { setOpen(false); return; }
    setOpen(true); setTest(null);
    setForm({ baseUrl: (ollamaInfo && ollamaInfo.baseUrl) || "", apiKey: "" });
  }
  async function runTest() { setTest("busy"); setTest(await testProviderConnection("ollama", form.baseUrl, form.apiKey)); }
  async function save() {
    setBusy(true);
    const body = { baseUrl: form.baseUrl.trim() };
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();   // blank = leave the existing key untouched
    const r = await fetch("/api/admin/providers/ollama", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => null);
    setBusy(false);
    if (r) { onSaved(r); setForm(f => ({ ...f, apiKey: "" })); note("Saved — reload to see it everywhere"); }
    else note("Could not save");
  }

  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <span className="t-sm semi">Ollama <span className="ink-3" style={{ fontWeight: 400 }}>· local</span></span>
        <span className="t-xs row gap-1" style={{ color: online ? "var(--good)" : "var(--warn)" }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: online ? "var(--good)" : "var(--warn)" }} />
          {online ? "Connected" : "Offline"}
        </span>
        <span className="mono t-xs ink-3">{ollamaInfo && ollamaInfo.baseUrl}</span>
        <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={toggleOpen}>{open ? "Close" : "Edit connection"}</button>
      </div>

      {open && (
        <div className="col" style={{ gap: 8, padding: 12, border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-2)" }}>
          <span className="field-label">Base URL</span>
          <input className="input mono" placeholder="http://localhost:11434" value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} />
          <span className="field-label">API key <span className="ink-3" style={{ fontWeight: 400 }}>(only if this endpoint requires one)</span></span>
          <input className="input mono" type="password" placeholder={ollamaInfo && ollamaInfo.hasKey ? "Leave blank to keep the current key" : "optional"}
            value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} />
          <div className="row gap-2">
            <button className="btn sm" disabled={test === "busy" || !form.baseUrl.trim()} onClick={runTest}>{test === "busy" ? "Testing…" : "Test connection"}</button>
            <button className="btn sm primary" disabled={busy || !form.baseUrl.trim()} onClick={save}>{busy ? "Saving…" : "Save connection"}</button>
          </div>
          {test && test !== "busy" && (test.ok
            ? <span className="t-sm" style={{ color: "var(--good)" }}>Connected — {test.models.length} model{test.models.length === 1 ? "" : "s"} found{test.models.length ? ": " + test.models.slice(0, 6).join(", ") + (test.models.length > 6 ? "…" : "") : ""}</span>
            : <span className="t-sm" style={{ color: "var(--warn)" }}>Couldn't connect — {test.error}</span>)}
        </div>
      )}
      {msg && <span className="field-hint" style={{ color: "var(--accent)" }}>{msg}</span>}
    </div>
  );
}

// one OpenAI-compatible provider connection — either an existing one (provider set) or a blank
// "add new" card (provider null). Same test → pick models → save flow throughout.
// popular OpenAI-compatible providers — a one-click starting point in "Add provider" so the admin
// doesn't have to go look up a base URL. Every field stays fully editable after picking one (e.g.
// to point at a regional/enterprise variant), and picking one is entirely optional.
const PROVIDER_PRESETS = [
  { name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1" },
  { name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
  { name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { name: "Together AI", baseUrl: "https://api.together.xyz/v1" },
  { name: "Fireworks AI", baseUrl: "https://api.fireworks.ai/inference/v1" },
  { name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { name: "Mistral", baseUrl: "https://api.mistral.ai/v1" },
  { name: "xAI (Grok)", baseUrl: "https://api.x.ai/v1" },
  { name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1" },
];

function ProviderCard({ provider, onSaved, onDeleted, onCancelNew }) {
  const isNew = !provider;
  const [open, setOpen] = React.useState(isNew);
  const [form, setForm] = React.useState({ name: provider ? provider.name : "", baseUrl: provider ? provider.baseUrl : "", apiKey: "" });
  const [test, setTest] = React.useState(null);
  const [selected, setSelected] = React.useState(() => new Set(provider ? provider.models : []));
  const [agentModel, setAgentModel] = React.useState(provider ? provider.agentModel : "");
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);
  const [modelQuery, setModelQuery] = React.useState("");
  function note(m) { setMsg(m); setTimeout(() => setMsg(null), 2500); }

  const discovered = (test && test.ok) ? test.models : (provider ? provider.models : []);
  const needle = modelQuery.trim().toLowerCase();
  const shownModels = needle ? discovered.filter(m => m.toLowerCase().includes(needle)) : discovered;

  async function runTest() {
    setTest("busy");
    setModelQuery("");
    const r = await testProviderConnection("openai", form.baseUrl, form.apiKey);
    setTest(r);
    if (r.ok) setSelected(new Set(r.models));   // default: everything just discovered is enabled
  }
  function toggleModel(m) { setSelected(prev => { const n = new Set(prev); n.has(m) ? n.delete(m) : n.add(m); return n; }); }
  // operate on shownModels (the filtered view) so "select all" while searching only touches matches
  function selectAllShown() { setSelected(prev => new Set([...prev, ...shownModels])); }
  function deselectAllShown() { setSelected(prev => { const n = new Set(prev); shownModels.forEach(m => n.delete(m)); return n; }); }
  async function save() {
    if (!form.name.trim() || !form.baseUrl.trim()) { note("Name and base URL are required"); return; }
    setBusy(true);
    const models = Array.from(selected);
    const body = { name: form.name.trim(), baseUrl: form.baseUrl.trim(), models, agentModel: agentModel || models[0] || "" };
    if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
    const url = isNew ? "/api/admin/providers" : `/api/admin/providers/${provider.id}`;
    const r = await fetch(url, { method: isNew ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json()).catch(() => null);
    setBusy(false);
    if (r && r.id) { setForm(f => ({ ...f, apiKey: "" })); note("Saved — reload to see it everywhere"); if (isNew) setOpen(false); onSaved(r); }
    else note((r && r.error) || "Could not save");
  }
  async function remove() {
    if (!window.confirm(`Remove "${provider.name}"? Its models will disappear from every picker.`)) return;
    setBusy(true);
    await fetch(`/api/admin/providers/${provider.id}`, { method: "DELETE" }).catch(() => {});
    setBusy(false);
    onDeleted(provider.id);
  }

  if (!open) {
    return (
      <div className="row gap-2" style={{ alignItems: "center" }}>
        <span className="t-sm semi">{provider.name}</span>
        <span className="t-xs ink-3">{provider.configured ? `Connected · ${provider.models.length} model${provider.models.length === 1 ? "" : "s"}` : "Not connected"}</span>
        <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setOpen(true)}>Edit</button>
      </div>
    );
  }
  return (
    <div className="col" style={{ gap: 8, padding: 12, border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-2)" }}>
      {isNew && (
        <div className="col" style={{ gap: 4, marginBottom: 2 }}>
          <span className="field-label">Quick add <span className="ink-3" style={{ fontWeight: 400 }}>(or fill in a custom connection below)</span></span>
          <div className="row gap-2" style={{ flexWrap: "wrap" }}>
            {PROVIDER_PRESETS.map(p => (
              <button key={p.name} type="button" className={"chip" + (form.name === p.name && form.baseUrl === p.baseUrl ? " on" : "")}
                onClick={() => { setForm(f => ({ ...f, name: p.name, baseUrl: p.baseUrl })); setTest(null); }}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <span className="field-label">Name</span>
      <input className="input" placeholder="e.g. OpenAI, Groq, my vLLM server" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
      <span className="field-label">Base URL</span>
      <input className="input mono" placeholder="https://api.openai.com/v1" value={form.baseUrl} onChange={e => setForm(f => ({ ...f, baseUrl: e.target.value }))} />
      <span className="field-label">API key</span>
      <input className="input mono" type="password" placeholder={provider && provider.configured ? "Leave blank to keep the current key" : "sk-..."}
        value={form.apiKey} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))} />
      <div className="row gap-2">
        <button className="btn sm" disabled={test === "busy" || !form.baseUrl.trim()} onClick={runTest}>{test === "busy" ? "Testing…" : "Test connection"}</button>
      </div>
      {test && test !== "busy" && !test.ok && <span className="t-sm" style={{ color: "var(--warn)" }}>Couldn't connect — {test.error}</span>}
      {discovered.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <span className="field-label" style={{ marginBottom: 0 }}>Models <span className="ink-3" style={{ fontWeight: 400 }}>({selected.size} of {discovered.length} enabled)</span></span>
            <span className="row gap-2" style={{ marginLeft: "auto" }}>
              <button type="button" className="btn xs ghost" disabled={!shownModels.length || shownModels.every(m => selected.has(m))} onClick={selectAllShown}>Select all</button>
              <button type="button" className="btn xs ghost" disabled={!shownModels.length || shownModels.every(m => !selected.has(m))} onClick={deselectAllShown}>Deselect all</button>
            </span>
          </div>
          {discovered.length > 6 && (
            <div className="search" style={{ width: "100%" }}>
              <Icon name="search" size={14} style={{ color: "var(--ink-3)" }} />
              <input value={modelQuery} placeholder="Search models…" onChange={e => setModelQuery(e.target.value)} />
              {modelQuery && <button className="btn icon sm ghost" onClick={() => setModelQuery("")}><Icon name="x" size={12} /></button>}
            </div>
          )}
          <div className="col" style={{ gap: 2, maxHeight: 160, overflow: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: 6, background: "var(--surface)" }}>
            {shownModels.length === 0 && <span className="t-xs ink-3" style={{ padding: "4px 2px" }}>No models match "{modelQuery}"</span>}
            {shownModels.map(m => (
              <label key={m} className="row gap-2 t-sm mono" style={{ alignItems: "center", padding: "2px 4px", cursor: "pointer" }}>
                <input type="checkbox" checked={selected.has(m)} onChange={() => toggleModel(m)} />
                {m}
              </label>
            ))}
          </div>
        </div>
      )}
      {selected.size > 0 && (
        <div className="col" style={{ gap: 3 }}>
          <span className="field-label">Default agent model</span>
          <ModelSelect value={agentModel} models={Array.from(selected)} onChange={setAgentModel} />
        </div>
      )}
      <div className="row gap-2">
        <button className="btn sm primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save connection"}</button>
        <button className="btn sm" onClick={() => (isNew ? onCancelNew() : setOpen(false))}>Cancel</button>
        {!isNew && <button className="btn sm" style={{ color: "var(--warn)", marginLeft: "auto" }} onClick={remove} disabled={busy}>Remove</button>}
      </div>
      {msg && <span className="field-hint" style={{ color: "var(--accent)" }}>{msg}</span>}
    </div>
  );
}

// admin: full live editor (Ollama + any number of OpenAI-compatible connections), each with its
// own test → pick models → save flow. Non-admins get a read-only summary from the public config.
function ProvidersSection({ account, providers, online }) {
  const isAdmin = account && account.role === "admin";
  const [list, setList] = React.useState(null);      // GET /api/admin/providers → .providers, admin only
  const [ollamaInfo, setOllamaInfo] = React.useState(null);
  const [adding, setAdding] = React.useState(false);

  React.useEffect(() => {
    if (!isAdmin) return;
    fetch("/api/admin/providers").then(r => r.json()).then(j => { setList(j.providers); setOllamaInfo(j.ollama); }).catch(() => {});
  }, [isAdmin]);

  if (!isAdmin) {
    return (
      <div className="col" style={{ gap: 4 }}>
        <span className="t-sm">Ollama <span className="ink-3">· local</span></span>
        {providers.map(p => <span key={p.id} className="t-sm">{p.name} <span className="ink-3">· cloud, {p.models.length} model{p.models.length === 1 ? "" : "s"}</span></span>)}
        {!providers.length && <span className="field-hint">Ask an admin to add a provider connection here to enable more models.</span>}
      </div>
    );
  }

  return (
    <div className="col" style={{ gap: 12 }}>
      {ollamaInfo ? <OllamaConnectionField ollamaInfo={ollamaInfo} online={online} onSaved={setOllamaInfo} /> : <span className="t-sm ink-3">Loading…</span>}

      {list !== null && list.map(p => (
        <ProviderCard key={p.id} provider={p}
          onSaved={updated => setList(l => l.map(x => x.id === updated.id ? updated : x))}
          onDeleted={id => setList(l => l.filter(x => x.id !== id))} />
      ))}

      {adding
        ? <ProviderCard provider={null}
            onSaved={created => { setList(l => [...(l || []), created]); setAdding(false); }}
            onCancelNew={() => setAdding(false)} />
        : <button className="btn sm" onClick={() => setAdding(true)}><Icon name="plus" size={13} /> Add provider</button>}
    </div>
  );
}

function SettingsPage({ settings, set, onSave, onReset, online, models, account, providers }) {
  return (
    <div className="settings-scroll scroll">
      <div className="settings-wrap">
        <div className="col" style={{ gap: 4, marginBottom: 22 }}>
          <span className="serif" style={{ fontSize: 28 }}>Settings</span>
          <span className="ink-3 t-md">Configure the model and how Heap Chat answers questions about your files.</span>
        </div>

        {/* MODEL */}
        <div className="set-section">
          <div className="set-title"><Icon name="bolt" size={18} style={{ color: "var(--accent)" }} /> Model</div>
          <div className="set-sub">Heap Chat runs inference on your local Ollama instance.</div>

          <div className="field">
            <span className="field-label">Providers</span>
            <ProvidersSection account={account} providers={providers} online={online} />
          </div>

          <div className="field">
            <span className="field-label">Default model</span>
            <ModelSelect value={settings.model} models={models} providers={providers} onChange={m => set({ model: m })} />
            <span className="field-hint">Used for file chat, vision, and quick answers. Images use <span className="mono">OLLAMA_VISION_MODEL</span>.</span>
          </div>

          <div className="field">
            <span className="field-label">Default agent model</span>
            <ModelSelect value={settings.agentModel} models={models} providers={providers} onChange={m => set({ agentModel: m })} />
            <span className="field-hint">Used for the multi-step agent (Chat / Ask folder). A strong tool-caller like <span className="mono">qwen2.5</span> reasons over retrieval better than Gemma, which can over-trust matched text. You can also switch per-chat from the model picker in the composer.</span>
          </div>

          <div className="field">
            <span className="field-label">Embedding model</span>
            <ModelSelect value={settings.embedModel} models={models} providers={providers} onChange={m => set({ embedModel: m })} />
            <span className="field-hint">Builds the folder/document search index (RAG). Changing this re-embeds everything from scratch on next index — the old vectors aren't compatible with a different model, so nothing is mixed silently.</span>
          </div>

          <div className="field">
            <span className="field-label">Rerank model <span className="ink-3">(optional)</span></span>
            <ModelSelect value={settings.rerankModel} models={models} providers={providers} allowDefault defaultLabel="Off — embedding similarity only"
              onChange={m => set({ rerankModel: m })} />
            <span className="field-hint">A cross-encoder that re-scores the top search matches for precision, on top of embedding similarity. Off by default — it costs an extra model call per candidate on every search. <span className="mono">qllama/bge-reranker-v2-m3</span> works well. Best-effort: if the model errors or isn't pulled, search silently falls back to embedding-only ranking.</span>
          </div>
        </div>

        {/* REASONING / THINKING */}
        <div className="set-section">
          <div className="set-title"><Icon name="brain" size={18} style={{ color: "var(--accent)" }} /> Reasoning</div>
          <div className="set-sub">Ask the model to run an extended “thinking” pass before it answers.</div>

          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Enable thinking</span>
              <span className="field-hint">When off, Heap Chat sends no <span className="mono">think</span> flag to Ollama — recommended for fast, direct answers.</span>
            </div>
            <button className={"toggle" + (settings.thinking ? " on" : "")}
              onClick={() => set({ thinking: !settings.thinking })} aria-label="Toggle thinking" />
          </div>

          {settings.thinking && (
            <div className="callout warn" style={{ marginTop: 12 }}>
              <Icon name="info" size={16} />
              <span>Thinking only works if the selected Ollama model supports a reasoning stream. If it doesn't, requests may error — turn this off.</span>
            </div>
          )}
        </div>

        {/* FACT-CHECK */}
        <div className="set-section">
          <div className="set-title"><Icon name="check" size={18} style={{ color: "var(--accent)" }} /> Fact-checking</div>
          <div className="set-sub">After each grounded answer, run a self-verification pass and auto-correct unsupported claims.</div>
          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Fact-check answers by default</span>
              <span className="field-hint">When on, the agent verifies its answer against the retrieved evidence and rewrites any unsupported claims. Adds a short pause after each response. Can also be toggled per-chat in the composer.</span>
            </div>
            <button className={"toggle" + (settings.factCheck !== false ? " on" : "")}
              onClick={() => set({ factCheck: settings.factCheck === false })} aria-label="Toggle fact-checking" />
          </div>
        </div>

        {/* MEMORY */}
        <div className="set-section">
          <div className="set-title"><Icon name="brain" size={18} style={{ color: "var(--accent)" }} /> Memory</div>
          <div className="set-sub">Long-term facts the agent applies to every chat (manage them on the Manage page).</div>
          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Auto-capture memories</span>
              <span className="field-hint">When on, the agent proactively saves durable facts about you. When off, it only remembers when you explicitly ask.</span>
            </div>
            <button className={"toggle" + (settings.autoMemory ? " on" : "")} onClick={() => set({ autoMemory: !settings.autoMemory })} aria-label="Toggle auto-memory" />
          </div>
        </div>

        {/* AUTO-EXTRACT */}
        <div className="set-section">
          <div className="set-title"><Icon name="grid" size={18} style={{ color: "var(--accent)" }} /> Auto-extract uploads</div>
          <div className="set-sub">When you add documents to the knowledge base, automatically extract their fields into a table.</div>
          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Auto-extract on upload</span>
              <span className="field-hint">After a KB upload, the Extract panel opens and reads the new documents (vision OCR for scans/photos) into a table you can review &amp; download. Off by default — extraction is vision-heavy.</span>
            </div>
            <button className={"toggle" + (settings.autoExtract ? " on" : "")} onClick={() => set({ autoExtract: !settings.autoExtract })} aria-label="Toggle auto-extract" />
          </div>
        </div>

        {/* WEB SEARCH */}
        <div className="set-section">
          <div className="set-title"><Icon name="search" size={18} style={{ color: "var(--accent)" }} /> Web search</div>
          <div className="set-sub">Let the agent search the public web (DuckDuckGo) for current info and images.</div>
          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Enable web search</span>
              <span className="field-hint">When on, the agent can search the web and show results &amp; images in the chat. <b>This makes outbound internet requests</b> — the only feature besides connectors that leaves your machine. Off by default to stay fully offline.</span>
            </div>
            <button className={"toggle" + (settings.webSearch ? " on" : "")} onClick={() => set({ webSearch: !settings.webSearch })} aria-label="Toggle web search" />
          </div>
          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Online place names</span>
              <span className="field-hint">Lets the Knowledge graph turn photo GPS coordinates into real place names (e.g. “Bengaluru, IN”) via a reverse-geocoding lookup. <b>Makes outbound internet requests</b> (one per location, then cached). Off by default — when off, places stay as coordinates and nothing leaves your machine.</span>
            </div>
            <button className={"toggle" + (settings.placeLookup ? " on" : "")} onClick={() => set({ placeLookup: !settings.placeLookup })} aria-label="Toggle online place names" />
          </div>
        </div>

        {/* IMAGE GENERATION */}
        <ImageGenSection settings={settings} set={set} />

        {/* DISPLAY */}
        <div className="set-section">
          <div className="set-title"><Icon name="sparkles" size={18} style={{ color: "var(--accent)" }} /> Rich rendering</div>
          <div className="set-sub">Let the agent turn tool data (spreadsheets, connector results) into charts and tables.</div>
          <div className="row-set">
            <div className="col" style={{ gap: 3 }}>
              <span className="field-label">Render charts &amp; tables</span>
              <span className="field-hint">When on, numeric tool results are shown as a bar chart / table alongside the answer (only when the data clearly fits — otherwise plain Markdown). When off, answers stay text-only.</span>
            </div>
            <button className={"toggle" + (settings.richRender !== false ? " on" : "")} onClick={() => set({ richRender: settings.richRender === false })} aria-label="Toggle rich rendering" />
          </div>
        </div>

        {/* GENERATION */}
        <div className="set-section">
          <div className="set-title"><Icon name="sliders" size={18} style={{ color: "var(--accent)" }} /> Generation</div>
          <div className="set-sub">Fine-tune how the model samples its responses.</div>
          <Slider label="Temperature" hint="Lower = focused, higher = creative" value={settings.temperature} min={0} max={1} step={0.05} fmt={v => v.toFixed(2)} onChange={v => set({ temperature: v })} />
          <Slider label="Max tokens" hint="Max length of a response (num_predict). Ollama supports large values — higher = longer answers, slower." value={settings.maxTokens} min={512} max={32768} step={512} fmt={v => v.toLocaleString()} onChange={v => set({ maxTokens: v })} />
          <Slider label="Context window" hint="How much the model reads at once (num_ctx) — docs, history, tool results. Higher = more context, more memory on the Ollama box. Capped at 128k; chats that outgrow it are summarized automatically." value={settings.contextWindow} min={2048} max={131072} step={2048} fmt={v => v.toLocaleString()} onChange={v => set({ contextWindow: v })} />
          <Slider label="Top-p" hint="Nucleus sampling cutoff" value={settings.topP} min={0} max={1} step={0.05} fmt={v => v.toFixed(2)} onChange={v => set({ topP: v })} />
          <Slider label="Photos to analyze for appearance" hint="When you ask how a labeled person looks, the agent analyzes this many of their photos with vision and synthesizes the answer. More = richer but slower." value={settings.facePhotoCount || 5} min={1} max={10} step={1} fmt={v => v} onChange={v => set({ facePhotoCount: v })} />
        </div>

        {/* SYSTEM PROMPT */}
        <div className="set-section">
          <div className="set-title"><Icon name="text" size={18} style={{ color: "var(--accent)" }} /> System prompt</div>
          <div className="set-sub">Sets the assistant's behaviour for every file chat.</div>
          <textarea className="textarea mono" style={{ fontSize: 12.5, minHeight: 130 }} value={settings.systemPrompt} onChange={e => set({ systemPrompt: e.target.value })} />
        </div>

        <DeepWorkAgents models={models} providers={providers} />

        <AccountSection account={account} />

        <McpConnectors />

        <div className="row gap-3" style={{ marginTop: 24 }}>
          <button className="btn primary" onClick={onSave}><Icon name="check" size={16} /> Save changes</button>
          <button className="btn" onClick={onReset}>Reset to defaults</button>
        </div>
      </div>
    </div>
  );
}

export { DEFAULT_SETTINGS, SettingsPage, ModelSelect };
