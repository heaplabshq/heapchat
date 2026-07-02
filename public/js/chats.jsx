import { KIND_META, kindFromName, Icon, downloadJSON } from "./icons.jsx";
import { ChatAPI, newId } from "./chat-data.jsx";
// chats.jsx — global Chats hub: search, pin, rename, delete, and reopen any conversation
function relTime(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return Math.floor(d / 60) + "m ago";
  if (d < 86400) return Math.floor(d / 3600) + "h ago";
  if (d < 604800) return Math.floor(d / 86400) + "d ago";
  return new Date(t).toLocaleDateString();
}
// figure out where a session lives (for label + navigation), from its stored source or its fileId
function sessionSource(s) {
  const src = s.source || {};
  // a project chat lives under the project (fileId "proj-<id>"), NOT the knowledge base — must be caught
  // BEFORE the agent/kb branch below, else it opens against the KB store and comes up blank.
  const projectId = s.projectId || (typeof src.id === "string" && src.id.startsWith("proj-") ? src.id.slice(5) : null);
  if (projectId) return { icon: "layers", label: src.name || "Project", kind: "project", projectId };
  if (s.fileId === "agent" || src.id === "agent" || (src.scope === "agent" && src.domain === "kb"))
    return { icon: "sparkles", label: "Knowledge base", kind: "kb" };
  if (src.scope === "general") return { icon: "sparkles", label: "General", kind: "kb" };
  let p = src.path;
  if (!p && s.fileId && s.fileId !== "agent") { try { p = decodeURIComponent(escape(atob(s.fileId.replace(/-/g, "+").replace(/_/g, "/")))); } catch {} }
  const name = src.name || (p ? p.split("/").pop() : "Chat");
  const isFolder = src.domain === "folder";
  return { icon: isFolder ? "folder" : (KIND_META[kindFromName(name)] || KIND_META.doc).icon, label: name, path: p, kind: isFolder ? "folder" : "file" };
}

function ChatsHub({ onOpen }) {
  const [q, setQ] = React.useState("");
  const [items, setItems] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState(null);
  const [err, setErr] = React.useState(null);
  const fileRef = React.useRef(null);

  function reload(query) { setLoading(true); ChatAPI.all(query).then(list => { setItems(list); setLoading(false); }); }
  React.useEffect(() => { const t = setTimeout(() => reload(q), 200); return () => clearTimeout(t); }, [q]);

  async function pin(s, e) { e.stopPropagation(); await ChatAPI.patch(s.fileId, s.id, { pinned: !s.pinned }); reload(q); }
  async function rename(s, title) { setEditing(null); if (title && title !== s.title) { await ChatAPI.patch(s.fileId, s.id, { title }); reload(q); } }
  async function del(s, e) { e.stopPropagation(); if (!window.confirm("Delete this chat permanently?")) return; await ChatAPI.del(s.fileId, s.id); reload(q); }
  async function exportChat(s, e) {
    e.stopPropagation();
    const full = await ChatAPI.get(s.fileId, s.id);
    if (!full) return;
    downloadJSON({ title: full.title, messages: full.messages, createdAt: full.createdAt }, full.title || "chat");
  }
  async function importFile(file) {
    setErr(null);
    try {
      const data = JSON.parse(await file.text());
      if (!data || !Array.isArray(data.messages)) throw new Error("Not a valid chat export");
      const j = await ChatAPI.save("agent", newId(), data.title || "Imported chat", data.messages, null, false, null, null);
      if (!j) throw new Error("Import failed");
      reload(q);
    } catch (e) { setErr(e.message || "Couldn't import that file"); }
  }

  return (
    <div className="col grow" style={{ minHeight: 0 }}>
      <div className="topbar">
        <div className="crumb grow">
          <Icon name="clock" size={18} style={{ color: "var(--accent)" }} />
          <span className="crumb-name">Chats</span>
          {!loading && <span className="t-sm ink-3 none">· {items.length}</span>}
        </div>
        <button className="btn sm ghost" onClick={() => fileRef.current && fileRef.current.click()}>
          <Icon name="upload" size={14} /> Import
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: "none" }}
          onChange={e => { const f = e.target.files[0]; e.target.value = ""; if (f) importFile(f); }} />
      </div>
      <div className="content" style={{ display: "block", overflow: "auto", padding: "16px 20px" }}>
        <div className="chats-search">
          <Icon name="search" size={15} style={{ color: "var(--ink-3)", flex: "none" }} />
          <input autoFocus placeholder="Search all conversations by title or content…" value={q} onChange={e => setQ(e.target.value)} />
          {q && <button className="btn icon sm ghost" onClick={() => setQ("")}><Icon name="x" size={13} /></button>}
        </div>
        {err && <div className="callout warn" style={{ marginBottom: 12 }}><Icon name="alert" size={14} /><span>{err}</span></div>}
        {loading ? (
          <div className="ink-3" style={{ padding: 24 }}>Loading…</div>
        ) : !items.length ? (
          <div className="ink-3" style={{ padding: 24 }}>{q ? "No chats match your search." : "No saved chats yet — start a conversation and it'll show up here."}</div>
        ) : (
          <div className="chats-list">
            {items.map(s => {
              const info = sessionSource(s);
              return (
                <div key={s.fileId + s.id} className="chat-card" onClick={() => onOpen(s, info)}>
                  <Icon name={info.icon} size={16} style={{ color: "var(--ink-3)", flex: "none", marginTop: 2 }} />
                  <div className="col grow" style={{ minWidth: 0, gap: 2 }}>
                    {editing === s.id ? (
                      <input className="chat-rename" autoFocus defaultValue={s.title}
                        onClick={e => e.stopPropagation()}
                        onBlur={e => rename(s, e.target.value.trim())}
                        onKeyDown={e => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setEditing(null); }} />
                    ) : (
                      <span className="truncate semi" style={{ fontSize: 14 }}>{s.title || "New chat"}</span>
                    )}
                    <span className="t-xs ink-3 truncate">{info.label} · {s.count} msg{s.count === 1 ? "" : "s"} · {relTime(s.updatedAt)}</span>
                  </div>
                  {s.pinned && <Icon name="star" size={13} style={{ color: "var(--accent)", flex: "none", marginTop: 3 }} />}
                  <div className="chat-card-actions" onClick={e => e.stopPropagation()}>
                    <button className="btn icon sm ghost" title={s.pinned ? "Unpin" : "Pin"} onClick={e => pin(s, e)}><Icon name="star" size={13} /></button>
                    <button className="btn icon sm ghost" title="Export as JSON" onClick={e => exportChat(s, e)}><Icon name="download" size={13} /></button>
                    <button className="btn icon sm ghost" title="Rename" onClick={e => { e.stopPropagation(); setEditing(s.id); }}><Icon name="edit" size={13} /></button>
                    <button className="btn icon sm ghost" title="Delete" onClick={e => del(s, e)}><Icon name="x" size={13} /></button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export { ChatsHub, relTime, sessionSource };
