import { Icon, thumbUrl } from "./icons.jsx";
// graph.jsx — Knowledge graph. Entity-first explorer over your photos + documents.
// 100% LLM-free: nodes/edges come from the server's cheap signals (named people, GPS places,
// tags, deterministic NER). Default is a readable entity BROWSER (list + per-entity ego graph);
// the global force-graph is an optional "Overview" for those who want the big picture.
const GRAPH_KIND = {
  person: { color: "#5b8def", label: "People",  hint: "faces you named in People" },
  place:  { color: "#2bb673", label: "Places",  hint: "photo GPS locations" },
  topic:  { color: "#e0a82e", label: "Topics",  hint: "your tags" },
  org:    { color: "#b06ad9", label: "Orgs",    hint: "organizations found in documents" },
  term:   { color: "#8a94a6", label: "Terms",   hint: "other names found in documents" },
};
const KIND_ORDER = ["person", "place", "topic", "org", "term"];
const kindColor = k => (GRAPH_KIND[k] || GRAPH_KIND.term).color;

// ---- small radial ego graph shown in the detail pane (always legible) ----
function EgoGraph({ label, kind, neighbors, onPick }) {
  const W = 380, H = 300, CX = W / 2, CY = H / 2;
  const ns = (neighbors || []).slice(0, 18);
  const k = ns.length || 1;
  const R = Math.min(118, 58 + k * 5);
  const at = i => { const a = (i / k) * Math.PI * 2 - Math.PI / 2; return { x: CX + Math.cos(a) * R, y: CY + Math.sin(a) * R }; };
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 240 }}>
      {ns.map((nb, i) => { const p = at(i); return <line key={"l" + i} x1={CX} y1={CY} x2={p.x} y2={p.y} stroke="var(--line)" strokeWidth={1 + Math.min(2.5, nb.w * 0.5)} strokeOpacity={0.6} />; })}
      {ns.map((nb, i) => {
        const p = at(i);
        return (
          <g key={nb.id} transform={`translate(${p.x},${p.y})`} style={{ cursor: "pointer" }} onClick={() => onPick(nb.id)}>
            <circle r={7} fill={kindColor(nb.kind)} stroke="#0003" />
            <text x={0} y={-11} fontSize={10.5} textAnchor="middle" fill="var(--ink-2)" style={{ pointerEvents: "none" }}>{nb.label.length > 16 ? nb.label.slice(0, 16) + "…" : nb.label}</text>
          </g>
        );
      })}
      <g transform={`translate(${CX},${CY})`}>
        <circle r={13} fill={kindColor(kind)} stroke="var(--ink)" strokeWidth={2} />
        <text x={0} y={28} fontSize={12} fontWeight={700} textAnchor="middle" fill="var(--ink)" style={{ pointerEvents: "none" }}>{label.length > 22 ? label.slice(0, 22) + "…" : label}</text>
      </g>
    </svg>
  );
}

// ---- shared detail pane (used by both Browse and Overview) ----
function DetailPane({ detail, loading, onPick, onOpenPath, onAsk }) {
  if (loading || !detail) return <div className="ink-3 t-sm" style={{ padding: 18 }}>{loading ? "Loading…" : "Select an entity to see its connections, photos and documents."}</div>;
  const meta = GRAPH_KIND[detail.kind] || {};
  return (
    <div className="col" style={{ gap: 14, padding: 16 }}>
      <div className="col" style={{ gap: 6 }}>
        <span className="row gap-2" style={{ alignItems: "center" }}>
          <span style={{ width: 11, height: 11, borderRadius: 11, background: kindColor(detail.kind) }} />
          <span className="x-bold" style={{ fontSize: 18 }}>{detail.label}</span>
        </span>
        <span className="t-xs ink-3">{meta.label || detail.kind} · {detail.photos.length} photo{detail.photos.length === 1 ? "" : "s"} · {detail.docs.length} doc{detail.docs.length === 1 ? "" : "s"} · {detail.neighbors.length} connection{detail.neighbors.length === 1 ? "" : "s"}</span>
        {onAsk && <button className="btn sm" style={{ alignSelf: "flex-start", marginTop: 2 }} onClick={() => onAsk(`What do I know about ${detail.label}? Summarize what's in my files.`)}>
          <Icon name="sparkles" size={13} /> Ask AI about this
        </button>}
      </div>

      {detail.neighbors.length > 0 && (
        <div className="col" style={{ gap: 2, border: "1px solid var(--line)", borderRadius: 10, background: "var(--surface-2)", padding: "4px 0" }}>
          <EgoGraph label={detail.label} kind={detail.kind} neighbors={detail.neighbors} onPick={onPick} />
        </div>
      )}

      {detail.photos.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <span className="t-xs semi ink-3">Photos</span>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 5 }}>
            {detail.photos.map(p => (
              <div key={p} className="src-thumb" style={{ aspectRatio: "1", cursor: "pointer" }} onClick={() => onOpenPath && onOpenPath(p)} title={p.split("/").pop()}>
                <img src={thumbUrl(p, 160)} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", borderRadius: 6 }} />
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.docs.length > 0 && (
        <div className="col" style={{ gap: 6 }}>
          <span className="t-xs semi ink-3">Documents</span>
          <div className="col" style={{ gap: 4 }}>
            {detail.docs.map(d => (
              <button key={d.path} className="row gap-2 doc-row" style={{ alignItems: "center", padding: "6px 8px", borderRadius: 7, textAlign: "left", border: "1px solid var(--line)", background: "var(--surface)" }} onClick={() => onOpenPath && onOpenPath(d.path)} title={d.path}>
                <Icon name="file" size={14} style={{ color: "var(--ink-3)", flexShrink: 0 }} />
                <span className="t-sm truncate">{d.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- optional global force graph (Overview mode) ----
function OverviewGraph({ nodes, edges, hidden, degree, sel, onPick }) {
  const pos = React.useRef(new Map());
  const alpha = React.useRef(0);
  const raf = React.useRef(0);
  const pan = React.useRef(null);
  const [view, setView] = React.useState({ x: 0, y: 0, k: 1 });
  const [minLinks, setMinLinks] = React.useState(0);
  const [, render] = React.useReducer(x => x + 1, 0);
  const W = 1200, H = 820, CX = W / 2, CY = H / 2;

  const vis = React.useMemo(() => nodes.filter(n => !hidden.has(n.kind) && (degree[n.id] || 0) >= minLinks), [nodes, hidden, degree, minLinks]);
  const visIds = React.useMemo(() => new Set(vis.map(n => n.id)), [vis]);
  const visEdges = React.useMemo(() => edges.filter(e => visIds.has(e.a) && visIds.has(e.b)), [edges, visIds]);
  const maxDeg = React.useMemo(() => Math.max(1, ...Object.values(degree)), [degree]);

  React.useEffect(() => {
    const P = pos.current, N = nodes.length || 1;
    nodes.forEach((n, i) => { if (!P.has(n.id)) { const a = (i / N) * Math.PI * 2, r = 200 + Math.random() * 220; P.set(n.id, { x: CX + Math.cos(a) * r, y: CY + Math.sin(a) * r, vx: 0, vy: 0 }); } });
    alpha.current = 1; if (!raf.current) raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [nodes]);

  function step() {
    const ns = nodes, es = edges, P = pos.current, a = alpha.current, spread = ns.length > 90 ? 1.5 : 1;
    for (let i = 0; i < ns.length; i++) {
      const A = P.get(ns[i].id); if (!A) continue;
      for (let j = i + 1; j < ns.length; j++) {
        const B = P.get(ns[j].id); if (!B) continue;
        let dx = A.x - B.x, dy = A.y - B.y, d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
        const rep = (3000 * spread) / d2, fx = (dx / d) * rep, fy = (dy / d) * rep;
        A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
      }
    }
    for (const e of es) {
      const A = P.get(e.a), B = P.get(e.b); if (!A || !B) continue;
      let dx = B.x - A.x, dy = B.y - A.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const k = 0.014 * (d - 110), fx = (dx / d) * k, fy = (dy / d) * k;
      A.vx += fx; A.vy += fy; B.vx -= fx; B.vy -= fy;
    }
    for (const n of ns) { const A = P.get(n.id); if (!A) continue; A.vx += (CX - A.x) * 0.0018; A.vy += (CY - A.y) * 0.0018; A.vx *= 0.85; A.vy *= 0.85; A.x += A.vx * a; A.y += A.vy * a; }
    alpha.current = a * 0.99; render();
    raf.current = alpha.current > 0.02 ? requestAnimationFrame(step) : 0;
  }

  function onWheel(e) { e.preventDefault(); const k = Math.min(2.5, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.1 : 0.9))); setView(v => ({ ...v, k })); }
  function onDown(e) { pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; }
  function onMove(e) { if (pan.current) setView(v => ({ ...v, x: pan.current.vx + (e.clientX - pan.current.x), y: pan.current.vy + (e.clientY - pan.current.y) })); }
  function onUp() { pan.current = null; }
  const nb = React.useMemo(() => { if (!sel) return null; const s = new Set([sel]); for (const e of visEdges) { if (e.a === sel) s.add(e.b); if (e.b === sel) s.add(e.a); } return s; }, [sel, visEdges]);

  return (
    <div className="grow col" style={{ minWidth: 0 }}>
      <div className="row gap-2" style={{ padding: "6px 14px", alignItems: "center", borderBottom: "1px solid var(--line)" }}>
        <span className="t-xs ink-3">Min links {minLinks}</span>
        <input className="range" type="range" min={0} max={Math.min(8, Math.max(1, maxDeg))} step={1} value={minLinks} style={{ width: 110 }} onChange={e => setMinLinks(+e.target.value)} />
        <span className="t-xs ink-4" style={{ marginLeft: "auto" }}>{vis.length} shown · drag to pan, scroll to zoom</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", flex: 1, minHeight: 0, cursor: pan.current ? "grabbing" : "grab", touchAction: "none" }}
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onClick={() => onPick(null)}>
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
          {visEdges.map((e, i) => { const A = pos.current.get(e.a), B = pos.current.get(e.b); if (!A || !B) return null; const on = nb && (e.a === sel || e.b === sel); return <line key={i} x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={on ? "var(--accent)" : "var(--line)"} strokeWidth={on ? 1.4 : 1} strokeOpacity={nb && !on ? 0.1 : 0.45} />; })}
          {vis.map(n => { const A = pos.current.get(n.id); if (!A) return null; const r = 6 + Math.min(16, n.weight * 1.4); const showLabel = view.k > 0.85 || sel === n.id || (degree[n.id] || 0) >= 5; const dim = nb && !nb.has(n.id); return (
            <g key={n.id} transform={`translate(${A.x},${A.y})`} style={{ cursor: "pointer", opacity: dim ? 0.15 : 1 }} onClick={ev => { ev.stopPropagation(); onPick(n.id); }}>
              <circle r={r} fill={kindColor(n.kind)} stroke={sel === n.id ? "var(--ink)" : "#0003"} strokeWidth={sel === n.id ? 2.5 : 1} />
              {showLabel && <text x={r + 3} y={4} fontSize={11} fill="var(--ink-2)" style={{ pointerEvents: "none" }}>{n.label.length > 22 ? n.label.slice(0, 22) + "…" : n.label}</text>}
            </g>
          ); })}
        </g>
      </svg>
    </div>
  );
}

function GraphPage({ onOpenPath, onAsk, placeLookup }) {
  const [nodes, setNodes] = React.useState([]);
  const [edges, setEdges] = React.useState([]);
  const [stats, setStats] = React.useState(null);
  const [loading, setLoading] = React.useState(true);
  const [sel, setSel] = React.useState(null);
  const [detail, setDetail] = React.useState(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [hidden, setHidden] = React.useState(new Set(["term"]));   // Terms hidden by default (noisy)
  const [mode, setMode] = React.useState("browse");               // "browse" | "overview"
  const [geocoding, setGeocoding] = React.useState(false);
  const selRef = React.useRef(null); selRef.current = sel;

  function load(query) {
    setLoading(true);
    fetch("/api/graph" + (query || "")).then(r => r.json()).then(d => {
      setNodes(d.nodes || []); setEdges(d.edges || []); setStats(d.stats || null); setLoading(false);
    }).catch(() => { setLoading(false); setNodes([]); setEdges([]); });
  }
  React.useEffect(() => { load(); }, []);

  async function namePlaces() {
    setGeocoding(true);
    try {
      const d = await fetch("/api/graph?geocode=1").then(r => r.json());
      setNodes(d.nodes || []); setEdges(d.edges || []); setStats(d.stats || null);
      if (selRef.current && selRef.current.startsWith("place:")) pick(selRef.current);   // refresh the open place's label
    } catch {}
    setGeocoding(false);
  }

  const byId = React.useMemo(() => Object.fromEntries(nodes.map(n => [n.id, n])), [nodes]);
  const degree = React.useMemo(() => { const d = {}; for (const e of edges) { d[e.a] = (d[e.a] || 0) + 1; d[e.b] = (d[e.b] || 0) + 1; } return d; }, [edges]);
  const counts = React.useMemo(() => { const c = {}; for (const n of nodes) c[n.kind] = (c[n.kind] || 0) + 1; return c; }, [nodes]);

  function pick(id) {
    setSel(id);
    if (!id) { setDetail(null); return; }
    setDetailLoading(true);
    fetch("/api/graph/entity?id=" + encodeURIComponent(id)).then(r => r.json()).then(d => { setDetail(d); setDetailLoading(false); }).catch(() => setDetailLoading(false));
  }
  function toggleKind(k) { setHidden(h => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; }); }

  // auto-select the most-connected visible entity once data lands (so the pane isn't empty)
  React.useEffect(() => {
    if (sel || !nodes.length) return;
    const top = nodes.filter(n => !hidden.has(n.kind)).sort((a, b) => (degree[b.id] || 0) - (degree[a.id] || 0))[0];
    if (top) pick(top.id);
  }, [nodes]);

  const ql = q.trim().toLowerCase();
  const grouped = React.useMemo(() => KIND_ORDER.filter(k => !hidden.has(k)).map(k => ({
    kind: k,
    items: nodes.filter(n => n.kind === k && (!ql || n.label.toLowerCase().includes(ql)))
      .sort((a, b) => (degree[b.id] || 0) - (degree[a.id] || 0)),
  })).filter(g => g.items.length), [nodes, hidden, ql, degree]);

  return (
    <div className="settings-scroll scroll" style={{ overflow: "hidden" }}>
      <div className="col" style={{ height: "100%", minHeight: 0 }}>
        {/* header */}
        <div className="row between" style={{ padding: "14px 18px 8px", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div className="col" style={{ gap: 2 }}>
            <span className="x-bold tighter" style={{ fontSize: 24 }}>Knowledge graph</span>
            <span className="ink-3 t-sm">People, places, topics and the photos &amp; documents that connect them — built locally, no AI calls.</span>
          </div>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <div className="row" style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
              <button className="btn sm ghost" style={{ borderRadius: 0, background: mode === "browse" ? "var(--surface-2)" : "transparent", color: mode === "browse" ? "var(--ink)" : "var(--ink-3)" }} onClick={() => setMode("browse")}><Icon name="layers" size={13} /> Browse</button>
              <button className="btn sm ghost" style={{ borderRadius: 0, background: mode === "overview" ? "var(--surface-2)" : "transparent", color: mode === "overview" ? "var(--ink)" : "var(--ink-3)" }} onClick={() => setMode("overview")}><Icon name="compass" size={13} /> Overview</button>
            </div>
            <input className="input" style={{ width: 180 }} placeholder="Find an entity…" value={q} onChange={e => setQ(e.target.value)} />
            {placeLookup && stats && stats.unnamedPlaces > 0 && (
              <button className="btn" onClick={namePlaces} disabled={geocoding} title="Look up city names for your photo locations (one online request per location, then cached).">
                <Icon name="compass" size={15} style={geocoding ? { animation: "spin 1s linear infinite" } : undefined} /> {geocoding ? "Naming…" : `Name places (${stats.unnamedPlaces})`}
              </button>
            )}
            {!placeLookup && stats && stats.unnamedPlaces > 0 && (
              <span className="t-xs ink-4" title="Turn on “Online place names” in Settings to name them">{stats.unnamedPlaces} places shown as coordinates</span>
            )}
            <button className="btn" onClick={() => load("?refresh=1")} title="Rebuild from the latest data — also scans your photos for GPS so Places appear"><Icon name="refresh" size={15} /> Rebuild</button>
          </div>
        </div>

        {/* kind filters */}
        <div className="row gap-2" style={{ padding: "0 18px 10px", flexWrap: "wrap", alignItems: "center" }}>
          <span className="t-xs ink-3" style={{ marginRight: 1 }}>Show:</span>
          {KIND_ORDER.map(k => { if (!counts[k]) return null; const meta = GRAPH_KIND[k], off = hidden.has(k); return (
            <button key={k} onClick={() => toggleKind(k)} title={(off ? "Show " : "Hide ") + meta.label + " — " + meta.hint}
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, fontWeight: 600, padding: "4px 10px", borderRadius: 99, cursor: "pointer", whiteSpace: "nowrap", transition: "all .14s",
                border: "1.5px solid " + (off ? "var(--line)" : meta.color), background: off ? "transparent" : meta.color + "22", color: off ? "var(--ink-4)" : "var(--ink)" }}>
              <span style={{ width: 10, height: 10, borderRadius: 10, display: "inline-block", boxSizing: "border-box", border: "1.5px solid " + (off ? "var(--ink-4)" : meta.color), background: off ? "transparent" : meta.color }} />
              {meta.label} {counts[k]}
            </button>
          ); })}
          {stats && <span className="t-xs ink-4" style={{ marginLeft: "auto" }}>{stats.nodes} entities · {stats.edges} links</span>}
        </div>

        {/* body */}
        <div className="row grow" style={{ minHeight: 0, gap: 0, borderTop: "1px solid var(--line)", alignItems: "stretch" }}>
          {loading ? (
            <div className="col center grow" style={{ gap: 8 }}><span className="dots"><span /><span /><span /></span><span className="ink-3 t-sm">Building graph…</span></div>
          ) : nodes.length === 0 ? (
            <div className="col center grow" style={{ gap: 8, padding: 40, textAlign: "center" }}>
              <Icon name="brain" size={28} style={{ color: "var(--ink-4)" }} />
              <span className="semi">Nothing to connect yet</span>
              <span className="ink-3 t-sm" style={{ maxWidth: 420 }}>The graph builds from things you already have: name faces in <b>People</b>, make photos &amp; documents searchable, and add tags. Then hit Rebuild.</span>
            </div>
          ) : mode === "overview" ? (
            <>
              <OverviewGraph nodes={nodes} edges={edges} hidden={hidden} degree={degree} sel={sel} onPick={pick} />
              {sel && <div className="col" style={{ width: 340, flexShrink: 0, minHeight: 0, borderLeft: "1px solid var(--line)", background: "var(--surface)", overflow: "auto" }}><DetailPane detail={detail} loading={detailLoading} onPick={pick} onOpenPath={onOpenPath} onAsk={onAsk} /></div>}
            </>
          ) : (
            <>
              {/* entity list */}
              <div className="col" style={{ width: 320, flexShrink: 0, minHeight: 0, borderRight: "1px solid var(--line)", overflow: "auto" }}>
                {grouped.length === 0 ? <div className="ink-3 t-sm" style={{ padding: 16 }}>No entities match.</div> : grouped.map(g => (
                  <div key={g.kind} className="col" style={{ gap: 0 }}>
                    <div className="row gap-2" style={{ alignItems: "center", padding: "9px 14px 5px", position: "sticky", top: 0, background: "var(--bg)", zIndex: 1 }}>
                      <span style={{ width: 9, height: 9, borderRadius: 9, background: kindColor(g.kind) }} />
                      <span className="t-xs semi">{GRAPH_KIND[g.kind].label}</span>
                      <span className="t-xs ink-4">{g.items.length}</span>
                    </div>
                    {g.items.map(n => (
                      <button key={n.id} onClick={() => pick(n.id)} className="row gap-2"
                        style={{ alignItems: "center", padding: "8px 14px", textAlign: "left", border: "none", borderLeft: "2px solid " + (sel === n.id ? kindColor(n.kind) : "transparent"), background: sel === n.id ? "var(--surface-2)" : "transparent", cursor: "pointer" }}>
                        <div className="col grow" style={{ gap: 1, minWidth: 0 }}>
                          <span className="t-sm truncate" style={{ fontWeight: sel === n.id ? 600 : 400 }}>{n.label}</span>
                          <span className="t-xs ink-4">{[n.photos ? `${n.photos} photo${n.photos === 1 ? "" : "s"}` : null, n.docs ? `${n.docs} doc${n.docs === 1 ? "" : "s"}` : null, `${degree[n.id] || 0} link${(degree[n.id] || 0) === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
              {/* detail */}
              <div className="grow" style={{ overflow: "auto", minWidth: 0, background: "var(--surface)" }}>
                <DetailPane detail={detail} loading={detailLoading} onPick={pick} onOpenPath={onOpenPath} onAsk={onAsk} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export { GraphPage };
