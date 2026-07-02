/* Pure text helpers shared across the LLM, agent and trust layers.
   No I/O, no shared state. */

// strip a model's <think> reasoning blocks from its visible output
function stripThink(s) {
  s = String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "");
  const i = s.indexOf("<think>");   // unclosed block → everything after it is reasoning
  return (i >= 0 ? s.slice(0, i) : s).trim();
}

// size num_ctx so a long prompt isn't silently truncated to Ollama's small default (~2048),
// which makes the model return empty/garbage (e.g. drafter revisions over a big draft+transcript).
function fitCtx(sys, user, maxTokens) {
  const need = Math.ceil((String(sys || "").length + String(user || "").length + 200) / 3) + maxTokens + 256;
  return [4096, 8192, 16384, 32768, 65536, 131072].find(b => b >= need) || 131072;
}

// find a readable snippet in `text` containing the digits (tolerating thousands separators/spaces)
function snippetFor(text, digits) {
  let pat; try { pat = new RegExp(digits.split("").join("[,\\s]?")); } catch { return null; }
  const mm = pat.exec(text); if (!mm) return null;
  const i = mm.index, j = i + mm[0].length;
  const s = Math.max(0, i - 60), e = Math.min(text.length, j + 60);
  return (s > 0 ? "…" : "") + text.slice(s, e).replace(/\s+/g, " ").trim() + (e < text.length ? "…" : "");
}

// map distinctive numbers in the answer back to the evidence row they came from
function buildProvenance(answer, evidence) {
  const out = [], seen = new Set();
  const numRe = /\d[\d,]*(?:\.\d+)?/g; let m;
  while ((m = numRe.exec(answer)) && out.length < 12) {
    const raw = m[0], digits = raw.replace(/[^\d]/g, "");
    if (digits.length < 3 || seen.has(digits)) continue;     // skip trivial numbers / dupes
    for (const e of evidence) {
      const snip = snippetFor(e.text, digits);
      if (snip) { out.push({ value: raw, source: e.source, snippet: snip }); seen.add(digits); break; }
    }
  }
  return out;
}

module.exports = { stripThink, fitCtx, snippetFor, buildProvenance };
