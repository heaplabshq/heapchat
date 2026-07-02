import { fileUrl, Icon, waveHeights, photoStyle, palFor, docMeta, kindFromName, thumbUrl } from "./icons.jsx";
import { fmt } from "./markdown.jsx";
import { Lightbox, PhotoFacesPanel } from "./people.jsx";
import { Thumb } from "./gallery.jsx";
import { ImageEditModal } from "./image-edit.jsx";
// focus.jsx — single-file focus preview (real media)

// extensions we can show as text / code
const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "log", "json", "xml", "yml", "yaml",
  "html", "htm", "css", "scss", "less", "js", "jsx", "mjs", "cjs", "ts", "tsx",
  "py", "go", "rs", "java", "rb", "php", "sh", "bash", "zsh", "c", "cpp", "cc",
  "h", "hpp", "sql", "ini", "toml", "env", "conf", "svg", "rtf", "gitignore",
]);
const MD_EXT = new Set(["md", "markdown"]);

// extensions the server will actually accept a save for (src/util/files.js TEXTLIKE) — a strict
// subset of TEXT_EXT above, which also covers a few formats (scss/less/etc.) that render fine but
// historically weren't in the write-allowlist. Keep this mirrored with server.js's TEXTLIKE.
const EDITABLE_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yml", "yaml", "html", "htm",
  "css", "scss", "less", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "go", "rs", "java",
  "rb", "php", "sh", "bash", "zsh", "c", "cpp", "cc", "h", "hpp", "sql", "ini", "toml",
  "env", "conf", "log", "rtf", "svg", "gitignore",
]);

// fetch-and-show real text/code contents, with an in-place editor (Edit → textarea → Save)
function TextPreview({ file }) {
  const [state, setState] = React.useState({ loading: true, text: "", error: null, truncated: false });
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saveErr, setSaveErr] = React.useState(null);

  React.useEffect(() => {
    let alive = true;
    setState({ loading: true, text: "", error: null, truncated: false });
    setEditing(false); setSaveErr(null);
    fetch(fileUrl(file.path))
      .then(r => { if (!r.ok) throw new Error("Could not read file"); return r.text(); })
      .then(t => {
        if (!alive) return;
        const LIMIT = 300000;
        const truncated = t.length > LIMIT;
        setState({ loading: false, text: truncated ? t.slice(0, LIMIT) : t, error: null, truncated });
      })
      .catch(e => { if (alive) setState({ loading: false, text: "", error: e.message, truncated: false }); });
    return () => { alive = false; };
  }, [file.id]);

  const isMd = MD_EXT.has(file.ext);
  const canEdit = EDITABLE_EXT.has(file.ext) && !state.truncated;

  function startEdit() { setDraft(state.text); setSaveErr(null); setEditing(true); }
  async function save() {
    setSaving(true); setSaveErr(null);
    const r = await fetch("/api/file", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file.path, content: draft }) })
      .then(r => r.json()).catch(() => null);
    setSaving(false);
    if (r && r.ok) { setState(s => ({ ...s, text: draft })); setEditing(false); }
    else setSaveErr((r && r.error) || "Could not save — try again.");
  }

  return (
    <div className="preview preview-doc scroll">
      <div className="doc-sheet" style={{ maxWidth: isMd ? 720 : 860 }}>
        {!state.loading && !state.error && (
          <div className="row gap-2" style={{ marginBottom: 12, justifyContent: "flex-end" }}>
            {editing ? (
              <>
                {saveErr && <span className="t-xs" style={{ color: "var(--warn)", marginRight: "auto" }}>{saveErr}</span>}
                <button className="btn sm" onClick={() => { setEditing(false); setSaveErr(null); }} disabled={saving}>Cancel</button>
                <button className="btn sm primary" onClick={save} disabled={saving || draft === state.text}>{saving ? <><span className="spin-mini" /> Saving…</> : "Save"}</button>
              </>
            ) : canEdit ? (
              <button className="btn sm" onClick={startEdit}><Icon name="edit" size={13} /> Edit</button>
            ) : state.truncated ? (
              <span className="t-xs ink-3" title="Files over 300 KB can't be edited here yet">Too large to edit here</span>
            ) : null}
          </div>
        )}
        {state.loading ? (
          <div className="col center" style={{ padding: 40, color: "var(--ink-3)" }}>
            <span className="dots"><span /><span /><span /></span>
          </div>
        ) : state.error ? (
          <div className="callout warn"><Icon name="alert" size={16} /><span>{state.error}</span></div>
        ) : editing ? (
          <textarea className="textarea mono" autoFocus value={draft} onChange={e => setDraft(e.target.value)}
            style={{ width: "100%", minHeight: 420, fontSize: 12.5, lineHeight: 1.6, resize: "vertical" }} />
        ) : isMd ? (
          fmt(state.text)
        ) : (
          <pre className="codeblock"><code>{state.text}</code></pre>
        )}
        {state.truncated && !editing && (
          <div className="row gap-2" style={{ marginTop: 14, color: "var(--ink-3)" }}>
            <Icon name="info" size={14} /> <span className="t-xs">Showing the first 300 KB — open or download for the full file.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function MetaChip({ icon, children }) {
  return <span className="tag" style={{ background: "transparent", border: "1px solid var(--line)", padding: "5px 9px", color: "var(--ink-2)" }}>
    <Icon name={icon} size={13} sw={1.8} style={{ color: "var(--ink-3)" }} /> <span className="mono" style={{ fontWeight: 600, letterSpacing: 0 }}>{children}</span>
  </span>;
}

// fullscreen image viewer with zoom + arrow-key navigation.
// NOTE: named ZoomLightbox (not "Lightbox") on purpose — these .jsx files share one global scope,
// and people.jsx also defines a `Lightbox` (the faces popup). A shared name lets whichever script
// loads last win, so clicking "magnify" here would wrongly open the faces popup. Keep this unique.
function ZoomLightbox({ photos, index, onIndex, onClose }) {
  const [zoom, setZoom] = React.useState(false);
  React.useEffect(() => {
    const h = e => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") { setZoom(false); onIndex((index + 1) % photos.length); }
      else if (e.key === "ArrowLeft") { setZoom(false); onIndex((index - 1 + photos.length) % photos.length); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [index, photos.length]);
  const f = photos[index];
  if (!f) return null;
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lb-close" title="Close (Esc)" onClick={onClose}><Icon name="x" size={20} /></button>
      {photos.length > 1 && <button className="lb-nav lb-prev" title="Previous (←)" onClick={e => { e.stopPropagation(); setZoom(false); onIndex((index - 1 + photos.length) % photos.length); }}><Icon name="chevL" size={26} /></button>}
      <img className={"lb-img" + (zoom ? " zoom" : "")} src={fileUrl(f.path)} alt={f.name}
        onClick={e => { e.stopPropagation(); setZoom(z => !z); }} title={zoom ? "Click to fit" : "Click to zoom"} />
      {photos.length > 1 && <button className="lb-nav lb-next" title="Next (→)" onClick={e => { e.stopPropagation(); setZoom(false); onIndex((index + 1) % photos.length); }}><Icon name="chevR" size={26} /></button>}
      <div className="lb-caption">{f.name} · {index + 1} / {photos.length}</div>
    </div>
  );
}

function Preview({ file, onZoom }) {
  const { kind, ext, path } = file;

  if (kind === "photo")
    return <div className="preview" style={{ background: "#0d1117" }}>
      <img src={fileUrl(path)} alt={file.name} onClick={onZoom} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", cursor: "zoom-in" }} />
    </div>;

  if (kind === "video")
    return <div className="preview" style={{ background: "#000" }}>
      <video src={fileUrl(path)} controls preload="metadata"
        style={{ maxWidth: "100%", maxHeight: "100%" }} />
    </div>;

  if (kind === "audio") {
    const bars = waveHeights(file.name, 80);
    return <div className="preview" style={photoStyle(palFor(file.name))}>
      <div className="col center" style={{ gap: 22, width: "82%" }}>
        <div className="row" style={{ gap: 3, height: 130, alignItems: "center", width: "100%", justifyContent: "center" }}>
          {bars.map((h, i) => <div key={i} style={{ width: 4, height: h + "%", borderRadius: 4, background: "rgba(255,255,255,.85)" }} />)}
        </div>
        <audio src={fileUrl(path)} controls style={{ width: "100%", maxWidth: 420 }} />
        <span className="bold" style={{ fontSize: 15, color: "#fff" }}>{file.name}</span>
      </div>
    </div>;
  }

  // pdf → embedded viewer (object with iframe fallback)
  if (ext === "pdf")
    return <div className="preview" style={{ background: "var(--surface-2)" }}>
      <object data={fileUrl(path)} type="application/pdf" style={{ width: "100%", height: "100%" }}>
        <iframe src={fileUrl(path)} title={file.name} style={{ width: "100%", height: "100%", border: "none" }}>
          <div className="col center" style={{ height: "100%", gap: 10, color: "var(--ink-3)" }}>
            <Icon name="file" size={26} sw={1.5} />
            <a className="btn primary" href={fileUrl(path)} target="_blank" rel="noreferrer"><Icon name="download" size={15} /> Open PDF</a>
          </div>
        </iframe>
      </object>
    </div>;

  // text / code / markdown → real contents
  if (TEXT_EXT.has(ext)) return <TextPreview file={file} />;

  // anything else (binary office docs, archives, …): no inline preview, offer to open
  const d = docMeta(ext);
  return <div className="preview preview-doc scroll">
    <div className="doc-sheet">
      <div style={{ height: 5, width: 64, borderRadius: 5, background: d.c, marginBottom: 22 }} />
      <div style={{ height: 16, width: "70%", borderRadius: 5, background: "#e9ebf0", marginBottom: 10 }} />
      <div style={{ height: 16, width: "48%", borderRadius: 5, background: "#e9ebf0", marginBottom: 26 }} />
      {[100,96,100,88,100,72,0,100,93,100,80].map((w, i) => w === 0
        ? <div key={i} style={{ height: 14 }} />
        : <div key={i} style={{ height: 9, width: w + "%", borderRadius: 4, background: "#eef0f4", marginBottom: 11 }} />)}
      <div className="col center" style={{ marginTop: 24, color: "var(--ink-3)", gap: 12 }}>
        <span className="t-sm row gap-2"><Icon name="file" size={15} /> No inline preview for <span className="mono">.{ext}</span> files.</span>
        <a className="btn" href={fileUrl(path)} target="_blank" rel="noreferrer" download={file.name}><Icon name="download" size={15} /> Open / download</a>
      </div>
    </div>
  </div>;
}

// lets the user add context + run the vision model so an image becomes searchable by the agent
function ImageSearchPanel({ file }) {
  const [state, setState] = React.useState({ loading: true, described: false, context: "", description: "" });
  const [instructions, setInstructions] = React.useState("");
  const [working, setWorking] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setState(s => ({ ...s, loading: true })); setWorking(false); setOpen(false);
    fetch("/api/image/meta?path=" + encodeURIComponent(file.path))
      .then(r => r.json())
      .then(j => { if (alive) setState({ loading: false, described: !!j.described, context: j.context || "", description: j.description || "" }); })
      .catch(() => { if (alive) setState({ loading: false, described: false, context: "", description: "" }); });
    return () => { alive = false; };
  }, [file.id]);

  async function analyze() {
    setWorking(true);
    try {
      const r = await fetch("/api/image/describe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: file.path, context: state.context, instructions }),
      });
      const j = await r.json();
      if (r.ok) setState(s => ({ ...s, described: true, description: j.description || "", context: j.context || s.context }));
    } catch {}
    setWorking(false);
  }

  if (state.loading) return null;
  return (
    <div className="img-search">
      <div className="img-search-head">
        <Icon name="sparkles" size={14} style={{ color: "var(--accent)" }} />
        <span className="semi" style={{ fontSize: 13 }}>AI search</span>
        {state.described
          ? <span className="img-badge ok"><Icon name="check" size={11} /> Searchable</span>
          : <span className="img-badge">Not indexed</span>}
      </div>
      <div className="t-sm ink-3" style={{ margin: "2px 0 8px" }}>
        Add optional context, then let the vision model describe this image so the agent can find and use it.
      </div>
      <textarea className="textarea" rows={2} placeholder="Context (optional) — saved with image, e.g. who/what/where, project, names…"
        value={state.context} onChange={e => setState(s => ({ ...s, context: e.target.value }))} style={{ fontSize: 13 }} />
      <textarea className="textarea" rows={2}
        placeholder="Instructions for the AI (optional, not stored) — e.g. focus on the text, ignore watermark, describe the chart data…"
        value={instructions} onChange={e => setInstructions(e.target.value)}
        style={{ fontSize: 13, marginTop: 6, borderStyle: "dashed" }} />
      <div className="row gap-2" style={{ marginTop: 8 }}>
        <button className="btn primary sm" onClick={analyze} disabled={working}>
          <Icon name={working ? "clock" : "sparkles"} size={14} /> {working ? "Analyzing…" : state.described ? "Re-analyze" : "Make searchable"}
        </button>
        {state.description && (
          <button className="btn sm ghost" onClick={() => setOpen(o => !o)}>
            <Icon name="chevD" size={14} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} /> Description
          </button>
        )}
      </div>
      {open && state.description && <div className="img-desc">{state.description}</div>}
    </div>
  );
}

function FocusView({ file, files, onClose, onSelect, starred, onToggleStar, onOpenPath, onExtract, settings = {} }) {
  const m = file.meta;
  const metaBits = [["download", m.size], ["calendar", m.date], ["file", "." + file.ext]];
  const photos = files.filter(f => f.kind === "photo");
  const [lb, setLb] = React.useState(null);   // lightbox index into photos, or null
  const [exif, setExif] = React.useState(null);
  const [related, setRelated] = React.useState([]);
  const [editing, setEditing] = React.useState(false);   // Edit-with-AI modal open
  const editResultRef = React.useRef(null);               // the produced image, opened in focus when the modal closes
  function openLightbox() { const i = photos.findIndex(p => p.id === file.id); if (i >= 0) setLb(i); }
  function openRelated(r) { const f = files.find(x => x.path === r.path); if (f) onSelect(f); else if (onOpenPath) onOpenPath(r.path); }

  React.useEffect(() => {
    let alive = true;
    setExif(null); setRelated([]);
    fetch("/api/related?path=" + encodeURIComponent(file.path)).then(r => r.json()).then(j => { if (alive) setRelated(j.related || []); }).catch(() => {});
    if (file.kind === "photo") fetch("/api/exif?path=" + encodeURIComponent(file.path)).then(r => r.json()).then(j => { if (alive) setExif(j); }).catch(() => {});
    return () => { alive = false; };
  }, [file.id]);

  return (
    <div className="focus">
      <div className="focus-bar">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <button className="btn sm" onClick={onClose}><Icon name="arrowL" size={15} /> All files</button>
          <div className="row gap-2" style={{ minWidth: 0 }}>
            <span className="semi truncate" style={{ fontSize: 15, letterSpacing: "-0.01em" }}>{file.name}</span>
          </div>
        </div>
        <div className="row gap-2 none">
          {onExtract && (file.kind === "doc" || file.kind === "photo") && (
            <button className="btn sm" onClick={onExtract} title="Extract fields from this document into a table (vision OCR for images/scans)"><Icon name="grid" size={15} /> Extract</button>
          )}
          {file.kind === "photo" && settings.imageGen && (
            <button className="btn sm" onClick={() => setEditing(true)} title="Edit this photo with AI (Draw Things)"><Icon name="sparkles" size={15} /> Edit with AI</button>
          )}
          <button className={"btn icon sm"} onClick={onToggleStar} style={{ color: starred ? "var(--accent)" : "var(--ink-3)" }} title="Star">
            <Icon name="star" size={16} style={{ fill: starred ? "var(--accent)" : "none" }} />
          </button>
          <a className="btn icon sm" href={fileUrl(file.path)} download={file.name} title="Download" style={{ color: "var(--ink-3)" }}>
            <Icon name="download" size={16} />
          </a>
        </div>
      </div>
      {lb !== null && <ZoomLightbox photos={photos} index={lb} onIndex={setLb} onClose={() => setLb(null)} />}
      {editing && <ImageEditModal src={fileUrl(file.path)} path={file.path} settings={settings}
        onDone={(item) => { editResultRef.current = item; }}
        onClose={() => { setEditing(false); const it = editResultRef.current; editResultRef.current = null; if (it && it.path && onOpenPath) onOpenPath(it.path); }} />}
      <div className="focus-body">
        <Preview file={file} onZoom={openLightbox} />
        <div className="row gap-2 wrap" style={{ marginTop: 14 }}>
          {metaBits.map(([ic, v], i) => <MetaChip key={i} icon={ic}>{v}</MetaChip>)}
          {exif && exif.taken && <MetaChip icon="clock">{exif.taken}</MetaChip>}
          {exif && exif.camera && <MetaChip icon="image">{exif.camera}</MetaChip>}
          {exif && exif.settings && <MetaChip icon="settings">{exif.settings}</MetaChip>}
          {exif && exif.dims && <MetaChip icon="ruler">{exif.dims}</MetaChip>}
          {exif && exif.gps && <a className="tag" href={`https://www.openstreetmap.org/?mlat=${exif.gps.lat}&mlon=${exif.gps.lng}#map=15/${exif.gps.lat}/${exif.gps.lng}`} target="_blank" rel="noreferrer" style={{ textDecoration: "none", border: "1px solid var(--line)", padding: "5px 9px", color: "var(--accent)" }}><Icon name="folderOpen" size={13} sw={1.8} /> View on map</a>}
        </div>
        {related.length > 0 && (
          <div className="related-row">
            <span className="src-label">Related</span>
            {related.map((r, i) => kindFromName(r.name) === "photo"
              ? <button key={i} className="src-thumb" title={r.name} onClick={() => openRelated(r)}><img src={thumbUrl(r.path, 240)} alt={r.name} loading="lazy" /></button>
              : <button key={i} className="src-chip" title={r.name} onClick={() => openRelated(r)}><Icon name="file" size={11} sw={1.8} /> {r.name}</button>)}
          </div>
        )}
        {file.kind === "photo" && <ImageSearchPanel file={file} />}
        {file.kind === "photo" && file.path && (
          <div className="img-search" style={{ marginTop: 12 }}>
            <div className="img-search-head">
              <Icon name="brain" size={14} style={{ color: "var(--accent)" }} />
              <span className="semi" style={{ fontSize: 13 }}>People in this photo</span>
            </div>
            <div className="t-sm ink-3" style={{ margin: "2px 0 4px" }}>
              Faces detected on this photo. Name someone to tag them everywhere, or scan if it hasn't been checked yet.
            </div>
            <PhotoFacesPanel path={file.path} idSuffix="-focus" key={file.id} />
          </div>
        )}
        <div className="filmstrip scroll">
          {files.map(f => (
            <div key={f.id} className={"film" + (f.id === file.id ? " on" : "")} onClick={() => onSelect(f)} title={f.name}>
              <Thumb file={f} small />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { FocusView, Preview };
