/* ============================================================
   RAG retrieval — top-K chunks for a query via cosine + MMR diversification,
   with a hybrid keyword bonus (distinctive numbers/long tokens add to the cosine
   score, never discount it). Reads indexes built by src/rag/index.js.
   ============================================================ */
const { loadIndex, embed } = require("./index");
const { OLLAMA_EMBED_MODEL, OLLAMA_KEEP_ALIVE } = require("../config");
const ollamaConn = require("../llm/ollama-conn");

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function norm(a) { return Math.sqrt(dot(a, a)) || 1; }
function cosine(a, b) { return dot(a, b) / (norm(a) * norm(b)); }

// hybrid scoring: embeddings find meaning; distinctive keywords (numbers, long tokens) add a
// BONUS on top — never a discount — so purely semantic matches keep their full cosine score
// and the existing score thresholds (search_docs 0.4, assistant KB 0.5) keep their meaning.
const KW_STOP = new Set(["the","a","an","and","or","of","in","on","at","to","for","is","are","was","were","what","which","who","how","when","where","does","do","did","my","me","i","it","this","that","with","about","from","by"]);
function kwTerms(q) {
  return [...new Set((String(q).toLowerCase().match(/[a-z0-9][a-z0-9.\-]+/g) || []))]
    .filter(w => !KW_STOP.has(w) && (/\d/.test(w) || w.length >= 4)).slice(0, 12)   // distinctive terms only — filler words can't shift rankings
    .map(w => ({ w, re: new RegExp("\\b" + w.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&") + "\\b"), weight: /\d/.test(w) || w.length >= 7 ? 1.6 : 1 }));
}
function kwScore(terms, lowText) {
  if (!terms.length) return 0;
  let hit = 0, max = 0;
  for (const t of terms) { max += t.weight; if (t.re.test(lowText)) hit += t.weight; }
  return max ? hit / max : 0;
}
// cross-encoder rerank via Ollama's /api/embed: for a BERT-style classification head (the
// architecture reranker GGUFs on Ollama typically use) the returned "embedding" is really a
// single relevance logit, not a vector — see qllama/bge-reranker-v2-m3's `cls.output` head
// (shape [1]). Squash it through a sigmoid so it composes with the existing 0..1 score scale.
async function rerankOne(model, query, text) {
  const r = await fetch(`${ollamaConn.baseUrl()}/api/embed`, {
    method: "POST", headers: ollamaConn.headers(),
    body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE, model, input: [`${query}\n${text}`] }),
  });
  if (!r.ok) throw new Error(`rerank ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json();
  const v = (j.embeddings || [])[0];
  if (!v || !v.length) throw new Error("rerank: empty output");
  return 1 / (1 + Math.exp(-v[0]));   // sigmoid
}
// best-effort: any failure (model not pulled, server error, unexpected output shape) leaves
// `scored` untouched so retrieve() silently falls back to embedding-only ranking.
async function rerank(model, query, candidates) {
  const scores = await Promise.all(candidates.map(c => rerankOne(model, query, c.text)));
  return candidates.map((c, i) => ({ ...c, score: scores[i] }));
}
async function retrieve(folderPath, query, k = 8, opts = {}) {
  const idx = loadIndex(folderPath);
  if (!idx) return { hits: [], indexed: false };
  const pool = [];
  for (const [p, f] of Object.entries(idx.files))
    for (const c of f.chunks) pool.push({ name: f.name, path: p, text: c.text, vec: c.vec });
  if (!pool.length) return { hits: [], indexed: true };
  // embed the query with whatever model actually built this index (not necessarily the caller's
  // current setting) — comparing vectors from two different embedding models is silently wrong,
  // not just stale, so the index's own record of its embedding model always wins.
  const [qv] = await embed([query], idx.embedModel || OLLAMA_EMBED_MODEL);
  const terms = kwTerms(query);
  let scored = pool.map(c => ({ ...c, score: Math.min(1, cosine(qv, c.vec) + 0.2 * kwScore(terms, (c.name + " " + c.text).toLowerCase())) }))
    .sort((a, b) => b.score - a.score).slice(0, 60);
  if (opts.rerankModel) {
    try {
      const RERANK_POOL = 20;
      const reranked = await rerank(opts.rerankModel, query, scored.slice(0, RERANK_POOL));
      scored = [...reranked, ...scored.slice(RERANK_POOL)].sort((a, b) => b.score - a.score);
    } catch (e) { console.error("rerank failed, falling back to embedding-only ranking:", e.message); }
  }
  // MMR for diversity, with a per-file cap so one large document can't hog the results
  const lambda = 0.7, selected = [], perFile = {}, PER_FILE_CAP = 2;
  while (selected.length < Math.min(k, scored.length)) {
    let best = null, bestVal = -Infinity;
    for (const cand of scored) {
      if (selected.includes(cand)) continue;
      if ((perFile[cand.path] || 0) >= PER_FILE_CAP) continue;
      const div = selected.length ? Math.max(...selected.map(s => cosine(cand.vec, s.vec))) : 0;
      const val = lambda * cand.score - (1 - lambda) * div;
      if (val > bestVal) { bestVal = val; best = cand; }
    }
    if (!best) break;
    selected.push(best); perFile[best.path] = (perFile[best.path] || 0) + 1;
  }
  return { hits: selected.map(s => ({ name: s.name, path: s.path, text: s.text, score: +s.score.toFixed(3) })), indexed: true };
}

module.exports = { dot, norm, cosine, kwTerms, kwScore, retrieve };
