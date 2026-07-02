import { Icon, KIND_META, kindFromName, fileUrl } from "./icons.jsx";
import { ChatAPI } from "./chat-data.jsx";
// projects.jsx — per-project workspaces: custom instructions, KB files, and grouped chats
const { useState: useSt, useEffect: useEff, useRef: useR } = React;

function projRelTime(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  if (d < 604800) return Math.floor(d / 86400) + "d ago";
  return new Date(t).toLocaleDateString();
}
function projBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(1) + " MB";
}

const PROJECT_COLORS = ["#6366f1","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#8b5cf6","#06b6d4","#f97316","#84cc16"];
const PROJECT_ICONS  = ["sparkles","layers","folder","file","image","music","video","grid","bolt","compass"];

const ProjectAPI = {
  list:     ()       => fetch("/api/projects").then(r => r.json()).then(j => j.projects || []).catch(() => []),
  create:   data     => fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(r => r.json()),
  update:   (id, d)  => fetch(`/api/projects/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(d) }).then(r => r.json()),
  remove:   id       => fetch(`/api/projects/${id}`, { method: "DELETE" }).then(r => r.json()),
  listKB:   id       => fetch(`/api/projects/${id}/kb`).then(r => r.json()).then(j => j.files || []).catch(() => []),
  removeKB: (id, p)  => fetch(`/api/projects/${id}/kb?path=${encodeURIComponent(p)}`, { method: "DELETE" }).then(r => r.json()),
};

/* ---- edit / create modal ---- */
function ProjectEditModal({ project, onSave, onClose }) {
  const [name,         setName]         = useSt(project ? project.name         : "");
  const [description,  setDesc]         = useSt(project ? project.description  : "");
  const [instructions, setInst]         = useSt(project ? project.instructions : "");
  const [color,        setColor]        = useSt(project ? project.color        : PROJECT_COLORS[0]);
  const [icon,         setIcon]         = useSt(project ? project.icon         : PROJECT_ICONS[0]);
  const [busy,         setBusy]         = useSt(false);
  const [err,          setErr]          = useSt(null);

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setErr("Name is required");
    setBusy(true); setErr(null);
    try {
      const data = { name: name.trim(), description, instructions, color, icon };
      const j = project ? await ProjectAPI.update(project.id, data) : await ProjectAPI.create(data);
      if (j.error) throw new Error(j.error);
      onSave(j.project);
    } catch (e) { setErr(e.message); setBusy(false); }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="proj-modal" onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 16 }}>
          <span className="x-bold tighter" style={{ fontSize: 17 }}>
            <Icon name={icon} size={16} style={{ color }} /> {project ? "Edit project" : "New project"}
          </span>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="x" size={15} /></button>
        </div>

        <form onSubmit={submit}>
          {/* color + icon row */}
          <div className="row gap-2" style={{ marginBottom: 14 }}>
            <div className="col" style={{ gap: 6 }}>
              <span className="field-label">Color</span>
              <div className="proj-swatches">
                {PROJECT_COLORS.map(c => (
                  <button key={c} type="button" className={"proj-swatch" + (color === c ? " on" : "")}
                    style={{ background: c }} onClick={() => setColor(c)} />
                ))}
              </div>
            </div>
            <div className="col" style={{ gap: 6 }}>
              <span className="field-label">Icon</span>
              <div className="proj-swatches">
                {PROJECT_ICONS.map(ic => (
                  <button key={ic} type="button" className={"proj-icon-btn" + (icon === ic ? " on" : "")}
                    style={{ color: icon === ic ? color : "var(--ink-3)" }} onClick={() => setIcon(ic)}>
                    <Icon name={ic} size={14} />
                  </button>
                ))}
              </div>
            </div>
          </div>

          <label className="field-label" style={{ marginBottom: 4, display: "block" }}>Name</label>
          <input className="ex-input" autoFocus placeholder="e.g. Research, Client work…"
            value={name} onChange={e => setName(e.target.value)} maxLength={80} style={{ marginBottom: 12 }} />

          <label className="field-label" style={{ marginBottom: 4, display: "block" }}>Description <span className="ink-3">(optional)</span></label>
          <input className="ex-input" placeholder="Short summary of this project"
            value={description} onChange={e => setDesc(e.target.value)} maxLength={500} style={{ marginBottom: 12 }} />

          <label className="field-label" style={{ marginBottom: 4, display: "block" }}>Custom instructions <span className="ink-3">(optional)</span></label>
          <textarea className="textarea" rows={5} placeholder={"Tell the AI how to behave in this project.\ne.g. 'Always respond in bullet points. Focus on tax implications.'"}
            value={instructions} onChange={e => setInst(e.target.value)} maxLength={4000} style={{ fontSize: 13 }} />

          {err && <div className="callout warn" style={{ marginTop: 10 }}><Icon name="alert" size={14} /><span>{err}</span></div>}

          <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
            <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? <><span className="spin-mini" /> Saving…</> : (project ? "Save" : "Create project")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---- project view: chats + KB panel ---- */
function ProjectView({ project, onNewChat, onOpenSession, onEdit, onDelete, onOpenPath, tab, setTab }) {
  const [chats,    setChats]    = useSt([]);
  const [kbFiles,  setKbFiles]  = useSt([]);
  const [loading,  setLoading]  = useSt(true);
  const [q,        setQ]        = useSt("");
  const [editing,  setEditing]  = useSt(null);
  const [uploading,setUploading]= useSt(false);
  const fileRef = useR(null);

  function reload() {
    setLoading(true);
    Promise.all([
      ChatAPI.all("").then(all => all.filter(s => s.projectId === project.id)),
      ProjectAPI.listKB(project.id),
    ]).then(([c, k]) => { setChats(c); setKbFiles(k); setLoading(false); });
  }
  useEff(() => { reload(); }, [project.id]);

  async function deleteChat(s, e) {
    e.stopPropagation();
    if (!window.confirm("Delete this chat?")) return;
    await ChatAPI.del(s.fileId, s.id);
    setChats(prev => prev.filter(x => x.id !== s.id));
  }
  async function renameChat(s, title) {
    setEditing(null);
    if (title && title !== s.title) { await ChatAPI.patch(s.fileId, s.id, { title }); reload(); }
  }
  async function pinChat(s, e) {
    e.stopPropagation();
    await ChatAPI.patch(s.fileId, s.id, { pinned: !s.pinned });
    reload();
  }

  async function uploadFiles(fileList) {
    if (!fileList.length) return;
    setUploading(true);
    const fd = new FormData();
    [...fileList].forEach(f => fd.append("files", f));
    try {
      await fetch(`/api/projects/${project.id}/kb/upload`, { method: "POST", body: fd });
      const k = await ProjectAPI.listKB(project.id);
      setKbFiles(k);
    } catch {}
    setUploading(false);
  }

  async function removeKBFile(f) {
    if (!window.confirm(`Remove "${f.name}" from this project?`)) return;
    await ProjectAPI.removeKB(project.id, f.path);
    setKbFiles(prev => prev.filter(x => x.path !== f.path));
  }

  const filtered = chats.filter(s => !q || (s.title || "").toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      {/* topbar */}
      <div className="topbar">
        <div className="crumb grow" style={{ gap: 8 }}>
          <span className="proj-dot" style={{ background: project.color }} />
          <Icon name={project.icon} size={17} style={{ color: project.color }} />
          <span className="crumb-name">{project.name}</span>
          {project.description && <span className="t-sm ink-3 none">— {project.description}</span>}
        </div>
        <div className="row gap-2">
          <button className="btn sm" title="Edit project" onClick={onEdit}><Icon name="edit" size={14} /> Edit</button>
          <button className="btn sm primary" onClick={onNewChat}><Icon name="plus" size={14} /> New chat</button>
        </div>
      </div>

      {/* tab bar */}
      <div className="proj-tabs">
        <button className={"proj-tab" + (tab === "chats" ? " on" : "")} onClick={() => setTab("chats")}>
          <Icon name="clock" size={14} /> Chats {chats.length > 0 && <span className="proj-tab-count">{chats.length}</span>}
        </button>
        <button className={"proj-tab" + (tab === "files" ? " on" : "")} onClick={() => setTab("files")}>
          <Icon name="layers" size={14} /> Files {kbFiles.length > 0 && <span className="proj-tab-count">{kbFiles.length}</span>}
        </button>
        <div className="grow" />
        <button className="btn icon sm ghost" title="Delete project" style={{ color: "var(--warn)" }} onClick={onDelete}><Icon name="x" size={14} /></button>
      </div>

      {/* content */}
      <div className="content" style={{ display: "block", overflow: "auto", padding: "16px 20px" }}>
        {tab === "chats" ? (
          <>
            {chats.length > 5 && (
              <div className="chats-search" style={{ marginBottom: 12 }}>
                <Icon name="search" size={15} style={{ color: "var(--ink-3)", flex: "none" }} />
                <input placeholder="Search chats…" value={q} onChange={e => setQ(e.target.value)} />
                {q && <button className="btn icon sm ghost" onClick={() => setQ("")}><Icon name="x" size={13} /></button>}
              </div>
            )}
            {loading ? (
              <div className="ink-3" style={{ padding: 16 }}>Loading…</div>
            ) : !filtered.length ? (
              <div className="col center" style={{ padding: "48px 0", gap: 12 }}>
                <Icon name="sparkles" size={32} style={{ color: project.color, opacity: 0.4 }} />
                <div className="x-bold" style={{ fontSize: 15 }}>No chats yet</div>
                <div className="ink-3 t-sm" style={{ maxWidth: 280, textAlign: "center" }}>
                  Start a conversation in this project to see it here.
                </div>
                <button className="btn primary" style={{ marginTop: 4 }} onClick={onNewChat}>
                  <Icon name="plus" size={15} /> New chat
                </button>
              </div>
            ) : (
              <div className="chats-list">
                {filtered.map(s => (
                  <div key={s.id} className="chat-card" onClick={() => onOpenSession(s)}>
                    <Icon name="sparkles" size={16} style={{ color: project.color, flex: "none", marginTop: 2 }} />
                    <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
                      {editing === s.id ? (
                        <input className="chat-rename" autoFocus defaultValue={s.title}
                          onClick={e => e.stopPropagation()}
                          onBlur={e => renameChat(s, e.target.value.trim())}
                          onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }} />
                      ) : (
                        <span className="truncate semi" style={{ fontSize: 14 }}>{s.title || "New chat"}</span>
                      )}
                      <span className="t-xs ink-3">{s.count} msg{s.count === 1 ? "" : "s"} · {projRelTime(s.updatedAt)}</span>
                    </div>
                    {s.pinned && <Icon name="star" size={13} style={{ color: "var(--accent)", flex: "none" }} />}
                    <div className="chat-card-actions" onClick={e => e.stopPropagation()}>
                      <button className="btn icon sm ghost" title={s.pinned ? "Unpin" : "Pin"} onClick={e => pinChat(s, e)}><Icon name="star" size={13} /></button>
                      <button className="btn icon sm ghost" title="Rename" onClick={e => { e.stopPropagation(); setEditing(s.id); }}><Icon name="edit" size={13} /></button>
                      <button className="btn icon sm ghost" title="Delete" onClick={e => deleteChat(s, e)}><Icon name="x" size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="row between" style={{ marginBottom: 12 }}>
              <span className="t-sm ink-3">Files added here are used as context for all chats in this project.</span>
              <div className="row gap-2">
                {uploading && <span className="spin-mini" style={{ margin: "0 4px" }} />}
                <button className="btn sm" onClick={() => fileRef.current && fileRef.current.click()} disabled={uploading}>
                  <Icon name="upload" size={14} /> Add files
                </button>
                <input ref={fileRef} type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.jpg,.jpeg,.png,.webp,.gif" style={{ display: "none" }}
                  onChange={e => { uploadFiles(e.target.files); e.target.value = ""; }} />
              </div>
            </div>
            {loading ? (
              <div className="ink-3" style={{ padding: 16 }}>Loading…</div>
            ) : !kbFiles.length ? (
              <div className="col center" style={{ padding: "48px 0", gap: 10 }}>
                <Icon name="layers" size={32} style={{ color: "var(--ink-4)", opacity: 0.4 }} />
                <div className="x-bold" style={{ fontSize: 15 }}>No files yet</div>
                <div className="ink-3 t-sm" style={{ maxWidth: 280, textAlign: "center" }}>
                  Add documents, PDFs, or images. The AI will use them as context when chatting in this project.
                </div>
                <button className="btn sm" style={{ marginTop: 4 }} onClick={() => fileRef.current && fileRef.current.click()}>
                  <Icon name="upload" size={14} /> Add files
                </button>
              </div>
            ) : (
              <div className="col" style={{ gap: 6 }}>
                {kbFiles.map(f => (
                  <div key={f.path} className="proj-file-row" style={{ cursor: "pointer" }} onClick={() => onOpenPath && onOpenPath(f.path)}>
                    <Icon name={(KIND_META[kindFromName(f.name)] || KIND_META.doc).icon} size={15} style={{ color: "var(--ink-3)", flex: "none" }} />
                    <span className="truncate grow t-sm">{f.name}</span>
                    <span className="ink-3 t-xs" style={{ flex: "none" }}>{projBytes(f.size)}</span>
                    <a className="btn icon sm ghost" title="Download" href={fileUrl(f.path)} download={f.name}
                      onClick={e => e.stopPropagation()}><Icon name="download" size={13} /></a>
                    <button className="btn icon sm ghost" title="Remove" onClick={e => { e.stopPropagation(); removeKBFile(f); }}><Icon name="x" size={13} /></button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ---- projects hub — full-page grid of all projects ---- */
function ProjectsHub({ projects, onOpen, onNew }) {
  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="topbar">
        <div className="crumb grow" style={{ gap: 8 }}>
          <Icon name="layers" size={17} style={{ color: "var(--accent)" }} />
          <span className="crumb-name">Projects</span>
          {projects.length > 0 && <span className="t-sm ink-3">· {projects.length}</span>}
        </div>
        <button className="btn sm primary" onClick={onNew}>
          <Icon name="plus" size={14} /> New project
        </button>
      </div>
      <div className="content" style={{ display: "block", overflow: "auto" }}>
        {!projects.length ? (
          <div className="col center" style={{ padding: "64px 24px", gap: 14, textAlign: "center" }}>
            <Icon name="layers" size={36} style={{ color: "var(--accent)", opacity: .4 }} />
            <div className="x-bold" style={{ fontSize: 16 }}>No projects yet</div>
            <div className="ink-3 t-sm" style={{ maxWidth: 320 }}>
              Create a project to group chats, add custom instructions, and attach files.
            </div>
            <button className="btn primary" style={{ marginTop: 4 }} onClick={onNew}>
              <Icon name="plus" size={15} /> New project
            </button>
          </div>
        ) : (
          <div className="tile-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", maxWidth: 940 }}>
            {projects.map(p => (
              <button key={p.id} className="entity-card" onClick={() => onOpen(p)}>
                <span className="entity-ico" style={{ background: p.color + "1a", color: p.color }}>
                  <Icon name={p.icon || "layers"} size={22} />
                </span>
                <span className="semi" style={{ fontSize: 15 }}>{p.name}</span>
                {p.description && <span className="t-xs ink-3">{p.description}</span>}
              </button>
            ))}
            <button className="entity-card" style={{ borderStyle: "dashed", color: "var(--ink-3)" }} onClick={onNew}>
              <span className="entity-ico" style={{ background: "var(--surface-2)", color: "var(--ink-3)" }}>
                <Icon name="plus" size={22} />
              </span>
              <span className="semi t-sm">New project</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export { ProjectAPI, ProjectView, ProjectEditModal, ProjectsHub };
