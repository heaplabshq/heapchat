import { Icon, KIND_META, docMeta } from "./icons.jsx";
// folderpicker.jsx — modal that browses the real filesystem
const { useState: useStateF, useEffect: useEffectF } = React;

function FolderPicker({ startPath, onPick, onPickFile, onClose }) {
  const [path, setPath] = useStateF(startPath || "");
  const [parent, setParent] = useStateF(null);
  const [dirs, setDirs] = useStateF([]);
  const [files, setFiles] = useStateF([]);
  const [loading, setLoading] = useStateF(true);
  const [error, setError] = useStateF(null);

  async function load(p) {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/browse" + (p ? "?path=" + encodeURIComponent(p) : ""));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Cannot open folder");
      setPath(j.path); setParent(j.parent); setDirs(j.dirs); setFiles(j.files || []);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }

  useEffectF(() => { load(startPath); }, []);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="row gap-2" style={{ minWidth: 0 }}>
            <Icon name="folderOpen" size={18} style={{ color: "var(--accent)" }} />
            <span className="bold" style={{ fontSize: 15 }}>Open folder or file</span>
          </div>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        <div className="modal-path">
          <button className="btn icon sm" title="Home" onClick={() => load("")}><Icon name="home" size={15} /></button>
          <button className="btn icon sm" title="Up" disabled={parent == null} onClick={() => parent != null && load(parent)}><Icon name="arrowL" size={15} /></button>
          <span className="mono t-sm truncate grow" style={{ color: "var(--ink-2)" }} title={path}>{path}</span>
          <button className="btn icon sm" title="Refresh" onClick={() => load(path)}><Icon name="refresh" size={15} /></button>
        </div>

        <div className="modal-body scroll">
          {loading ? (
            <div className="col center" style={{ padding: 40, color: "var(--ink-3)", gap: 10 }}>
              <span className="dots"><span /><span /><span /></span>
            </div>
          ) : error ? (
            <div className="callout warn" style={{ margin: 8 }}><Icon name="alert" size={16} /><span>{error}</span></div>
          ) : dirs.length === 0 && files.length === 0 ? (
            <div className="col center" style={{ padding: 40, color: "var(--ink-3)", gap: 8 }}>
              <Icon name="folder" size={26} sw={1.5} />
              <span className="t-sm">Empty folder — open it to use it.</span>
            </div>
          ) : (
            <>
              {dirs.map(d => (
                <button key={d.path} className="dir-row" onClick={() => load(d.path)}>
                  <Icon name="folder" size={17} style={{ color: "var(--accent)" }} />
                  <span className="truncate grow" style={{ textAlign: "left" }}>{d.name}</span>
                  <Icon name="chevR" size={15} style={{ color: "var(--ink-4)" }} />
                </button>
              ))}
              {files.map(f => {
                const km = KIND_META[f.kind];
                const ico = f.kind === "doc" ? docMeta(f.ext) : km;
                return (
                  <button key={f.path} className="dir-row" onClick={() => onPickFile(f)} title={"Open " + f.name}>
                    <Icon name={km.icon} size={16} style={{ color: ico.c }} />
                    <span className="truncate grow" style={{ textAlign: "left" }}>{f.name}</span>
                    <span className="t-xs ink-4 mono none">{f.meta.size}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="t-xs ink-3 truncate grow">{dirs.length} folder{dirs.length === 1 ? "" : "s"} · {files.length} file{files.length === 1 ? "" : "s"}</span>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!path} onClick={() => onPick(path)}>
            <Icon name="check" size={16} /> Open this folder
          </button>
        </div>
      </div>
    </div>
  );
}

export { FolderPicker };
