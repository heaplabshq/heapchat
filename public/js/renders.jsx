import { HBars, VBars, LineChart, PieChart, fmtNum } from "./charts.jsx";
import { Icon } from "./icons.jsx";
/* Rich tool-result renders for chat answers: the data → component blocks
   (images, links, table + CSV export, stat summary, chart) and the Instagram
   post preview. Extracted from chat.jsx. Global-scope module (indirect-eval):
   downloadCSV / InstagramCard / RenderBlock are visible to chat.jsx; the chart
   primitives (HBars/VBars/LineChart/PieChart/fmtNum) and Icon resolve as
   globals at render time (charts.jsx / icons.jsx load first). */
const { useState } = React;

// data → component (charts/tables) rendered from tool results
function downloadCSV(spec) {
  const esc = v => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const lines = [spec.columns.map(esc).join(","), ...spec.rows.map(r => r.map(esc).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = (spec.title ? spec.title.replace(/[^\w.\- ]+/g, "_") : "table") + ".csv"; a.click();
  URL.revokeObjectURL(url);
}

// Instagram post preview: one photo or a swipeable carousel, selectable caption options
// (copy-to-clipboard), hashtag chips, and per-photo alt text.
function InstagramCard({ spec }) {
  const caps = spec.captions || [];
  // new shape: spec.images[]; old saved cards: single spec.thumb/image/alt
  const imgs = (spec.images && spec.images.length) ? spec.images : [{ thumb: spec.thumb, image: spec.image, alt: spec.alt }];
  const multi = imgs.length > 1;
  const [pick, setPick] = useState(0);
  const [slide, setSlide] = useState(0);
  const [copied, setCopied] = useState(false);
  const cur = imgs[Math.min(slide, imgs.length - 1)] || {};
  const tags = (spec.hashtags || []).join(" ");
  const go = d => setSlide(s => (s + d + imgs.length) % imgs.length);
  const copy = () => {
    const text = (caps[pick] || "") + (tags ? "\n\n" + tags : "");
    try { navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  return (
    <div className="ig-card">
      <div className="ig-head"><Icon name="image" size={13} /> <span>{multi ? `Instagram carousel · ${imgs.length} photos` : "Instagram post"}</span></div>
      <div className="ig-photo-wrap">
        <a className="ig-photo" href={cur.image} target="_blank" rel="noopener noreferrer">
          <img src={cur.thumb || cur.image} alt={cur.alt || ""} loading="lazy" />
        </a>
        {multi && <>
          <button className="ig-nav prev" title="Previous" onClick={() => go(-1)}><Icon name="chevL" size={18} /></button>
          <button className="ig-nav next" title="Next" onClick={() => go(1)}><Icon name="chevR" size={18} /></button>
          <div className="ig-count">{slide + 1}/{imgs.length}</div>
          <div className="ig-dots">{imgs.map((_, i) => <button key={i} className={"ig-dot" + (i === slide ? " on" : "")} onClick={() => setSlide(i)} title={`Photo ${i + 1}`} />)}</div>
        </>}
      </div>
      {caps.length > 1 && (
        <div className="ig-tabs">
          {caps.map((_, i) => <button key={i} className={"ig-tab" + (i === pick ? " on" : "")} onClick={() => setPick(i)}>Caption {i + 1}</button>)}
        </div>
      )}
      <div className="ig-caption">{caps[pick]}</div>
      {tags && <div className="ig-tags">{(spec.hashtags || []).map((h, i) => <span key={i} className="ig-tag">{h}</span>)}</div>}
      {cur.alt && <div className="ig-alt"><b>Alt text{multi ? ` (photo ${slide + 1})` : ""}:</b> {cur.alt}</div>}
      <button className="ig-copy" onClick={copy}><Icon name={copied ? "check" : "download"} size={12} /> {copied ? "Copied" : "Copy caption + hashtags"}</button>
    </div>
  );
}

// fullscreen zoom viewer for chat images — generated/library images (local /api/file?path=…) and
// external ones (web-search results, read_url) alike; the <img> just loads whatever src it's given,
// no download/save step needed. Click-to-zoom + arrow-key nav across the group that was opened from.
// Named distinctly from focus.jsx's ZoomLightbox / people.jsx's Lightbox (all .jsx share one global
// scope — see the comment on ZoomLightbox in focus.jsx).
function ChatLightbox({ items, index, onIndex, onClose }) {
  const [zoom, setZoom] = useState(false);
  React.useEffect(() => {
    const h = e => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight" && items.length > 1) { setZoom(false); onIndex((index + 1) % items.length); }
      else if (e.key === "ArrowLeft" && items.length > 1) { setZoom(false); onIndex((index - 1 + items.length) % items.length); }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [index, items.length]);
  const it = items[index];
  if (!it) return null;
  const src = it.image || it.url;
  const original = it.url && it.url !== src ? it.url : null;   // web-search "source page" link, when different from the image itself
  return (
    <div className="lightbox" onClick={onClose}>
      <button className="lb-close" title="Close (Esc)" onClick={onClose}><Icon name="x" size={20} /></button>
      {items.length > 1 && <button className="lb-nav lb-prev" title="Previous (←)" onClick={e => { e.stopPropagation(); setZoom(false); onIndex((index - 1 + items.length) % items.length); }}><Icon name="chevL" size={26} /></button>}
      <img className={"lb-img" + (zoom ? " zoom" : "")} src={src} alt={it.title || ""}
        onClick={e => { e.stopPropagation(); setZoom(z => !z); }} title={zoom ? "Click to fit" : "Click to zoom"} />
      {items.length > 1 && <button className="lb-nav lb-next" title="Next (→)" onClick={e => { e.stopPropagation(); setZoom(false); onIndex((index + 1) % items.length); }}><Icon name="chevR" size={26} /></button>}
      {(it.title || it.source || original) && (
        <div className="lb-caption" onClick={e => e.stopPropagation()}>
          {[it.title, it.source].filter(Boolean).join(" · ")}
          {items.length > 1 ? ` · ${index + 1} / ${items.length}` : ""}
          {original && <a href={original} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 10, color: "var(--accent)" }}>Open source ↗</a>}
        </div>
      )}
    </div>
  );
}

function RenderBlock({ spec, onEditImage, onZoomImage }) {
  if (!spec) return null;
  if (spec.type === "images") {
    return (
      <div className="rb-imgs">
        {spec.title && <div className="rb-title">{spec.title}</div>}
        <div className="rb-img-grid">
          {(spec.items || []).map((it, i) => (
            <div key={i} className="rb-img-wrap" style={{ position: "relative" }}>
              <div className="rb-img" role="button" tabIndex={0} title={(it.title || "") + (it.source ? " · " + it.source : "")}
                onClick={() => onZoomImage ? onZoomImage(spec.items, i) : window.open(it.url || it.image, "_blank", "noopener")}
                onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onZoomImage ? onZoomImage(spec.items, i) : window.open(it.url || it.image, "_blank", "noopener"); } }}>
                <img src={it.thumb || it.image} alt={it.title || ""} loading="lazy" />
              </div>
              {onEditImage && (
                <button className="rb-img-edit" title="Edit with AI" onClick={e => { e.preventDefault(); e.stopPropagation(); onEditImage(it); }}>
                  <Icon name="sparkles" size={13} /> Edit
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (spec.type === "instagram") return <InstagramCard spec={spec} />;
  if (spec.type === "links") {
    return (
      <div className="rb-links">
        {spec.title && <div className="rb-title">{spec.title}</div>}
        {(spec.items || []).map((it, i) => (
          <a key={i} className="rb-link" href={it.url} target="_blank" rel="noopener noreferrer">
            <span className="rb-link-title truncate">{it.title || it.url}</span>
            <span className="rb-link-url truncate">{(it.url || "").replace(/^https?:\/\/(www\.)?/, "")}</span>
            {it.snippet && <span className="rb-link-snip">{it.snippet}</span>}
          </a>
        ))}
      </div>
    );
  }
  if (spec.type === "table") {
    return (
      <div>
        <div className="rb-table-bar">
          <span className="t-xs ink-3">{spec.total} row{spec.total === 1 ? "" : "s"} · {spec.columns.length} cols</span>
          <button className="rb-csv" title="Download as CSV" onClick={() => downloadCSV(spec)}><Icon name="download" size={12} /> CSV</button>
        </div>
        <div className="rb-table-wrap">
          <table className="rb-table">
            <thead><tr>{spec.columns.map((c, i) => <th key={i}>{c}</th>)}</tr></thead>
            <tbody>{spec.rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => <td key={ci}>{c == null ? "" : String(c)}</td>)}</tr>)}</tbody>
          </table>
          {spec.total > spec.rows.length && <div className="t-xs ink-3" style={{ padding: "6px 2px 0" }}>+{spec.total - spec.rows.length} more rows</div>}
        </div>
      </div>
    );
  }
  if (spec.type === "stat") {
    return (
      <div className="rb-statwrap">
        {spec.title && <div className="rb-title">{spec.title} — summary</div>}
        <div className="rb-stats">
          {spec.items.map((it, i) => (
            <div className="rb-stat" key={i}>
              <span className="rb-stat-v mono">{fmtNum(it.value)}</span>
              <span className="rb-stat-l">{it.label}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (spec.type === "chart") {
    const vals = spec.values.map(v => (+v || 0));
    let body = null;
    if (spec.chart === "line") body = <LineChart labels={spec.labels} vals={vals} />;
    else if (spec.chart === "pie") body = <PieChart labels={spec.labels} vals={vals} />;
    else if (spec.chart === "bar" && spec.orient === "v") body = <VBars labels={spec.labels} vals={vals} />;
    else body = <HBars labels={spec.labels} vals={vals} />;
    return (
      <div className="rb-chart">
        {spec.title && <div className="rb-title">{spec.title}</div>}
        {body}
      </div>
    );
  }
  return null;
}

export { RenderBlock, ChatLightbox };
