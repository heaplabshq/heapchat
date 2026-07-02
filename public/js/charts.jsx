/* Rich-render chart components for chat tool data (bars / line / pie + number
   formatting). Extracted from chat.jsx. Global-scope module (indirect-eval): its
   functions are visible to chat.jsx; RB_COLORS stays file-local. */

function fmtNum(v) {
  if (typeof v !== "number" || !isFinite(v)) return String(v);
  return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
const RB_COLORS = ["#4f46e5", "#0891b2", "#16a34a", "#d97706", "#db2777", "#7c3aed", "#dc2626", "#0d9488", "#ca8a04", "#2563eb"];

// horizontal bars (good for many categories / diverging +/-)
function HBars({ labels, vals }) {
  const maxAbs = Math.max(1, ...vals.map(Math.abs));
  const hasNeg = vals.some(v => v < 0);
  return (
    <div className="rb-hbars">
      {labels.map((lab, i) => {
        const v = vals[i], pct = Math.abs(v) / maxAbs * 100;
        const barStyle = hasNeg
          ? { position: "absolute", width: (pct / 2) + "%", [v < 0 ? "right" : "left"]: "50%" }
          : { position: "absolute", left: 0, width: pct + "%" };
        return (
          <div className="rb-row" key={i}>
            <span className="rb-label truncate" title={String(lab)}>{String(lab)}</span>
            <div className={"rb-track" + (hasNeg ? " diverging" : "")}>
              <div className={"rb-bar" + (v < 0 ? " neg" : "")} style={barStyle} />
            </div>
            <span className="rb-val mono">{fmtNum(v)}</span>
          </div>
        );
      })}
    </div>
  );
}

// vertical columns ("buildings up and down"), with a zero baseline for +/- values
function VBars({ labels, vals }) {
  const W = Math.max(300, labels.length * 54), H = 200, padB = 30, padT = 10, plotH = H - padB - padT;
  const max = Math.max(0, ...vals), min = Math.min(0, ...vals), range = (max - min) || 1;
  const zeroY = padT + (max / range) * plotH;
  const slot = (W - 8) / labels.length, bw = Math.min(40, slot * 0.62);
  return (
    <svg className="rb-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <line x1="0" y1={zeroY} x2={W} y2={zeroY} stroke="var(--line)" strokeWidth="1" />
      {labels.map((lab, i) => {
        const v = vals[i], cx = 4 + slot * i + slot / 2;
        const h = Math.abs(v) / range * plotH, y = v >= 0 ? zeroY - h : zeroY;
        return (
          <g key={i}>
            <rect x={cx - bw / 2} y={y} width={bw} height={Math.max(1, h)} rx="3" fill={v < 0 ? "#dc2626" : "var(--accent)"} />
            <text x={cx} y={v >= 0 ? y - 4 : y + h + 11} textAnchor="middle" className="rb-svg-val">{fmtNum(v)}</text>
            <text x={cx} y={H - 10} textAnchor="middle" className="rb-svg-lab">{String(lab).length > 8 ? String(lab).slice(0, 7) + "…" : String(lab)}</text>
          </g>
        );
      })}
    </svg>
  );
}

// line chart for time series
function LineChart({ labels, vals }) {
  const W = Math.max(320, labels.length * 46), H = 200, padB = 28, padT = 12, padL = 8, padR = 8;
  const plotH = H - padB - padT, plotW = W - padL - padR;
  const max = Math.max(...vals), min = Math.min(...vals), range = (max - min) || 1;
  const x = i => padL + (labels.length === 1 ? plotW / 2 : (i / (labels.length - 1)) * plotW);
  const y = v => padT + (1 - (v - min) / range) * plotH;
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  const every = Math.ceil(labels.length / 8);
  return (
    <svg className="rb-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {vals.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="2.6" fill="var(--accent)" />)}
      {labels.map((lab, i) => i % every === 0 ? (
        <text key={i} x={x(i)} y={H - 9} textAnchor="middle" className="rb-svg-lab">{String(lab).length > 9 ? String(lab).slice(0, 8) + "…" : String(lab)}</text>
      ) : null)}
    </svg>
  );
}

// pie / donut for composition
function PieChart({ labels, vals }) {
  const data = vals.map((v, i) => ({ v: Math.max(0, +v || 0), lab: labels[i], c: RB_COLORS[i % RB_COLORS.length] })).filter(d => d.v > 0);
  const total = data.reduce((a, d) => a + d.v, 0) || 1;
  const cx = 90, cy = 90, r = 78;
  let a = -Math.PI / 2;
  const arcs = data.map(d => {
    const a0 = a, a1 = a + (d.v / total) * Math.PI * 2; a = a1;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    return { d: `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`, c: d.c };
  });
  return (
    <div className="rb-pie">
      <svg viewBox="0 0 180 180" className="rb-pie-svg">
        {arcs.map((s, i) => <path key={i} d={s.d} fill={s.c} stroke="var(--surface)" strokeWidth="1.5" />)}
        <circle cx={cx} cy={cy} r="40" fill="var(--surface)" />
      </svg>
      <div className="rb-legend">
        {data.map((d, i) => (
          <div className="rb-leg" key={i}>
            <span className="rb-dot" style={{ background: d.c }} />
            <span className="rb-leg-lab truncate" title={String(d.lab)}>{String(d.lab)}</span>
            <span className="rb-leg-val mono">{fmtNum(d.v)} · {(d.v / total * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export { HBars, VBars, LineChart, PieChart, fmtNum };
