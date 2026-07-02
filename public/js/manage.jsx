import { Icon, thumbUrl } from "./icons.jsx";
import { fmt } from "./markdown.jsx";
// manage.jsx — index & knowledge-base management page

// memory types grouped for display; preferences/instructions are always applied,
// facts/past tasks (episodes) are recalled only when a question is relevant.
const MEM_GROUPS = [
  { type: "preference",  label: "Preferences",  desc: "How you like answers — applied to every chat" },
  { type: "instruction", label: "Instructions", desc: "Standing orders — applied to every chat" },
  { type: "fact",        label: "Facts",        desc: "What's true about you — recalled when relevant" },
  { type: "episode",     label: "Past tasks",   desc: "Lessons from finished sessions — recalled when relevant" },
];

function ManagePage({ onOpenFolder }) {
  const [indexes, setIndexes] = React.useState([]);
  const [images, setImages] = React.useState([]);
  const [memory, setMemory] = React.useState([]);
  const [newMem, setNewMem] = React.useState("");
  const [skills, setSkills] = React.useState([]);
  const [openSkill, setOpenSkill] = React.useState(null);   // id of the expanded skill
  const [profile, setProfile] = React.useState(null);
  const [profileDraft, setProfileDraft] = React.useState(null);   // non-null while editing
  const [profileBusy, setProfileBusy] = React.useState(false);
  const [profileMsg, setProfileMsg] = React.useState("");   // feedback when a rebuild produces nothing
  const [reflection, setReflection] = React.useState(false);   // A3: self-correct memory/skills after a session
  const [busy, setBusy] = React.useState(null);   // path currently working
  const [loading, setLoading] = React.useState(true);

  function load() {
    setLoading(true);
    Promise.all([
      fetch("/api/admin/indexes").then(r => r.json()).catch(() => ({ indexes: [] })),
      fetch("/api/admin/images").then(r => r.json()).catch(() => ({ images: [] })),
      fetch("/api/memory").then(r => r.json()).catch(() => ({ memory: [] })),
      fetch("/api/skills").then(r => r.json()).catch(() => ({ skills: [] })),
      fetch("/api/profile").then(r => r.json()).catch(() => ({ profile: null })),
      fetch("/api/user-settings").then(r => r.json()).catch(() => ({ settings: {} })),
    ]).then(([a, b, c, d, e, f]) => { setIndexes(a.indexes || []); setImages(b.images || []); setMemory(c.memory || []); setSkills(d.skills || []); setProfile(e.profile || null); setReflection(!!(f.settings && f.settings.reflection)); setLoading(false); });
  }
  React.useEffect(() => { load(); }, []);

  async function addMem() {
    const t = newMem.trim(); if (!t) return;
    const r = await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) }).then(r => r.json()).catch(() => null);
    if (r && r.id) { setMemory(m => [r, ...m.filter(x => x.id !== r.id)]); setNewMem(""); }
  }
  async function retypeMem(m, type) {
    const r = await fetch("/api/memory/" + m.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }) }).then(r => r.json()).catch(() => null);
    if (r && r.id) setMemory(list => list.map(x => x.id === r.id ? r : x));
  }
  async function delMem(id) {
    await fetch("/api/memory/" + id, { method: "DELETE" }).catch(() => {});
    setMemory(m => m.filter(x => x.id !== id));
  }
  async function clearAllMem() {
    if (!window.confirm("Forget everything the assistant has learned about you? This deletes all memories — preferences, instructions, facts and past tasks. This cannot be undone.")) return;
    const r = await fetch("/api/memory", { method: "DELETE" }).then(r => r.json()).catch(() => null);
    if (r && r.ok) setMemory([]);
  }

  async function rebuildProfile() {
    setProfileBusy(true);
    setProfileMsg("");
    const r = await fetch("/api/profile/rebuild", { method: "POST" }).then(r => r.json()).catch(() => null);
    if (r && r.profile) { setProfile(r.profile); }
    else if (r && r.empty) setProfileMsg(r.reason === "no-memories"
      ? "Nothing to build from yet — add a preference or fact below (or tell Cortex “remember that…” in a chat), then rebuild."
      : "Couldn’t synthesize a profile right now — make sure the local model is running, then try again.");
    setProfileBusy(false);
  }
  async function saveProfile() {
    const summary = (profileDraft || "").trim();
    const r = await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ summary }) }).then(r => r.json()).catch(() => null);
    if (r) setProfile(r.profile || null);
    setProfileDraft(null);
  }

  async function toggleReflection() {
    const next = !reflection;
    setReflection(next);
    await fetch("/api/user-settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reflection: next }) }).catch(() => setReflection(!next));
  }

  async function delSkill(id) {
    if (!window.confirm("Forget this skill? The assistant will have to re-derive this procedure next time.")) return;
    await fetch("/api/skills/" + id, { method: "DELETE" }).catch(() => {});
    setSkills(s => s.filter(x => x.id !== id));
  }

  async function reindex(folder) {
    setBusy(folder);
    try { await fetch("/api/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: folder }) }); } catch {}
    setBusy(null); load();
  }
  async function clearIndex(folder) {
    if (!window.confirm("Clear the index for this folder? (the files stay; they'll re-index on next use)")) return;
    setBusy(folder);
    try { await fetch("/api/admin/index?path=" + encodeURIComponent(folder), { method: "DELETE" }); } catch {}
    setBusy(null); load();
  }
  async function removeImage(p) {
    if (!window.confirm("Remove this image's description? It won't be searchable until re-analyzed.")) return;
    setBusy(p);
    try { await fetch("/api/admin/image?path=" + encodeURIComponent(p), { method: "DELETE" }); } catch {}
    setBusy(null); load();
  }

  const shortName = f => { const parts = f.split(/[\\/]/); return parts.slice(-2).join("/"); };

  return (
    <div className="settings-scroll scroll">
      <div className="settings-wrap" style={{ maxWidth: 880 }}>
        <div className="row between" style={{ marginBottom: 22 }}>
          <div className="col" style={{ gap: 4 }}>
            <span className="serif" style={{ fontSize: 26 }}>What Cortex knows</span>
            <span className="ink-3 t-md">Memory, skills, and the indexes that power search.</span>
          </div>
          <button className="btn" onClick={load}><Icon name="refresh" size={15} /> Refresh</button>
        </div>

        {/* PROFILE — the synthesized "what Cortex knows about you" */}
        <div className="set-section">
          <div className="row between" style={{ alignItems: "flex-start", gap: 12 }}>
            <div className="col" style={{ gap: 4, minWidth: 0 }}>
              <div className="set-title"><Icon name="compass" size={18} style={{ color: "var(--accent)" }} /> What Cortex knows about you</div>
              <div className="set-sub" style={{ marginBottom: 0 }}>A short, evolving picture of you — synthesized from your preferences, instructions and past tasks — that rides along in every chat. It refreshes on its own as you teach Cortex more; edit it if anything’s off.</div>
            </div>
            <div className="row gap-2 none" style={{ flexShrink: 0 }}>
              <button className="btn sm" disabled={profileBusy} onClick={rebuildProfile} title="Re-synthesize from your memories">
                <Icon name="refresh" size={14} style={profileBusy ? { animation: "spin 1s linear infinite" } : undefined} /> Rebuild
              </button>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            {profileDraft !== null ? (
              <div className="col" style={{ gap: 8 }}>
                <textarea className="select" rows={4} style={{ width: "100%", resize: "vertical" }} value={profileDraft} onChange={e => setProfileDraft(e.target.value)} />
                <div className="row gap-2">
                  <button className="btn sm primary" onClick={saveProfile}><Icon name="check" size={14} /> Save</button>
                  <button className="btn sm" onClick={() => setProfileDraft(null)}>Cancel</button>
                </div>
              </div>
            ) : profile && profile.summary ? (
              <div className="row between" style={{ alignItems: "flex-start", gap: 12, padding: "12px 14px", border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)" }}>
                <div className="col" style={{ gap: 6, minWidth: 0 }}>
                  <span className="t-sm">{profile.summary}</span>
                  <span className="t-xs ink-4">
                    {profile.edited ? "edited by you · " : profile.sourceCount ? `from ${profile.sourceCount} note(s) · ` : ""}
                    {profile.updatedAt ? new Date(profile.updatedAt).toLocaleDateString() : ""}
                  </span>
                </div>
                <button className="btn icon sm ghost none" title="Edit" onClick={() => setProfileDraft(profile.summary)} style={{ flexShrink: 0 }}><Icon name="edit" size={15} /></button>
              </div>
            ) : (
              <div className={"t-sm " + (profileMsg ? "" : "ink-3")} style={profileMsg ? { color: "var(--accent)" } : undefined}>
                {profileMsg || "No profile yet — once you’ve taught Cortex a few preferences or facts, it’ll synthesize one (or hit Rebuild)."}
              </div>
            )}
          </div>
        </div>

        {/* MEMORY */}
        <div className="set-section">
          <div className="row between" style={{ alignItems: "flex-start", gap: 12 }}>
            <div className="col" style={{ gap: 4, minWidth: 0 }}>
              <div className="set-title"><Icon name="brain" size={18} style={{ color: "var(--accent)" }} /> Memory</div>
              <div className="set-sub" style={{ marginBottom: 0 }}>What the assistant knows about you. <b>Preferences &amp; instructions</b> apply to every chat; <b>facts &amp; past tasks</b> are recalled only when a question is about them. The agent adds these too (say “remember that…”).</div>
            </div>
            {memory.length > 0 && (
              <button className="btn sm none" style={{ color: "var(--warn)", flexShrink: 0 }} onClick={clearAllMem} title="Forget all memories">
                <Icon name="x" size={13} /> Clear all
              </button>
            )}
          </div>
          <div className="composer" style={{ margin: "12px 0" }}>
            <textarea rows={1} value={newMem} placeholder="e.g. I'm a product designer; prefer concise answers…"
              onChange={e => setNewMem(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addMem(); } }} />
            <button className="send-btn" disabled={!newMem.trim()} onClick={addMem}><Icon name="plus" size={16} /></button>
          </div>
          {loading ? <span className="dots"><span /><span /><span /></span> : memory.length === 0 ? (
            <div className="ink-3 t-sm">No memories yet — add one above, or just tell the assistant “remember that…”.</div>
          ) : (
            <div className="col" style={{ gap: 18 }}>
              {MEM_GROUPS.map(g => {
                const items = memory.filter(m => (m.type || "fact") === g.type);
                if (!items.length) return null;
                return (
                  <div key={g.type} className="col" style={{ gap: 6 }}>
                    <div className="row gap-2" style={{ alignItems: "baseline" }}>
                      <span className="semi t-sm">{g.label}</span>
                      <span className="img-badge none">{items.length}</span>
                      <span className="t-xs ink-3 truncate">{g.desc}</span>
                    </div>
                    {items.map(m => (
                      <div key={m.id} className="row-set" style={{ padding: "10px 14px" }}>
                        <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                          <span className="t-sm">{m.text}</span>
                          <span className="t-xs ink-4">
                            {m.useCount ? `used ${m.useCount}× · ` : "never used yet · "}
                            {m.updatedAt ? new Date(m.updatedAt).toLocaleDateString() : ""}
                          </span>
                        </div>
                        <select className="select none" style={{ width: 112, fontSize: 11.5, padding: "3px 6px" }} value={m.type || "fact"}
                          title="preference/instruction: always applied · fact/past task: recalled when relevant"
                          onChange={e => retypeMem(m, e.target.value)}>
                          <option value="preference">preference</option>
                          <option value="instruction">instruction</option>
                          <option value="fact">fact</option>
                          <option value="episode">past task</option>
                        </select>
                        {m.source === "auto" && <span className="img-badge none" title="captured automatically by the agent">auto</span>}
                        {m.source === "reflection" && <span className="img-badge none" title="corrected by reflection after a session">revised</span>}
                        <button className="btn icon sm ghost none" title="Forget" onClick={() => delMem(m.id)} style={{ color: "var(--warn)" }}><Icon name="x" size={15} /></button>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* SKILLS */}
        <div className="set-section">
          <div className="set-title"><Icon name="bolt" size={18} style={{ color: "var(--accent)" }} /> Skills</div>
          <div className="set-sub">Reusable how-to procedures the assistant worked out and saved, so it can re-apply them instead of figuring them out again. Captured automatically from finished tasks, or when you say “save this as a skill”.</div>
          <label className="row between" style={{ gap: 12, margin: "10px 0 2px", padding: "10px 14px", border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)", cursor: "pointer" }}>
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <span className="semi t-sm">Reflection <span className="img-badge none">experimental</span></span>
              <span className="t-xs ink-3">After a chat ends, let Cortex review it and quietly correct any saved memory or skill the conversation proved wrong. Off by default; revised items are tagged so you can undo them.</span>
            </div>
            <input type="checkbox" checked={reflection} onChange={toggleReflection} style={{ flexShrink: 0, width: 16, height: 16 }} />
          </label>
          {loading ? <span className="dots"><span /><span /><span /></span> : skills.length === 0 ? (
            <div className="ink-3 t-sm">No skills yet — when the assistant solves a repeatable, multi-step task, it’ll save the procedure here.</div>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              {skills.map(s => (
                <div key={s.id} className="col" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)", overflow: "hidden" }}>
                  <div className="row gap-2" style={{ padding: "10px 14px", alignItems: "flex-start", cursor: "pointer" }} onClick={() => setOpenSkill(o => o === s.id ? null : s.id)}>
                    <Icon name={openSkill === s.id ? "chevD" : "chevR"} size={15} style={{ marginTop: 2, flexShrink: 0, color: "var(--ink-3)" }} />
                    <div className="col grow" style={{ gap: 3, minWidth: 0 }}>
                      <span className="semi t-sm">{s.title}</span>
                      {s.trigger && <span className="t-xs ink-3">Use when {s.trigger}</span>}
                      <span className="t-xs ink-4">
                        {s.useCount ? `recalled ${s.useCount}× · ` : "never recalled yet · "}
                        {s.updatedAt ? new Date(s.updatedAt).toLocaleDateString() : ""}
                      </span>
                    </div>
                    {s.source === "auto" && <span className="img-badge none" title="captured automatically">auto</span>}
                    <button className="btn icon sm ghost none" title="Forget skill" onClick={e => { e.stopPropagation(); delSkill(s.id); }} style={{ color: "var(--warn)" }}><Icon name="x" size={15} /></button>
                  </div>
                  {openSkill === s.id && (
                    <div className="t-sm" style={{ padding: "0 14px 12px 33px", borderTop: "1px solid var(--line)", paddingTop: 10 }}>
                      {fmt(s.steps || "")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* INDEXES */}
        <div className="set-section">
          <div className="set-title"><Icon name="layers" size={18} style={{ color: "var(--accent)" }} /> Indexes</div>
          <div className="set-sub">Each browsed folder and the knowledge base has a cached vector index.</div>
          {loading ? <span className="dots"><span /><span /><span /></span> : indexes.length === 0 ? (
            <div className="ink-3 t-sm">No indexes yet — open a folder or upload to the knowledge base.</div>
          ) : indexes.map(ix => (
            <div key={ix.folder} className="row-set" style={{ marginBottom: 8 }}>
              <div className="col grow" style={{ gap: 2, minWidth: 0 }}>
                <span className="semi truncate" title={ix.folder}>
                  {ix.isKB ? <span className="img-badge ok" style={{ marginRight: 6 }}>KB</span> : null}
                  {ix.isKB ? "Knowledge base" : shortName(ix.folder)}
                </span>
                <span className="t-xs ink-3 mono">{ix.files} files · {ix.chunks} chunks{ix.updatedAt ? " · " + new Date(ix.updatedAt).toLocaleString() : ""}</span>
              </div>
              <div className="row gap-2 none">
                {!ix.isKB && <button className="btn sm" onClick={() => onOpenFolder && onOpenFolder(ix.folder)} title="Open in gallery"><Icon name="folderOpen" size={14} /></button>}
                <button className="btn sm" disabled={busy === ix.folder} onClick={() => reindex(ix.folder)}>
                  <Icon name="refresh" size={14} style={busy === ix.folder ? { animation: "spin 1s linear infinite" } : undefined} /> Reindex
                </button>
                <button className="btn sm" onClick={() => clearIndex(ix.folder)} style={{ color: "var(--warn)" }}><Icon name="x" size={14} /> Clear</button>
              </div>
            </div>
          ))}
        </div>

        {/* IMAGE DESCRIPTIONS */}
        <div className="set-section">
          <div className="set-title"><Icon name="image" size={18} style={{ color: "var(--accent)" }} /> Image descriptions</div>
          <div className="set-sub">Images made searchable via the vision model. Removing one drops it from search until re-analyzed.</div>
          {loading ? null : images.length === 0 ? (
            <div className="ink-3 t-sm">No image descriptions yet — open an image and use “Make searchable”.</div>
          ) : (
            <div className="col" style={{ gap: 10 }}>
              {images.map(im => (
                <div key={im.path} className="row gap-3" style={{ alignItems: "flex-start", padding: 12, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)" }}>
                  <div className="src-thumb" style={{ width: 64, height: 64 }}><img src={thumbUrl(im.path, 160)} alt={im.name} loading="lazy" /></div>
                  <div className="col grow" style={{ gap: 4, minWidth: 0 }}>
                    <span className="semi truncate" title={im.path}>{im.name}</span>
                    {im.context && <span className="t-xs" style={{ color: "var(--accent)" }}>Context: {im.context}</span>}
                    <span className="t-xs ink-3" style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{im.description}</span>
                  </div>
                  <button className="btn icon sm none" title="Remove description" disabled={busy === im.path} onClick={() => removeImage(im.path)} style={{ color: "var(--warn)" }}><Icon name="x" size={15} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export { ManagePage };
