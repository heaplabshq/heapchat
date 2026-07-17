import { Gallery } from "./gallery.jsx";
import { App, CARD_W } from "./app.jsx";
import { Icon } from "./icons.jsx";
/* Gallery body: the scrollable folder contents — KB drag/drop upload zone, the
   hidden file <input>, loading / "build your KB" empty states, the tag filter
   row, and the Gallery grid itself. Extracted from the App god component in
   app.jsx. Global-scope module (indirect-eval): GalleryBody leaks to global for
   app.jsx; Icon (icons.jsx) and Gallery (gallery.jsx) resolve as globals at
   render time. App folder state + handlers come in as props (CARD_W is passed
   as colW since it's a file-local const in app.jsx). */

function GalleryBody({
  dragOver, setDragOver, uploadToKB, folder, fileInputRef, loadingFiles, shown, uploading,
  folderTags, tagFilter, setTagFilter, shownDirs, colW, focusFile, setFocusFile, loadFolder,
  deleteFromKB, selected, toggleCheck,
}) {
  return (
    <div className={"gallery-scroll scroll" + (dragOver ? " drag-over" : "")}
      onDragOver={folder.kb ? (e => { e.preventDefault(); setDragOver(true); }) : undefined}
      onDragLeave={folder.kb ? (() => setDragOver(false)) : undefined}
      onDrop={folder.kb ? (e => { e.preventDefault(); setDragOver(false); uploadToKB(e.dataTransfer.files); }) : undefined}>
      {folder.kb && (
        <input ref={fileInputRef} type="file" multiple hidden
          accept=".txt,.md,.markdown,.csv,.json,.xml,.yml,.yaml,.html,.htm,.css,.js,.jsx,.ts,.tsx,.py,.go,.rs,.java,.rb,.php,.sh,.c,.cpp,.h,.log,.pdf,.docx"
          onChange={e => { uploadToKB(e.target.files); e.target.value = ""; }} />
      )}
      {loadingFiles ? (
        <div className="col center" style={{ padding: 80, color: "var(--ink-3)", gap: 12 }}>
          <span className="dots"><span /><span /><span /></span>
          <span className="t-sm">Loading…</span>
        </div>
      ) : folder.kb && shown.length === 0 ? (
        <div className="empty" style={{ padding: 24 }}>
          <div className="dropzone" onClick={() => fileInputRef.current && fileInputRef.current.click()} style={{ cursor: "pointer" }}>
            <div className="dz-mark"><Icon name="upload" size={30} sw={1.6} /></div>
            <div className="x-bold tighter" style={{ fontSize: 22, marginBottom: 8 }}>Build your knowledge base</div>
            <div className="ink-3 t-md" style={{ marginBottom: 22, maxWidth: 380, marginInline: "auto" }}>
              Drop files here or click to upload. Heap Chat indexes them so you can ask questions across everything — PDFs, Word docs, Markdown, CSV, code & text.
            </div>
            <button className="btn primary" disabled={uploading}><Icon name="upload" size={16} /> {uploading ? "Uploading…" : "Upload files"}</button>
          </div>
        </div>
      ) : (
        <>
          {folderTags.length > 0 && (
            <div className="row gap-2 wrap" style={{ marginBottom: 16 }}>
              <span className="t-xs up none" style={{ alignSelf: "center" }}><Icon name="tag" size={12} /> Tags</span>
              {folderTags.map(t => (
                <button key={t} className={"chip" + (tagFilter === t ? " on" : "")} onClick={() => setTagFilter(tagFilter === t ? null : t)}>{t}</button>
              ))}
            </div>
          )}
          <Gallery dirs={shownDirs} files={shown} colW={colW} selectedId={focusFile?.id}
            onOpen={setFocusFile} onOpenFolder={d => loadFolder(d.path)} onDelete={folder.kb ? deleteFromKB : null}
            checkedSet={selected} onToggleCheck={toggleCheck} />
        </>
      )}
    </div>
  );
}

export { GalleryBody };
