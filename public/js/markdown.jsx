/* Markdown + math + diagram rendering for chat answers. Extracted from chat.jsx.
   Global-scope module (indirect-eval): fmt / linkifyCites / wrapProvenance /
   enhanceRich / ProvText are visible to chat.jsx (and fmt to focus/quickask/
   settings/agent-trace); KATEX_* / TEX_* / mermaid state stay file-local.
   marked / DOMPurify / katex / mermaid resolve as globals at render time. */
const { useRef, useEffect } = React;

// full Markdown renderer
if (window.marked && marked.setOptions) marked.setOptions({ gfm: true, breaks: true });
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// turn filename mentions (e.g. [report.pdf] or report.pdf) into clickable citation links
function linkifyCites(text, names) {
  let out = text;
  for (const name of [...new Set(names)]) {
    if (!name) continue;
    const anchor = `<a class="cite" data-cite="${name.replace(/"/g, "&quot;")}">${name}</a>`;
    out = out.replace(new RegExp("\\[?" + escRe(name) + "\\]?", "g"), anchor);
  }
  return out;
}
function fmt(text, cites) {
  let src = text || "";
  if (cites && cites.length) src = linkifyCites(src, cites);
  let html;
  if (window.marked) {
    const raw = marked.parse(src);
    html = window.DOMPurify ? DOMPurify.sanitize(raw, { ADD_ATTR: ["data-cite", "class"] }) : raw;
  } else {
    html = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  }
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

// renders the answer markdown, then wraps any number traced to a source with a hover tooltip showing that source row
function wrapProvenance(root, provenance) {
  if (!root || !provenance || !provenance.length) return;
  const byKey = new Map(); provenance.forEach(p => byKey.set(String(p.value).replace(/[^\d]/g, ""), p));
  const values = [...new Set(provenance.map(p => String(p.value)))].sort((a, b) => b.length - a.length);
  let re; try { re = new RegExp("(" + values.map(escRe).join("|") + ")"); } catch { return; }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement && n.parentElement.closest("a,code,.prov,.katex")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const targets = []; let n;
  while ((n = walker.nextNode())) if (re.test(n.nodeValue)) targets.push(n);
  targets.forEach(node => {
    const parts = node.nodeValue.split(re); if (parts.length < 2) return;
    const frag = document.createDocumentFragment();
    parts.forEach((part, idx) => {
      if (idx % 2 === 1) {
        const p = byKey.get(part.replace(/[^\d]/g, ""));
        const span = document.createElement("span");
        span.className = "prov"; span.textContent = part;
        if (p) span.title = `${p.source}: ${p.snippet}`;
        frag.appendChild(span);
      } else if (part) frag.appendChild(document.createTextNode(part));
    });
    node.parentNode.replaceChild(frag, node);
  });
}
// math (KaTeX) — display: $$…$$ / \[…\] · inline: \(…\). Single $ is intentionally NOT a delimiter (avoids $-amount false positives).
// local models emit almost-valid LaTeX; fix the usual slips before KaTeX sees it (unescaped % is a TeX
// comment char — "\mathbf{20%}" swallows the closing brace and errors out as red source text)
function repairLatex(tex) {
  return tex
    .replace(/(^|[^\\])%/g, "$1\\%")        // bare % → \%  (20% stays "20%")
    .replace(/−/g, "-")                 // unicode minus
    .replace(/×/g, "\\times ")          // unicode ×
    .replace(/⋅/g, "\\cdot ")           // unicode ⋅
    .replace(/\\\\\s*$/, "");                // trailing line break
}
const KATEX_OPTS = {
  delimiters: [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "\\(", right: "\\)", display: false },
  ],
  throwOnError: false,
  strict: "ignore",                          // tolerate unknown unicode (₹, …) instead of erroring
  errorColor: "var(--ink-2)",                // unparseable math degrades to plain-looking text, not alarming red
  preProcess: repairLatex,
  ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
};
const KATEX_INLINE = { throwOnError: false, strict: "ignore", errorColor: "var(--ink-2)", displayMode: false };
// mermaid is 3.3 MB — load it lazily, only the first time a diagram actually appears
let mermaidLoading = null, mermaidSeq = 0;
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "vendor/mermaid.min.js";
    s.onload = () => { try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", suppressErrorRendering: true }); } catch {} res(window.mermaid); };
    s.onerror = rej;
    document.head.appendChild(s);
  });
  return mermaidLoading;
}
// local models write almost-valid mermaid; fix the usual slips before giving up on a diagram
function repairMermaid(src) {
  let s = src
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'")   // smart quotes
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")                              // markdown bold inside labels
    .replace(/([^-.>])->(?!>)/g, "$1-->");                             // single-dash arrows → edges
  const quote = label => '"' + label.replace(/"/g, "'") + '"';
  return s.split("\n").map(line => {
    if (/^\s*(subgraph|classDef|class|style|linkStyle|click|%%)/.test(line)) return line;
    return line
      .replace(/([A-Za-z0-9_]+)\[([^\[\]"|]*[(),:;{}][^\[\]"|]*)\]/g, (m, id, l) => id + "[" + quote(l) + "]")          // A[has (parens)] → A["has (parens)"]
      .replace(/([A-Za-z0-9_]+)\(\(([^()"]*[,:;][^()"]*)\)\)/g, (m, id, l) => id + "((" + quote(l) + "))")
      .replace(/([A-Za-z0-9_]+)\{([^{}"]*[(),:;][^{}"]*)\}/g, (m, id, l) => id + "{" + quote(l) + "}")
      .replace(/([A-Za-z0-9_]+)\(([^()"]*[,:;][^()"]*)\)/g, (m, id, l) => id + "(" + quote(l) + ")");
  }).join("\n");
}
function renderMermaid(root) {
  const blocks = [...root.querySelectorAll("code.language-mermaid")].filter(c => !(c.closest("pre") || c).dataset.mmdDone);
  if (!blocks.length) return;
  ensureMermaid().then(m => blocks.forEach(async code => {
    const host = code.closest("pre") || code; host.dataset.mmdDone = "1";
    const raw = code.textContent;
    const variants = [raw]; const fixed = repairMermaid(raw); if (fixed !== raw) variants.push(fixed);
    for (const srcText of variants) {
      const id = "mmd" + (mermaidSeq++);
      try {
        const ok = await m.parse(srcText, { suppressErrors: true });
        if (!ok) continue;   // invalid even as a repaired variant → try the next / keep the code block
        const { svg } = await m.render(id, srcText);
        const div = document.createElement("div"); div.className = "mermaid-rendered"; div.innerHTML = svg; host.replaceWith(div);
        return;
      } catch {
        [id, "d" + id].forEach(x => { const el = document.getElementById(x); if (el && el.parentNode === document.body) el.remove(); });   // clean up any stray temp node
      }
    }
    console.warn("[mermaid] diagram failed to parse even after repair — showing source:", raw.slice(0, 160));
  })).catch(() => {});
}
// render single-$ inline math ONLY when it contains a LaTeX command (\…) — so $\rightarrow$ renders but $5,000 stays text
function renderDollarMath(root) {
  if (!window.katex) return;
  const splitRe = /(\$[^$\n]*?\\[a-zA-Z][^$\n]*?\$)/;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement && n.parentElement.closest("a,code,pre,.katex,.prov")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const targets = []; let n;
  while ((n = walker.nextNode())) if (splitRe.test(n.nodeValue)) targets.push(n);
  targets.forEach(node => {
    const parts = node.nodeValue.split(splitRe);
    if (parts.length < 2) return;
    const frag = document.createDocumentFragment();
    parts.forEach(part => {
      const m = part.match(/^\$([^$\n]*)\$$/);
      if (m && /\\[a-zA-Z]/.test(m[1])) {
        const span = document.createElement("span");
        try { window.katex.render(repairLatex(m[1]), span, KATEX_INLINE); } catch { span.textContent = part; }
        frag.appendChild(span);
      } else if (part) frag.appendChild(document.createTextNode(part));
    });
    node.parentNode.replaceChild(frag, node);
  });
}
// render LaTeX the model forgot to wrap in any delimiter — e.g. a lone
// "\text{Rental ROI} = 0.20 \times 100 = \mathbf{20%}" sitting in plain prose.
// Runs AFTER the delimiter-based passes, so anything left holding \commands is bare LaTeX.
const TEX_TOK = "(?:\\\\[a-zA-Z]+|\\{[^{}]*(?:\\{[^{}]*\\}[^{}]*)*\\}|[0-9][0-9.,]*|[=+\\-*/^_()|.,!~ ×−⋅±÷%]|\\[|\\])";
const TEX_RUN_RE = new RegExp(`(${TEX_TOK}*\\\\[a-zA-Z]{2,}${TEX_TOK}*)`);
function renderBareLatex(root) {
  if (!window.katex) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.parentElement && n.parentElement.closest("a,code,pre,.katex,.prov")) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const targets = []; let n;
  while ((n = walker.nextNode())) if (/\\[a-zA-Z]{2,}/.test(n.nodeValue)) targets.push(n);
  targets.forEach(node => {
    const parts = node.nodeValue.split(TEX_RUN_RE);
    if (parts.length < 2) return;
    const frag = document.createDocumentFragment();
    parts.forEach((part, idx) => {
      if (idx % 2 === 1 && /\\[a-zA-Z]{2,}/.test(part)) {
        // peel off leading/trailing prose punctuation so ". " around the formula stays text
        const m2 = part.match(/^([\s.,!]*)([\s\S]*?)([\s.,!]*)$/);
        let [, pre, tex, post] = m2;
        // "[ \text{…} ]" → the brackets are display-math intent, drop them
        const br = tex.match(/^\[\s*([\s\S]*?)\s*\]$/); if (br) tex = br[1];
        if (pre) frag.appendChild(document.createTextNode(pre));
        const span = document.createElement("span");
        // bare runs are speculative — demand a clean parse, else leave the text exactly as it was
        // (protects non-math backslash text like Windows paths from being mangled)
        try { window.katex.render(repairLatex(tex), span, { ...KATEX_INLINE, throwOnError: true }); frag.appendChild(span); }
        catch { frag.appendChild(document.createTextNode(part.slice(pre.length))); post = ""; }   // pre is already in frag
        if (post) frag.appendChild(document.createTextNode(post));
      } else if (part) frag.appendChild(document.createTextNode(part));
    });
    node.parentNode.replaceChild(frag, node);
  });
}
function enhanceRich(root, live) {
  if (!root || live) return;   // only upgrade the finished answer (skip during streaming)
  try { if (window.renderMathInElement) window.renderMathInElement(root, KATEX_OPTS); } catch {}
  try { renderDollarMath(root); } catch {}
  try { renderBareLatex(root); } catch {}
  renderMermaid(root);
}
function ProvText({ text, cites, provenance, live }) {
  const ref = useRef(null);
  useEffect(() => { enhanceRich(ref.current, live); wrapProvenance(ref.current, provenance); }, [text, provenance, live]);
  let src = text || "";
  if (cites && cites.length) src = linkifyCites(src, cites);
  let html;
  if (window.marked) { const raw = marked.parse(src); html = window.DOMPurify ? DOMPurify.sanitize(raw, { ADD_ATTR: ["data-cite", "class"] }) : raw; }
  else html = src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

export { fmt, ProvText, linkifyCites, wrapProvenance, enhanceRich };
