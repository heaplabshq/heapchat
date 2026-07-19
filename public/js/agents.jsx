import { Icon, downloadJSON } from "./icons.jsx";
import { ModelSelect } from "./settings.jsx";
// agents.jsx — user-defined custom agents: own system prompt (full replace of the default
// persona), model/sampling overrides, and per-agent tool capability toggles.
const { useState: useAg, useEffect: useAgE, useRef: useAgR } = React;

// strip server-assigned fields so an exported agent re-imports as a distinct copy
function agentExportShape(a) {
  const { name, description, systemPrompt, model, temperature, maxTokens, topP, tools, color, icon } = a;
  return { name, description, systemPrompt, model, temperature, maxTokens, topP, tools, color, icon };
}

const AGENT_COLORS = ["#0ea5e9","#6366f1","#ec4899","#f59e0b","#10b981","#ef4444","#8b5cf6","#14b8a6","#f97316","#64748b"];
const AGENT_ICONS  = ["bolt","sparkles","brain","compass","flask","grid","search","tag","ruler","send"];

const AgentAPI = {
  list:   ()      => fetch("/api/agents").then(r => r.json()).then(j => j.agents || []).catch(() => []),
  create: data    => fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(r => r.json()),
  update: (id, d) => fetch(`/api/agents/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }).then(r => r.json()),
  remove: id      => fetch(`/api/agents/${id}`, { method: "DELETE" }).then(r => r.json()),
};

const AGENT_TOOL_OPTS = [
  ["files",      "File & knowledge-base search", "Search, read, and work with the user's documents and KB"],
  ["web",        "Web search",                   "Look things up on the web and read pages"],
  ["memory",     "Long-term memory",             "Recall and save durable facts about the user"],
  ["connectors", "Connectors (MCP)",             "Call external connectors the user has enabled"],
];

function AgentToggle({ on, label, hint, onToggle }) {
  return (
    <div className="agent-toggle" onClick={onToggle}>
      <button type="button" className={"toggle" + (on ? " on" : "")} aria-label={"Toggle " + label} />
      <span className="col" style={{ gap: 1, textAlign: "left", minWidth: 0 }}>
        <span className="semi t-sm">{label}</span>
        <span className="ink-3 t-xs">{hint}</span>
      </span>
    </div>
  );
}

function AgentEditModal({ agent, models = [], providers = [], onSave, onClose, onDelete }) {
  const [name, setName]       = useAg(agent ? agent.name : "");
  const [description, setDesc]= useAg(agent ? agent.description : "");
  const [systemPrompt, setSp] = useAg(agent ? agent.systemPrompt : "");
  const [model, setModel]     = useAg(agent ? (agent.model || "") : "");
  const [temperature, setTemp]= useAg(agent && typeof agent.temperature === "number" ? agent.temperature : 0.7);
  const [maxTokens, setMax]   = useAg(agent && typeof agent.maxTokens === "number" ? agent.maxTokens : 2048);
  const [tools, setTools]     = useAg(agent ? { ...{ files: true, web: false, memory: true, connectors: true }, ...(agent.tools || {}) } : { files: true, web: false, memory: true, connectors: true });
  const [color, setColor]     = useAg(agent ? agent.color : AGENT_COLORS[0]);
  const [icon, setIcon]       = useAg(agent ? agent.icon : AGENT_ICONS[0]);
  const [busy, setBusy]       = useAg(false);
  const [err, setErr]         = useAg(null);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setErr("Name is required");
    if (!systemPrompt.trim()) return setErr("A system prompt is required — it defines how this agent behaves");
    setBusy(true); setErr(null);
    try {
      const data = { name: name.trim(), description, systemPrompt, model, temperature, maxTokens, tools, color, icon };
      const j = agent ? await AgentAPI.update(agent.id, data) : await AgentAPI.create(data);
      if (j.error) throw new Error(j.error);
      onSave(j.agent);
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="agent-modal" onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <span className="x-bold tighter" style={{ fontSize: 17 }}>
            <Icon name={icon} size={16} style={{ color }} /> {agent ? "Edit agent" : "New agent"}
          </span>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>

        <form onSubmit={submit}>
          <div className="row gap-2" style={{ marginBottom: 14 }}>
            <div className="col" style={{ gap: 6 }}>
              <span className="field-label">Color</span>
              <div className="proj-swatches">
                {AGENT_COLORS.map(c => <button key={c} type="button" className={"proj-swatch" + (color === c ? " on" : "")} style={{ background: c }} onClick={() => setColor(c)} />)}
              </div>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="field-label">Icon</span>
              <div className="proj-swatches">
                {AGENT_ICONS.map(ic => (
                  <button key={ic} type="button" className={"proj-icon-btn" + (icon === ic ? " on" : "")} style={{ color: icon === ic ? color : "var(--ink-3)" }} onClick={() => setIcon(ic)}>
                    <Icon name={ic} size={14} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="field-label" style={{ marginBottom: 4, display: "block" }}>Name</label>
          <input className="ex-input" autoFocus placeholder="e.g. Code Reviewer, Email Writer…" value={name} onChange={e => setName(e.target.value)} maxLength={80} style={{ marginBottom: 12 }} />

          <label className="field-label" style={{ marginBottom: 4, display: "block" }}>Description <span className="ink-3">(optional)</span></label>
          <input className="ex-input" placeholder="What this agent is for" value={description} onChange={e => setDesc(e.target.value)} maxLength={500} style={{ marginBottom: 12 }} />

          <label className="field-label" style={{ marginBottom: 4, display: "block" }}>System prompt</label>
          <div className="t-xs ink-3" style={{ marginBottom: 6 }}>This <b>fully replaces</b> the default agent instructions — the agent follows only what you write here. Tool-use mechanics are still handled automatically.</div>
          <textarea className="textarea mono" rows={7} placeholder={"You are a senior code reviewer. For each submission, list issues by severity, suggest concrete fixes, and keep feedback terse and actionable."} value={systemPrompt} onChange={e => setSp(e.target.value)} maxLength={8000} style={{ fontSize: 12.5, marginBottom: 14 }} />

          {/* model + sampling */}
          <div className="row gap-3 wrap" style={{ marginBottom: 14 }}>
            <div className="col grow" style={{ gap: 5, minWidth: 200 }}>
              <span className="field-label">Model <span className="ink-3">(optional override)</span></span>
              <ModelSelect value={model} models={models} providers={providers} allowDefault defaultLabel="Default" onChange={setModel} />
            </div>
          </div>
          <div className="row gap-3 wrap" style={{ marginBottom: 16 }}>
            <div className="col grow" style={{ gap: 4, minWidth: 180 }}>
              <span className="field-label">Temperature <span className="ink-3">· {temperature.toFixed(2)}</span></span>
              <input type="range" min={0} max={1.5} step={0.05} value={temperature} onChange={e => setTemp(+e.target.value)} />
            </div>
            <div className="col grow" style={{ gap: 4, minWidth: 180 }}>
              <span className="field-label">Max tokens <span className="ink-3">· {maxTokens.toLocaleString()}</span></span>
              <input type="range" min={256} max={8192} step={256} value={maxTokens} onChange={e => setMax(+e.target.value)} />
            </div>
          </div>

          {/* tool capabilities */}
          <span className="field-label" style={{ display: "block", marginBottom: 6 }}>Capabilities</span>
          <div className="agent-tools-grid">
            {AGENT_TOOL_OPTS.map(([key, label, hint]) => (
              <AgentToggle key={key} on={tools[key]} label={label} hint={hint} onToggle={() => setTools(t => ({ ...t, [key]: !t[key] }))} />
            ))}
          </div>

          {err && <div className="callout warn" style={{ marginTop: 12 }}><Icon name="alert" size={14} /><span>{err}</span></div>}

          <div className="row between" style={{ gap: 8, marginTop: 18 }}>
            {agent && onDelete
              ? <button type="button" className="btn" style={{ color: "var(--warn)" }} disabled={busy}
                  onClick={async () => { if (window.confirm(`Delete agent "${agent.name}"?`)) { await AgentAPI.remove(agent.id); onDelete(agent); } }}>
                  <Icon name="x" size={14} /> Delete
                </button>
              : <span />}
            <div className="row" style={{ gap: 8 }}>
              <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="submit" className="btn primary" disabled={busy}>{busy ? <><span className="spin-mini" /> Saving…</> : (agent ? "Save" : "Create agent")}</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// compact dropdown for the chat composer — pick which agent drives this conversation
function AgentPicker({ agents = [], value, onChange, onManage }) {
  const [open, setOpen] = useAg(false);
  const active = agents.find(a => a.id === value) || null;
  return (
    <div className="agent-pick-wrap">
      <button type="button" className="agent-pick" title="Choose the agent for this chat" onClick={() => setOpen(o => !o)}>
        <Icon name={active ? active.icon : "sparkles"} size={13} style={{ color: active ? active.color : "var(--accent)" }} />
        <span className="truncate agent-pick-name">{active ? active.name : "Default agent"}</span>
        <Icon name="chevD" size={12} style={{ color: "var(--ink-3)", flex: "none" }} />
      </button>
      {open && <>
        <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
        <div className="dd-menu agent-pick-menu">
          <div className={"dd-item" + (!value ? " on" : "")} onClick={() => { onChange(null); setOpen(false); }}>
            <Icon name="sparkles" size={14} style={{ color: "var(--accent)" }} /> Default agent
            {!value && <Icon name="check" size={14} style={{ marginLeft: "auto" }} />}
          </div>
          {agents.map(a => (
            <div key={a.id} className={"dd-item" + (a.id === value ? " on" : "")} onClick={() => { onChange(a.id); setOpen(false); }}>
              <Icon name={a.icon} size={14} style={{ color: a.color }} /> <span className="truncate">{a.name}</span>
              {a.id === value && <Icon name="check" size={14} style={{ marginLeft: "auto" }} />}
            </div>
          ))}
          {onManage && (
            <div className="dd-item" style={{ borderTop: "1px solid var(--line)", color: "var(--ink-3)" }} onClick={() => { setOpen(false); onManage(); }}>
              <Icon name="plus" size={14} /> New agent…
            </div>
          )}
        </div>
      </>}
    </div>
  );
}

/* ---- agents hub — full-page grid of all agents ---- */
function AgentsHub({ agents, onChat, onEdit, onNew, onImported }) {
  const fileRef = useAgR(null);
  const [err, setErr] = useAg(null);

  async function importFile(file) {
    setErr(null);
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || !String(data.name || "").trim()) throw new Error("Not a valid agent export");
      const j = await AgentAPI.create(agentExportShape(data));
      if (j.error) throw new Error(j.error);
      onImported && onImported();
    } catch (e) { setErr(e.message || "Couldn't import that file"); }
  }

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="topbar">
        <div className="crumb grow" style={{ gap: 8 }}>
          <Icon name="bolt" size={17} style={{ color: "var(--accent)" }} />
          <span className="crumb-name">Agents</span>
          {agents.length > 0 && <span className="t-sm ink-3">· {agents.length}</span>}
        </div>
        <button className="btn sm ghost" onClick={() => fileRef.current && fileRef.current.click()}>
          <Icon name="upload" size={14} /> Import
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
          onChange={e => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); }} />
        <button className="btn sm primary" onClick={onNew}>
          <Icon name="plus" size={14} /> New agent
        </button>
      </div>
      {err && <div className="callout warn" style={{ margin: "10px 20px 0" }}><Icon name="alert" size={14} /><span>{err}</span></div>}
      <div className="content" style={{ display: "block", overflow: "auto" }}>
        {!agents.length ? (
          <div className="col center" style={{ padding: "64px 24px", gap: 14, textAlign: "center" }}>
            <Icon name="bolt" size={36} style={{ color: "var(--accent)", opacity: .4 }} />
            <div className="x-bold" style={{ fontSize: 16 }}>No agents yet</div>
            <div className="ink-3 t-sm" style={{ maxWidth: 320 }}>
              Create a custom agent with its own system prompt, model settings, and tool permissions.
            </div>
            <button className="btn primary" style={{ marginTop: 4 }} onClick={onNew}>
              <Icon name="plus" size={15} /> New agent
            </button>
          </div>
        ) : (
          <div className="tile-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", maxWidth: 940 }}>
            {agents.map(a => (
              <div key={a.id} className="entity-card" style={{ cursor: "default" }}>
                <span className="entity-ico" style={{ background: (a.color || "#4F46E5") + "1a", color: a.color || "var(--accent)" }}>
                  <Icon name={a.icon || "bolt"} size={22} />
                </span>
                <span className="semi" style={{ fontSize: 15 }}>{a.name}</span>
                {a.description && <span className="t-xs ink-3">{a.description}</span>}
                <div className="row gap-2" style={{ marginTop: 4 }}>
                  <button className="btn sm primary" onClick={() => onChat(a)}>
                    <Icon name="sparkles" size={13} /> Chat
                  </button>
                  <button className="btn icon sm ghost" title="Export as JSON" onClick={() => downloadJSON(agentExportShape(a), a.name)}>
                    <Icon name="download" size={13} />
                  </button>
                  <button className="btn icon sm ghost" title="Edit" onClick={() => onEdit(a)}>
                    <Icon name="edit" size={13} />
                  </button>
                </div>
              </div>
            ))}
            <div className="entity-card" style={{ borderStyle: "dashed", color: "var(--ink-3)", cursor: "pointer" }} onClick={onNew}>
              <span className="entity-ico" style={{ background: "var(--surface-2)", color: "var(--ink-3)" }}>
                <Icon name="plus" size={22} />
              </span>
              <span className="semi t-sm">New agent</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export { AgentAPI, AgentEditModal, AgentPicker, AgentsHub };
