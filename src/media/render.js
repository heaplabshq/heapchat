/* Structured-render specs — turn tabular/record data into table/chart/stat specs
   the client renders. Used by the agent tools and the /api/extract endpoint.
   Pure: no I/O, no shared state. */

const RENDER_MIN_ROWS = 3;        // don't render trivial data
const PREFER_NUM = /(pnl|p&l|p_and_l|profit|change|gain|loss|value|amount|total|qty|quantity|count|price|revenue|sales|score)/i;

function numericCol(rows, cols) {  // rows: array of arrays; returns {idx} of best numeric column or null
  let best = null;
  cols.forEach((name, i) => {
    const nums = rows.map(r => parseFloat(r[i])).filter(n => !isNaN(n));
    if (nums.length < Math.max(RENDER_MIN_ROWS, rows.length * 0.6)) return;
    const nonZero = nums.filter(n => n !== 0).length;
    if (nonZero === 0) return;                    // all-zero column carries no signal (e.g. unused `price` field)
    if (new Set(nums).size < 2) return;           // constant column → nothing worth charting
    const score = (PREFER_NUM.test(name) ? 1000 : 0) + nonZero + new Set(nums).size;
    if (!best || score > best.score) best = { idx: i, score };
  });
  return best;
}
function tableSpec(columns, rows) {
  return { type: "table", columns: columns.slice(0, 8), rows: rows.slice(0, 100).map(r => r.slice(0, 8)), total: rows.length };
}
function chartSpec(chart, title, labels, values, extra) {
  return { type: "chart", chart, title, labels: labels.slice(0, 40), values: values.slice(0, 40), ...(extra || {}) };
}
function statSpec(title, values) {
  const sum = values.reduce((a, b) => a + b, 0);
  return { type: "stat", title, items: [
    { label: "Total", value: sum },
    { label: "Average", value: sum / values.length },
    { label: "Max", value: Math.max(...values) },
    { label: "Min", value: Math.min(...values) },
  ] };
}
const DATE_LABEL = /^\s*(\d{4}[-/]\d{1,2}([-/]\d{1,2})?|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(\s+\d{2,4})?|q[1-4]\b|week\s*\d+)/i;
const PIE_HINT = /(percent|%|share|weight|allocat|composition|ratio|proportion|concentration|exposure|holding)/i;
function looksDateSeq(labels) {                       // x-axis is a time series → line chart
  const hits = labels.filter(l => DATE_LABEL.test(String(l))).length;
  return labels.length >= 4 && hits >= labels.length * 0.7;
}
// detect an explicit chart-type request in the user's message ("...in a pie chart")
function chartHintOf(text) {
  const q = String(text || "").toLowerCase();
  if (/\b(pie|donut|doughnut)\b/.test(q)) return "pie";
  if (/\bline\s+(chart|graph)\b/.test(q)) return "line";
  if (/\b(bar|column)\s+(chart|graph|s)?\b/.test(q) || /\bbar\s*chart\b/.test(q)) return "bar";
  return null;
}
// general "I want this visualised" intent — charts/tables only render when the user asks
const VISUAL_INTENT = /\b(chart|charts|graph|graphs|plot|plotted|visuali[sz]e|visuali[sz]ation|diagram|breakdown|distribution|histogram|table|tabulate|tabular)\b/i;
// → null (no visual wanted) | "auto" (pick type) | "pie"/"bar"/"line" (explicit type)
function wantsVisual(text) {
  return chartHintOf(text) || (VISUAL_INTENT.test(String(text || "")) ? "auto" : null);
}
// pick chart type + orientation for one numeric series, plus a KPI stat strip.
// `hint` (from an explicit user request) overrides the data-driven heuristic.
function seriesRenders(labelName, valName, labels, nums, hint) {
  const out = [];
  const allPos = nums.every(v => v >= 0) && nums.some(v => v > 0);
  let chart = "bar", extra = {};
  if (hint === "pie") chart = allPos ? "pie" : "bar";          // pie needs positive values
  else if (hint === "line") chart = "line";
  else if (hint === "bar") { chart = "bar"; extra.orient = labels.length <= 12 ? "v" : "h"; }
  else if (looksDateSeq(labels)) chart = "line";
  else if (PIE_HINT.test(valName) && allPos && labels.length >= 2 && labels.length <= 8) chart = "pie";
  else extra.orient = labels.length <= 12 ? "v" : "h";   // few categories → vertical columns; many → horizontal
  out.push(chartSpec(chart, `${valName} by ${labelName}`, labels.map(String), nums, extra));
  if (chart !== "pie") out.push(statSpec(valName, nums));
  return out;
}
// build renders from an array of plain objects (e.g. JSON from a connector)
// pull structured records out of a connector's text response (JSON, or JSON embedded in prose)
function parseRecords(text) {
  const tryParse = s => { try { return JSON.parse(s); } catch { return undefined; } };
  let j = tryParse(text);
  if (j === undefined) {                               // some MCP servers wrap JSON in prose / code fences
    const m = String(text).match(/```(?:json)?\s*([\[{][\s\S]*?[\]}])\s*```/) || String(text).match(/([\[{][\s\S]*[\]}])/);
    if (m) j = tryParse(m[1]);
  }
  return j === undefined ? null : j;
}
// dig through nested JSON ({data:{sectors:[…]}} or {INFY:{…},TCS:{…}}) to find an array of records
function findRecords(j, depth = 0) {
  if (Array.isArray(j)) return j;
  if (j && typeof j === "object" && depth < 4) {
    const vals = Object.values(j);
    // a dict keyed by id (e.g. holdings keyed by tradingsymbol) → array of records
    if (vals.length >= RENDER_MIN_ROWS && vals.every(v => v && typeof v === "object" && !Array.isArray(v)))
      return Object.entries(j).map(([k, v]) => ({ key: k, ...v }));
    for (const v of vals) { const r = findRecords(v, depth + 1); if (Array.isArray(r) && r.length) return r; }
  }
  return null;
}
function rendersFromObjects(arr, title, hint) {
  if (!hint) return [];                                // only render when the user asked for a visual
  arr = findRecords(arr) || arr;
  if (!Array.isArray(arr) || arr.length < RENDER_MIN_ROWS) return [];
  if (typeof arr[0] !== "object" || arr[0] === null || Array.isArray(arr[0])) return [];
  const cols = [...new Set(arr.flatMap(o => Object.keys(o)))].slice(0, 8);
  const rows = arr.map(o => cols.map(c => o[c]));
  const out = [tableSpec(cols, rows)];
  const labelIdx = cols.findIndex((c, i) => arr.some(o => typeof o[c] === "string"));
  const num = numericCol(rows, cols);
  if (num && labelIdx >= 0 && labelIdx !== num.idx) {
    out.push(...seriesRenders(cols[labelIdx], cols[num.idx], rows.map(r => String(r[labelIdx])), rows.map(r => parseFloat(r[num.idx]) || 0), hint));
  }
  return out;
}

module.exports = {
  RENDER_MIN_ROWS, numericCol, tableSpec, chartSpec, statSpec,
  looksDateSeq, chartHintOf, wantsVisual, seriesRenders,
  parseRecords, findRecords, rendersFromObjects,
};
