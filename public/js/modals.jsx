import { App } from "./app.jsx";
import { Icon, thumbUrl } from "./icons.jsx";
/* App-level modals: extract-to-table, duplicate-photo finder, and AI smart-rename.
   Extracted from app.jsx. Global-scope module (indirect-eval): the three modal
   components (+ the prettyBytes helper they use) leak to global for app.jsx; Icon
   (icons.jsx) and thumbUrl (icons.jsx) resolve as globals at render time. */
const { useState, useEffect } = React;

function ExtractModal({ target, onClose }) {
  const [fields, setFields] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  async function run() {
    setBusy(true); setErr(null);
    try {
      const body = target.paths ? { paths: target.paths, fields } : { path: target.path, fields };
      const r = await fetch("/api/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Extraction failed");
      if (!j.total) throw new Error("No documents found to extract from.");
      setResult(j);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  useEffect(() => { if (target.auto) run(); }, []);   // auto-extract on upload runs immediately
  function csv() {
    const esc = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [result.columns.map(esc).join(","), ...result.rows.map(r => r.map(esc).join(","))];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = (target.name || "extract").replace(/[^\w.\- ]+/g, "_") + ".csv"; a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={"ex-modal" + (result ? " wide" : "")} onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span className="x-bold tighter" style={{ fontSize: 18 }}><Icon name="grid" size={17} style={{ color: "var(--accent)" }} /> Extract to table</span>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        {!result ? (
          <>
            <div className="ink-3 t-sm" style={{ marginBottom: 16 }}>Reads <b>{target.name}</b> — including <b>scans &amp; photos via vision OCR</b> — and pulls fields into a spreadsheet.</div>
            <label className="field-label">Fields to extract</label>
            <input className="ex-input" autoFocus placeholder="vendor, date, amount — or leave blank to auto-detect" value={fields} onChange={e => setFields(e.target.value)} onKeyDown={e => { if (e.key === "Enter") run(); }} disabled={busy} />
            {err && <div className="callout warn" style={{ marginTop: 12, textAlign: "left" }}><Icon name="alert" size={15} /><span>{err}</span></div>}
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={run} disabled={busy}>{busy ? <><span className="spin-mini" /> Extracting…</> : <><Icon name="grid" size={15} /> Extract</>}</button>
            </div>
            {busy && <div className="t-xs ink-3" style={{ marginTop: 12 }}>Reading documents one by one — photos take longer (vision OCR). Hang tight…</div>}
          </>
        ) : (
          <>
            <div className="row between" style={{ margin: "8px 0 10px" }}>
              <span className="t-sm ink-3">{result.total} row{result.total === 1 ? "" : "s"} · {result.columns.length} columns</span>
              <div className="row gap-2">
                <button className="btn sm" onClick={() => setResult(null)}><Icon name="arrowL" size={14} /> New</button>
                <button className="btn sm primary" onClick={csv}><Icon name="download" size={14} /> Download CSV</button>
              </div>
            </div>
            <div className="ex-table-wrap">
              <table className="rb-table">
                <thead><tr>{result.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
                <tbody>{result.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{c == null ? "" : String(c)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function prettyBytes(n) {
  if (!n && n !== 0) return "";
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
  if (n < 1073741824) return (n / 1048576).toFixed(1) + " MB";
  return (n / 1073741824).toFixed(2) + " GB";
}

// scan a folder for visually-identical / near-duplicate photos and pick which copies to delete
function DuplicatesModal({ folder, onClose, onDeleted }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [checked, setChecked] = useState(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { (async () => {
    try {
      const r = await fetch("/api/duplicates?path=" + encodeURIComponent(folder.path));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Scan failed");
      setData(j);
      // preselect the smaller copies in every EXACT group — keep the largest (usually the original)
      const pre = new Set();
      j.groups.forEach(g => { if (g.kind === "exact") g.files.slice(1).forEach(f => pre.add(f.path)); });
      setChecked(pre);
    } catch (e) { setErr(e.message); }
  })(); }, []);
  function toggle(p) { setChecked(s => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n; }); }
  async function del() {
    if (!checked.size || !window.confirm(`Delete ${checked.size} file${checked.size === 1 ? "" : "s"}? This removes them from disk.`)) return;
    setBusy(true);
    try {
      const r = await fetch("/api/duplicates/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: [...checked] }) });
      const j = await r.json();
      onDeleted(j.deleted || 0);
    } catch { setBusy(false); }
  }
  const groups = data ? data.groups : [];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="ex-modal wide" onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span className="x-bold tighter" style={{ fontSize: 18 }}><Icon name="copy" size={17} style={{ color: "var(--accent)" }} /> Duplicate photos</span>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        {err ? (
          <div className="callout warn" style={{ textAlign: "left" }}><Icon name="alert" size={15} /><span>{err}</span></div>
        ) : !data ? (
          <div className="col center" style={{ padding: 48, gap: 12, color: "var(--ink-3)" }}>
            <span className="dots"><span /><span /><span /></span>
            <span className="t-sm">Comparing {""}photos pixel-by-pixel (perceptual hash)…</span>
          </div>
        ) : !groups.length ? (
          <div className="col center" style={{ padding: 48, gap: 8, color: "var(--ink-3)" }}>
            <Icon name="check" size={26} style={{ color: "var(--good)" }} />
            <span className="t-sm">No duplicates — {data.scanned} photo{data.scanned === 1 ? "" : "s"} compared, all distinct.</span>
          </div>
        ) : (
          <>
            <div className="t-sm ink-3" style={{ marginBottom: 12 }}>
              {groups.length} group{groups.length === 1 ? "" : "s"} found across {data.scanned} photos.
              Exact copies are preselected (the largest file is kept); review “similar” groups yourself — they're bursts, crops, or edits.
            </div>
            <div className="col" style={{ gap: 16, overflow: "auto", flex: 1, minHeight: 0 }}>
              {groups.map((g, gi) => (
                <div key={gi} className="dup-group">
                  <div className="row gap-2" style={{ marginBottom: 8 }}>
                    <span className={"dup-badge" + (g.kind === "exact" ? " exact" : "")}>{g.kind === "exact" ? "Exact copies" : "Similar"}</span>
                    <span className="t-xs ink-3">{g.files.length} files · {prettyBytes(g.wasted)} reclaimable</span>
                  </div>
                  <div className="dup-row">
                    {g.files.map(f => (
                      <button key={f.path} className={"dup-card" + (checked.has(f.path) ? " del" : "")} title={f.path} onClick={() => toggle(f.path)}>
                        <img src={thumbUrl(f.path, 320)} alt={f.name} loading="lazy" />
                        <span className="dup-meta"><span className="truncate">{f.name}</span><span className="t-xs ink-3">{prettyBytes(f.bytes)}</span></span>
                        <span className={"dup-check" + (checked.has(f.path) ? " on" : "")}><Icon name="x" size={12} /></span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={onClose} disabled={busy}>Close</button>
              <button className="btn primary" disabled={!checked.size || busy} onClick={del} style={checked.size ? { background: "var(--warn)", borderColor: "var(--warn)" } : undefined}>
                {busy ? <><span className="spin-mini" /> Deleting…</> : <><Icon name="x" size={14} /> Delete {checked.size || ""} selected</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// AI smart-rename: propose content-based filenames for the selected files, edit, then apply
function RenameModal({ paths, onClose, onDone }) {
  const [rows, setRows] = useState(null);   // [{ path, current, proposed, on }]
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { (async () => {
    try {
      const r = await fetch("/api/batch/rename/suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Could not suggest names");
      setRows(j.proposals.map(p => ({ ...p, on: p.proposed !== p.current })));
    } catch (e) { setErr(e.message); }
  })(); }, []);
  async function apply() {
    const renames = rows.filter(r => r.on && r.proposed.trim() && r.proposed.trim() !== r.current).map(r => ({ path: r.path, name: r.proposed.trim() }));
    if (!renames.length) { onClose(); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/batch/rename/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ renames }) });
      const j = await r.json();
      onDone((j.renamed || []).length);
    } catch { setBusy(false); }
  }
  const eligible = rows ? rows.filter(r => r.on && r.proposed.trim() !== r.current).length : 0;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="ex-modal wide" onClick={e => e.stopPropagation()}>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span className="x-bold tighter" style={{ fontSize: 18 }}><Icon name="edit" size={17} style={{ color: "var(--accent)" }} /> Smart rename</span>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>
        {err ? (
          <div className="callout warn" style={{ textAlign: "left" }}><Icon name="alert" size={15} /><span>{err}</span></div>
        ) : !rows ? (
          <div className="col center" style={{ padding: 48, gap: 12, color: "var(--ink-3)" }}>
            <span className="dots"><span /><span /><span /></span>
            <span className="t-sm">Reading {paths.length} file{paths.length === 1 ? "" : "s"} and proposing names (vision for photos)…</span>
          </div>
        ) : (
          <>
            <div className="t-sm ink-3" style={{ marginBottom: 12 }}>Names are proposed from each file's <b>content</b>. Edit any name, untick to skip, then apply.</div>
            <div className="col" style={{ gap: 6, overflow: "auto", flex: 1, minHeight: 0 }}>
              {rows.map((r, i) => (
                <div key={r.path} className="rename-row">
                  <button className={"fcard-check on" + (r.on ? "" : " off")} style={{ position: "static", opacity: 1, background: r.on ? "var(--accent)" : "var(--surface-3)", borderColor: r.on ? "var(--accent)" : "var(--line)", color: r.on ? "#fff" : "var(--ink-4)" }}
                    onClick={() => setRows(rs => rs.map((x, xi) => xi === i ? { ...x, on: !x.on } : x))}><Icon name="check" size={12} /></button>
                  <span className="t-sm truncate" style={{ flex: "0 1 200px", color: "var(--ink-3)" }} title={r.current}>{r.current}</span>
                  <Icon name="chevR" size={13} style={{ flex: "none", color: "var(--ink-4)" }} />
                  <input className="ex-input" style={{ flex: 1, padding: "6px 10px", fontSize: 13 }} value={r.proposed} disabled={!r.on}
                    onChange={e => setRows(rs => rs.map((x, xi) => xi === i ? { ...x, proposed: e.target.value } : x))} />
                </div>
              ))}
            </div>
            <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={apply} disabled={busy || !eligible}>
                {busy ? <><span className="spin-mini" /> Renaming…</> : <><Icon name="edit" size={14} /> Rename {eligible || ""}</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export { ExtractModal, DuplicatesModal, RenameModal, prettyBytes };
