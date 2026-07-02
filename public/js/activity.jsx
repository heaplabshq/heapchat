import { fmt } from "./markdown.jsx";
import { Icon } from "./icons.jsx";
import { FolderPicker } from "./folderpicker.jsx";
// activity.jsx — scheduled agents (jobs) + their digest feed (LEARNING-LOOP-PLAN Part B).
// Create a schedule from a prompt + cadence (optionally driven by a custom agent), and read
// what the unattended runs produced. fmt() (markdown.jsx) and Icon (icons.jsx) resolve as globals.

const CADENCE_LABELS = { hourly: "Every hour", every6h: "Every 6 hours", daily: "Daily", weekly: "Weekly" };
const BLANK_JOB = { name: "", prompt: "", cadence: "daily", agentId: "", scope: "kb", projectId: "", folderPath: "", web: false, deliver: ["feed"] };

// short label for what a job runs against (job row + dropdown)
function scopeLabel(j, projects) {
  if (j.scope === "folder" && j.folderPath) return "📁 " + j.folderPath.split(/[\\/]/).filter(Boolean).pop();
  if (j.scope === "project" && j.projectId) { const p = (projects || []).find(x => x.id === j.projectId); return p ? p.name : "project"; }
  return "Knowledge base";
}

function ActivityPage({ agents = [], projects = [] }) {
  const [jobs, setJobs] = React.useState([]);
  const [digests, setDigests] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [draft, setDraft] = React.useState(null);   // job being created/edited, or null
  const [running, setRunning] = React.useState(null);   // job id currently running
  const [openDigest, setOpenDigest] = React.useState(null);
  const [picking, setPicking] = React.useState(false);   // folder picker open (for folder scope)

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/jobs").then(r => r.json()).catch(() => ({ jobs: [] })),
      fetch("/api/digests").then(r => r.json()).catch(() => ({ digests: [] })),
    ]).then(([a, b]) => { setJobs(a.jobs || []); setDigests(b.digests || []); setLoading(false); });
  }
  React.useEffect(() => { load(); }, []);

  async function saveJob() {
    const d = draft; if (!d || !d.prompt.trim()) return;
    const editing = !!d.id;
    const r = await fetch(editing ? "/api/jobs/" + d.id : "/api/jobs",
      { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) })
      .then(r => r.json()).catch(() => null);
    if (r && r.id) { setDraft(null); load(); }
  }
  async function toggleJob(j) {
    await fetch("/api/jobs/" + j.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !j.enabled }) }).catch(() => {});
    setJobs(list => list.map(x => x.id === j.id ? { ...x, enabled: !x.enabled } : x));
  }
  async function delJob(id) {
    if (!window.confirm("Delete this schedule? Past results in the feed are kept.")) return;
    await fetch("/api/jobs/" + id, { method: "DELETE" }).catch(() => {});
    setJobs(list => list.filter(x => x.id !== id));
  }
  async function runNow(id) {
    setRunning(id);
    await fetch("/api/jobs/" + id + "/run", { method: "POST" }).then(r => r.json()).catch(() => null);
    setRunning(null); load();
  }
  async function delDigest(id) {
    await fetch("/api/digests/" + id, { method: "DELETE" }).catch(() => {});
    setDigests(list => list.filter(x => x.id !== id));
  }
  async function clearFeed() {
    if (!window.confirm("Clear the whole activity feed?")) return;
    await fetch("/api/digests", { method: "DELETE" }).catch(() => {});
    setDigests([]);
  }

  const setD = patch => setDraft(d => ({ ...d, ...patch }));
  const toggleDeliver = ch => setDraft(d => ({ ...d, deliver: d.deliver.includes(ch) ? d.deliver.filter(x => x !== ch) : [...d.deliver, ch] }));

  return (
    <div className="settings-scroll scroll">
      <div className="settings-wrap" style={{ maxWidth: 880 }}>
        <div className="row between" style={{ marginBottom: 8 }}>
          <div className="col" style={{ gap: 4 }}>
            <span className="x-bold tighter" style={{ fontSize: 26 }}>Activity</span>
            <span className="ink-3 t-md">Schedule the agent to run on its own, and read what it produced.</span>
          </div>
          <button className="btn" onClick={load}><Icon name="refresh" size={15} /> Refresh</button>
        </div>

        {/* SCHEDULES */}
        <div className="set-section">
          <div className="row between" style={{ alignItems: "flex-start", gap: 12 }}>
            <div className="col" style={{ gap: 4, minWidth: 0 }}>
              <div className="set-title"><Icon name="clock" size={18} style={{ color: "var(--accent)" }} /> Schedules</div>
              <div className="set-sub" style={{ marginBottom: 0 }}>Saved prompts the agent runs unattended on a cadence. Results land in the feed below. Scheduled runs can’t delete or rename your files.</div>
            </div>
            {!draft && <button className="btn sm primary none" style={{ flexShrink: 0 }} onClick={() => setDraft({ ...BLANK_JOB })}><Icon name="plus" size={14} /> New schedule</button>}
          </div>

          {draft && (
            <div className="col" style={{ gap: 10, margin: "12px 0", padding: 14, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)" }}>
              <input className="select" placeholder="Name (e.g. Morning news digest)" value={draft.name} onChange={e => setD({ name: e.target.value })} />
              <textarea className="select" rows={3} style={{ resize: "vertical" }} placeholder="What should the agent do? e.g. Summarize the latest in my Reading folder and list 3 follow-ups." value={draft.prompt} onChange={e => setD({ prompt: e.target.value })} />
              <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
                <label className="col" style={{ gap: 3 }}>
                  <span className="t-xs ink-3">Runs</span>
                  <select className="select" value={draft.cadence} onChange={e => setD({ cadence: e.target.value })}>
                    {Object.keys(CADENCE_LABELS).map(c => <option key={c} value={c}>{CADENCE_LABELS[c]}</option>)}
                  </select>
                </label>
                <label className="col" style={{ gap: 3 }}>
                  <span className="t-xs ink-3">Runs against</span>
                  <select className="select" value={draft.scope === "project" ? "project:" + draft.projectId : draft.scope}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === "kb") setD({ scope: "kb", projectId: "", folderPath: "" });
                      else if (v === "folder") setPicking(true);   // pick a path before committing the scope
                      else if (v.startsWith("project:")) setD({ scope: "project", projectId: v.slice(8), folderPath: "" });
                    }}>
                    <option value="kb">Knowledge base</option>
                    {projects.map(p => <option key={p.id} value={"project:" + p.id}>Project · {p.name}</option>)}
                    <option value="folder">{draft.scope === "folder" && draft.folderPath ? "📁 " + scopeLabel(draft, projects).replace("📁 ", "") : "Choose a folder…"}</option>
                  </select>
                </label>
                <label className="col" style={{ gap: 3 }}>
                  <span className="t-xs ink-3">As agent</span>
                  <select className="select" value={draft.agentId || ""} onChange={e => setD({ agentId: e.target.value })}>
                    <option value="">Default assistant</option>
                    {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
                <label className="row gap-2" style={{ alignItems: "center", cursor: "pointer" }}>
                  <input type="checkbox" checked={!!draft.web} onChange={e => setD({ web: e.target.checked })} /> <span className="t-sm">Allow web</span>
                </label>
              </div>
              {draft.scope === "folder" && draft.folderPath && (
                <div className="t-xs ink-3 mono truncate" title={draft.folderPath}><Icon name="folderOpen" size={12} /> {draft.folderPath}</div>
              )}
              <div className="row gap-3" style={{ alignItems: "center" }}>
                <span className="t-xs ink-3">Deliver to</span>
                <label className="row gap-2" style={{ alignItems: "center", cursor: "pointer" }}><input type="checkbox" checked={draft.deliver.includes("feed")} onChange={() => toggleDeliver("feed")} /> <span className="t-sm">Activity feed</span></label>
                <label className="row gap-2" style={{ alignItems: "center", cursor: "pointer" }}><input type="checkbox" checked={draft.deliver.includes("note")} onChange={() => toggleDeliver("note")} /> <span className="t-sm">Save as note</span></label>
                <label className="row gap-2" style={{ alignItems: "center", cursor: "pointer" }}><input type="checkbox" checked={draft.deliver.includes("notify")} onChange={() => toggleDeliver("notify")} /> <span className="t-sm">Desktop notification</span></label>
              </div>
              <div className="row gap-2">
                <button className="btn sm primary" disabled={!draft.prompt.trim()} onClick={saveJob}><Icon name="check" size={14} /> {draft.id ? "Save" : "Create"}</button>
                <button className="btn sm" onClick={() => setDraft(null)}>Cancel</button>
              </div>
            </div>
          )}

          {loading ? <span className="dots"><span /><span /><span /></span> : jobs.length === 0 && !draft ? (
            <div className="ink-3 t-sm" style={{ marginTop: 10 }}>No schedules yet — create one to have the agent work for you on a cadence.</div>
          ) : (
            <div className="col" style={{ gap: 8, marginTop: 10 }}>
              {jobs.map(j => (
                <div key={j.id} className="row-set" style={{ padding: "10px 14px", opacity: j.enabled ? 1 : 0.55 }}>
                  <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                    <span className="semi t-sm">{j.name}</span>
                    <span className="t-xs ink-3 truncate">{j.prompt}</span>
                    <span className="t-xs ink-4">
                      {CADENCE_LABELS[j.cadence] || j.cadence}
                      {" · " + scopeLabel(j, projects)}
                      {j.agentId && agents.find(a => a.id === j.agentId) ? " · " + agents.find(a => a.id === j.agentId).name : ""}
                      {j.lastResult ? " · last run " + new Date(j.lastResult.at).toLocaleString() + (j.lastResult.ok ? "" : " (failed)") : " · never run"}
                    </span>
                  </div>
                  <div className="row gap-2 none" style={{ flexShrink: 0 }}>
                    <button className="btn sm" disabled={running === j.id} onClick={() => runNow(j.id)} title="Run now">
                      <Icon name={running === j.id ? "refresh" : "play"} size={13} style={running === j.id ? { animation: "spin 1s linear infinite" } : undefined} /> Run
                    </button>
                    <button className="btn sm" onClick={() => toggleJob(j)} title={j.enabled ? "Pause" : "Resume"}>{j.enabled ? "Pause" : "Resume"}</button>
                    <button className="btn icon sm ghost" onClick={() => setDraft({ ...BLANK_JOB, ...j, agentId: j.agentId || "" })} title="Edit"><Icon name="edit" size={14} /></button>
                    <button className="btn icon sm ghost" onClick={() => delJob(j.id)} title="Delete" style={{ color: "var(--warn)" }}><Icon name="x" size={14} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* FEED */}
        <div className="set-section">
          <div className="row between" style={{ alignItems: "flex-start", gap: 12 }}>
            <div className="col" style={{ gap: 4, minWidth: 0 }}>
              <div className="set-title"><Icon name="sparkles" size={18} style={{ color: "var(--accent)" }} /> Feed</div>
              <div className="set-sub" style={{ marginBottom: 0 }}>What your scheduled agents produced. Click an item to read it in full.</div>
            </div>
            {digests.length > 0 && <button className="btn sm none" style={{ color: "var(--warn)", flexShrink: 0 }} onClick={clearFeed}><Icon name="x" size={13} /> Clear</button>}
          </div>
          {loading ? null : digests.length === 0 ? (
            <div className="ink-3 t-sm" style={{ marginTop: 10 }}>Nothing yet — run a schedule (or hit Run) and its output shows up here.</div>
          ) : (
            <div className="col" style={{ gap: 8, marginTop: 10 }}>
              {digests.map(d => (
                <div key={d.id} className="col" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)", overflow: "hidden" }}>
                  <div className="row gap-2" style={{ padding: "10px 14px", alignItems: "flex-start", cursor: "pointer" }} onClick={() => setOpenDigest(o => o === d.id ? null : d.id)}>
                    <Icon name={openDigest === d.id ? "chevD" : "chevR"} size={15} style={{ marginTop: 2, flexShrink: 0, color: "var(--ink-3)" }} />
                    <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                      <span className="semi t-sm">{d.jobName}</span>
                      {openDigest !== d.id && <span className="t-xs ink-3 truncate">{(d.text || "").replace(/[#*`]/g, "").slice(0, 120)}</span>}
                      <span className="t-xs ink-4">{new Date(d.createdAt).toLocaleString()}</span>
                    </div>
                    <button className="btn icon sm ghost none" onClick={e => { e.stopPropagation(); delDigest(d.id); }} title="Remove" style={{ color: "var(--warn)" }}><Icon name="x" size={14} /></button>
                  </div>
                  {openDigest === d.id && (
                    <div className="t-sm" style={{ padding: "0 14px 12px 33px", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                      {fmt(d.text || "")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {picking && (
        <FolderPicker
          startPath={draft && draft.folderPath ? draft.folderPath : ""}
          onPick={p => { setD({ scope: "folder", folderPath: p, projectId: "" }); setPicking(false); }}
          onPickFile={() => {}}
          onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

export { ActivityPage, scopeLabel };
