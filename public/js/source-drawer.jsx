import { App } from "./app.jsx";
import { Icon, KIND_META } from "./icons.jsx";
import { Preview } from "./focus.jsx";
/* Source-preview drawer: the right-side panel that previews a chat citation's
   source file (with "Open full" → open it in the focus view). Extracted from the
   App god component in app.jsx. Global-scope module (indirect-eval): SourceDrawer
   leaks to global for app.jsx; Icon + KIND_META (icons.jsx) and Preview
   (focus.jsx) resolve as globals at render time. The render guard ({sourcePreview
   && …}) stays in App. */

function SourceDrawer({ sourcePreview, setSourcePreview, openFile }) {
  return (
    <div className="source-drawer">
      <div className="source-drawer-head">
        <Icon name={(KIND_META[sourcePreview.kind] || KIND_META.doc).icon} size={15} style={{ flex: "none", color: "var(--ink-3)" }} />
        <span className="truncate semi grow" title={sourcePreview.path}>{sourcePreview.name}</span>
        <button className="btn sm ghost" onClick={() => { const f = sourcePreview; setSourcePreview(null); openFile(f, false); }}>
          <Icon name="layers" size={14} /> Open full
        </button>
        <button className="btn icon sm ghost" title="Close" onClick={() => setSourcePreview(null)}><Icon name="x" size={16} /></button>
      </div>
      <div className="source-drawer-body"><Preview file={sourcePreview} /></div>
    </div>
  );
}

export { SourceDrawer };
