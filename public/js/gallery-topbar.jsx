import { Gallery } from "./gallery.jsx";
import { App } from "./app.jsx";
import { Icon } from "./icons.jsx";
/* Gallery topbar: the folder-browser toolbar (up/breadcrumbs, search, sort,
   upload, index status, Map/People/Duplicates/Extract/Ask, refresh). Extracted
   from the App god component in app.jsx. Global-scope module (indirect-eval):
   GalleryTopbar leaks to global for app.jsx; Icon (icons.jsx) and React resolve
   as globals at render time. All App folder state + handlers come in as props;
   fileInputRef is the shared ref to the hidden <input> that stays in App's body. */

function GalleryTopbar({
  parent, loadFolder, crumbs, folder, shown, shownDirs, query, setQuery, sort, setSort,
  sortOpen, setSortOpen, uploading, fileInputRef, idx, runIndex, counts, setView,
  setPeopleOrigin, setPeopleFolder, setDupOpen, setExtractTarget, folderChatOpen, setFolderChatOpen,
}) {
  return (
    <div className="topbar">
      <button className="btn icon sm none" title="Up to parent folder" disabled={!parent}
        onClick={() => parent && loadFolder(parent)}><Icon name="arrowL" size={16} /></button>
      <div className="crumb grow">
        <Icon name="folderOpen" size={18} style={{ flex: "none" }} />
        <div className="crumbs">
          {crumbs.length === 0
            ? <span className="crumb-seg last">{folder.name}</span>
            : crumbs.map((c, i) => (
              <React.Fragment key={c.path}>
                {i > 0 && <Icon name="chevR" size={13} className="crumb-sep" style={{ color: "var(--ink-4)" }} />}
                {i === crumbs.length - 1
                  ? <span className="crumb-seg last">{c.name}</span>
                  : <button className="crumb-seg" onClick={() => loadFolder(c.path)}>{c.name}</button>}
              </React.Fragment>
            ))}
        </div>
        <span className="t-sm ink-3 mono none">· {shown.length} file{shown.length === 1 ? "" : "s"}{shownDirs.length ? ` · ${shownDirs.length} folder${shownDirs.length === 1 ? "" : "s"}` : ""}</span>
      </div>
      <div className="search" style={{ width: 260 }}>
        <Icon name="search" size={16} style={{ color: "var(--ink-3)" }} />
        <input value={query} placeholder="Search names & contents…" onChange={e => setQuery(e.target.value)} />
        {query && <button className="btn icon sm ghost" onClick={() => setQuery("")}><Icon name="x" size={14} /></button>}
      </div>
      <div className="dropdown none">
        <button className="btn" onClick={() => setSortOpen(o => !o)}>
          <Icon name="sliders" size={15} /> {sort === "recent" ? "Recent" : sort === "name" ? "Name" : sort === "size" ? "Size" : "Type"} <Icon name="chevD" size={14} style={{ color: "var(--ink-3)" }} />
        </button>
        {sortOpen && <>
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setSortOpen(false)} />
          <div className="dd-menu" style={{ width: 150, left: "auto", right: 0 }}>
            {[["recent", "Recent"], ["name", "Name"], ["type", "Type"], ["size", "Size"]].map(([k, l]) => (
              <div key={k} className={"dd-item" + (sort === k ? " on" : "")} onClick={() => { setSort(k); setSortOpen(false); }}>
                {l}{sort === k && <Icon name="check" size={15} style={{ marginLeft: "auto" }} />}
              </div>
            ))}
          </div>
        </>}
      </div>
      {folder.kb && (
        <button className="btn" title="Upload files to the knowledge base" disabled={uploading}
          onClick={() => fileInputRef.current && fileInputRef.current.click()}>
          <Icon name={uploading ? "clock" : "upload"} size={15} /> {uploading ? "Uploading…" : "Upload"}
        </button>
      )}
      {idx.state === "indexing" && <span className="t-xs ink-3 row gap-1 none" title="Embedding text files for content search"><span className="spin-mini" /> Indexing…</span>}
      {idx.state === "ready" && <span className="t-xs ink-3 row gap-1 none" title={`${idx.chunks} chunks indexed`} style={{ color: "var(--good)" }}><Icon name="check" size={12} /> searchable</span>}
      {idx.state === "manual" && <button className="btn sm none" title="Embed this folder's text files so you can search by content" onClick={() => runIndex(folder.path)}><Icon name="search" size={14} /> Index {idx.count} files</button>}
      {counts.photo >= 1 && (
        <button className="btn none" title="Show photos with GPS location data on a map"
          onClick={() => setView("map")}><Icon name="globe" size={15} /> Map</button>
      )}
      {counts.photo >= 2 && (
        <button className="btn none" title="Find and group people by face (runs on your device)"
          onClick={() => { setPeopleOrigin("gallery"); setPeopleFolder(folder); setView("people"); }}><Icon name="brain" size={15} /> People</button>
      )}
      {counts.photo >= 2 && (
        <button className="btn none" title="Find duplicate & near-duplicate photos (bursts, copies, edits)"
          onClick={() => setDupOpen(true)}><Icon name="copy" size={15} /> Duplicates</button>
      )}
      <button className="btn none" title="Extract fields from every document & photo here into a table (vision OCR for images)"
        onClick={() => setExtractTarget(folder)}><Icon name="grid" size={15} /> Extract</button>
      <button className={"btn none" + (folderChatOpen ? " primary" : "")} title={folder.kb ? "Ask the AI about your knowledge base" : "Ask the AI about this whole folder"}
        onClick={() => setFolderChatOpen(o => !o)}><Icon name="sparkles" size={15} /> {folder.kb ? "Ask KB" : "Ask folder"}</button>
      <button className="btn icon" title="Refresh" onClick={() => loadFolder(folder.path, false)}><Icon name="refresh" size={16} /></button>
    </div>
  );
}

export { GalleryTopbar };
