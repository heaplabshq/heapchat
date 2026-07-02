import { thumbUrl, photoStyle, palFor, fileUrl, Icon, waveHeights, docMeta, KIND_META } from "./icons.jsx";
// gallery.jsx — real thumbnails, file card, masonry gallery

function Thumb({ file, small }) {
  const { kind, ext, path } = file;

  if (kind === "photo") {
    return (
      <div className="thumb" style={{ background: "var(--surface-2)" }}>
        <img src={thumbUrl(path, 480)} alt={file.name} loading="lazy"
          style={{ width: "100%", display: "block" }}
          onError={(e) => { e.currentTarget.style.display = "none"; }} />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <div className="thumb grain thumb-vignette" style={{ aspectRatio: 1.0, ...photoStyle(palFor(file.name)), position: "relative" }}>
        <video src={fileUrl(path) + "#t=0.5"} preload="metadata" muted playsInline
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        {!small && <div className="play-btn"><Icon name="play" size={20} /></div>}
      </div>
    );
  }

  if (kind === "audio") {
    const bars = waveHeights(file.name, small ? 16 : 38);
    return (
      <div className="thumb thumb-audio" style={{ aspectRatio: 1.6, ...photoStyle(palFor(file.name)) }}>
        {bars.map((h, i) => <div key={i} className="wave-bar" style={{ height: h + "%" }} />)}
      </div>
    );
  }

  // doc
  const d = docMeta(ext);
  return (
    <div className="thumb thumb-doc" style={{ aspectRatio: 0.78 }}>
      <div className="doc-page" style={{ height: "100%" }}>
        <div className="doc-accent" style={{ background: d.c }} />
        <div className="doc-line" style={{ width: "85%", height: 8 }} />
        <div className="doc-line" style={{ width: "60%", height: 8, marginBottom: 16 }} />
        {!small && <>
          <div className="doc-line" style={{ width: "100%" }} />
          <div className="doc-line" style={{ width: "96%" }} />
          <div className="doc-line" style={{ width: "100%" }} />
          <div className="doc-line" style={{ width: "70%" }} />
        </>}
      </div>
    </div>
  );
}

function FileCard({ file, index, selected, onOpen, onDelete, checked, onToggleCheck }) {
  const km = KIND_META[file.kind];
  const isDoc = file.kind === "doc";
  const ico = isDoc ? docMeta(file.ext) : km;
  return (
    <div className={"fcard" + (selected ? " sel" : "") + (checked ? " checked" : "")} onClick={() => onOpen(file)}
      style={{ animationDelay: Math.min(index * 28, 400) + "ms" }}>
      <Thumb file={file} />
      <div className="kind-badge"><Icon name={km.icon} size={11} sw={2} /> {(file.ext || file.kind).toUpperCase()}</div>
      {onToggleCheck && (
        <button className={"fcard-check" + (checked ? " on" : "")} title="Select"
          onClick={e => { e.stopPropagation(); onToggleCheck(file); }}>{checked ? <Icon name="check" size={13} /> : null}</button>
      )}
      {onDelete && (
        <button className="fcard-del" title="Remove from knowledge base"
          onClick={e => { e.stopPropagation(); onDelete(file); }}><Icon name="x" size={14} /></button>
      )}
      <a className="fcard-dl" title="Download" href={fileUrl(file.path)} download={file.name}
        onClick={e => e.stopPropagation()}><Icon name="download" size={13} /></a>
      <div className="fcard-overlay"><span className="ask-pill"><Icon name="sparkles" size={13} /> Ask AI</span></div>
      <div className="fcard-foot">
        <div className="fcard-ico" style={{ background: ico.soft, color: ico.c }}><Icon name={km.icon} size={15} sw={1.9} /></div>
        <div className="col grow" style={{ gap: 1 }}>
          <span className="t-sm semi truncate" style={{ lineHeight: 1.3 }}>{file.name}</span>
          <span className="t-xs ink-3 mono">{file.meta.size}</span>
        </div>
      </div>
    </div>
  );
}

function FolderCard({ dir, onOpen }) {
  return (
    <button className="folder-card" onClick={() => onOpen(dir)} title={dir.path}>
      <span className="folder-card-ico"><Icon name="folder" size={20} sw={1.8} /></span>
      <span className="truncate grow" style={{ textAlign: "left" }}>{dir.name}</span>
      <Icon name="chevR" size={16} style={{ color: "var(--ink-4)", flex: "none" }} />
    </button>
  );
}

function Gallery({ dirs = [], files, colW, selectedId, onOpen, onOpenFolder, onDelete, checkedSet, onToggleCheck }) {
  if (!dirs.length && !files.length) {
    return (
      <div className="col center grow" style={{ gap: 12, padding: 60, color: "var(--ink-3)" }}>
        <Icon name="search" size={30} sw={1.5} />
        <span className="t-md semi" style={{ color: "var(--ink-2)" }}>Nothing matches your filters</span>
      </div>
    );
  }
  return (
    <>
      {dirs.length > 0 && (
        <div className="folder-grid">
          {dirs.map(d => <FolderCard key={d.path} dir={d} onOpen={onOpenFolder} />)}
        </div>
      )}
      {files.length > 0 && (
        <div className="masonry" style={{ columnWidth: colW + "px" }}>
          {files.map((f, i) => (
            <FileCard key={f.id} file={f} index={i} selected={selectedId === f.id} onOpen={onOpen} onDelete={onDelete}
              checked={checkedSet && checkedSet.has(f.id)} onToggleCheck={onToggleCheck} />
          ))}
        </div>
      )}
    </>
  );
}

export { Thumb, Gallery };
