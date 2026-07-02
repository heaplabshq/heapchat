import { App } from "./app.jsx";
import { Icon } from "./icons.jsx";
/* Batch-ops bar: the floating toolbar shown when files are multi-selected in the
   gallery (Ask AI / Auto-tag / Rename / Add to KB / Tag / Make searchable /
   Delete / Clear). Extracted from the App god component in app.jsx. Global-scope
   module (indirect-eval): BatchBar leaks to global for app.jsx; Icon resolves as
   a global at render time. App selection state + handlers come in as props; the
   render guard (selected.size > 0 && view === "gallery" && !focusFile) stays in App. */

function BatchBar({ selected, files, folder, askSelection, batchAutoTag, setRenamePaths, batchAddToKB, batchTag, batchMakeSearchable, batchDelete, clearSel }) {
  return (
    <div className="batch-bar">
      <span className="semi">{selected.size} selected</span>
      <button className="btn sm" title="Chat with the AI about exactly these files" onClick={askSelection}><Icon name="sparkles" size={14} /> Ask AI</button>
      <button className="btn sm" title="Generate tags from each file's content (vision for photos)" onClick={batchAutoTag}><Icon name="tag" size={14} /> Auto-tag</button>
      <button className="btn sm" title="Propose descriptive filenames from content, review, then rename" onClick={() => setRenamePaths(files.filter(f => selected.has(f.id)).map(f => f.path))}><Icon name="edit" size={14} /> Rename</button>
      {!folder?.kb && <button className="btn sm" onClick={batchAddToKB}><Icon name="layers" size={14} /> Add to KB</button>}
      <button className="btn sm" onClick={batchTag}><Icon name="tag" size={14} /> Tag</button>
      {files.some(f => selected.has(f.id) && f.kind === "photo") && <button className="btn sm" onClick={batchMakeSearchable}><Icon name="sparkles" size={14} /> Make searchable</button>}
      {folder?.kb && <button className="btn sm" onClick={batchDelete} style={{ color: "var(--warn)" }}><Icon name="x" size={14} /> Delete</button>}
      <button className="btn sm ghost" onClick={clearSel}>Clear</button>
    </div>
  );
}

export { BatchBar };
