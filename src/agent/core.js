/* ============================================================
   AGENT core — native tool-calling loop over a target context (the knowledge
   base, an open folder, or a single file). Holds the tool registry + execTool,
   the system-prompt/tool-def builders, the deep-research and multi-agent
   pipelines, and the chat-image attachment helpers the tools resolve against.
   Routes (/api/agent, /api/chat, …) live in server.js and call into here.
   ============================================================ */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");
const exifr = require("exifr");
const { OLLAMA_MODEL, OLLAMA_KEEP_ALIVE } = require("../config");
const ollamaConn = require("../llm/ollama-conn");
const { kindOf, extOf, fmtSize, fmtDate, TEXTLIKE, isImageFile, safeName } = require("../util/files");
const { stripThink, fitCtx, snippetFor, buildProvenance } = require("../util/text");
const { tableSpec, chartSpec, numericCol, seriesRenders, parseRecords, findRecords, rendersFromObjects, RENDER_MIN_ROWS } = require("../media/render");
const { ddgText, ddgImages, fetchPageText, htmlToText, extractImages, DDG_HEADERS } = require("../web/search");
const { loadIndex, buildIndex, buildFileIndex, indexedFiles, walkFiles, embed, indexFiles } = require("../rag/index");
const { cosine, retrieve } = require("../rag/retrieve");
const { extractText, extractRaw } = require("../rag/extract");
const { runExtraction } = require("../rag/extract-batch");
const { relatedFor } = require("../media/phash");
const { graphRetrieve, docExcerptsFor, reverseGeocode, graphFor, graphCache } = require("../media/graph");
const { faceDist, personDescs } = require("../media/photos");
const { dtGenerate, dtEdit, dtEcho } = require("../media/drawthings");
const { saveGeneratedImage } = require("../media/image-prompt");
const { describeImage } = require("../llm/vision");
const { completeJSON, completeText } = require("../llm/ollama");
const { providerOf: modelProviderOf, bareModel: routedBareModel, completeJSON: routedCompleteJSON, completeText: routedCompleteText } = require("../llm/router");
const providerLLM = require("../llm/providers");
const { addMemory, sysInfoBlock } = require("../llm/memory");
const { addSkill, findSkills, markSkillUsed } = require("../llm/skills");
const { getTags, setTags, imageMeta, tagStore, faceStore, placeNames, persistTags, persistImageMeta, persistPlaceNames } = require("../state/sidecars");
const { storesFor } = require("../state/user-stores");
const { canAccessPath } = require("../auth/access");
const { users } = require("../auth/accounts");
const { mcpEnabled, mcpCallTool, mcpListTools } = require("../mcp/client");

// find a file by name on disk within the agent's context (even if not yet indexed)
async function findFileOnDisk(ctx, name) {
  const want = String(name || "").toLowerCase();
  if (ctx.isFile) return path.basename(ctx.path).toLowerCase() === want || path.basename(ctx.path).toLowerCase().includes(want) ? ctx.path : null;
  const files = ctx.files || await walkFiles(ctx.path);
  return files.find(f => path.basename(f).toLowerCase() === want) || files.find(f => path.basename(f).toLowerCase().includes(want)) || null;
}

// ctx = { isFile, path, key, fresh }  — key is the index key (file path or folder path)
// Incrementally refreshes the index once per request (reuses cached embeddings, only
// embeds new/changed files) so newly added files are picked up automatically.
async function ensureIndex(ctx) {
  if (ctx.fresh) return;
  try {
    if (ctx.files) await indexFiles(ctx.key, ctx.files);   // selection scope: index exactly those files
    else ctx.isFile ? await buildFileIndex(ctx.path) : await buildIndex(ctx.path);
  } catch {}
  ctx.fresh = true;
}
function findIndexed(ctx, name) {
  const files = indexedFiles(ctx.key);
  const want = String(name || "").toLowerCase();
  return files.find(x => x.name.toLowerCase() === want) || files.find(x => x.name.toLowerCase().includes(want));
}

/* ---- render specs (chart/table/stat) → src/media/render.js ---- */

/* ---- trust layer: self-verification + value-level provenance ---- */
const VERIFY_SYS =
  "You are a strict fact-checker. The EVIDENCE is a set of excerpts, each tagged with its source name in [brackets]. Compare the ANSWER against the EVIDENCE. " +
  "Judge ONLY the answer's factual claims about that data — ignore general knowledge, opinions, and conversational filler. " +
  "Reply with ONLY compact JSON, no prose: {\"verdict\":\"supported\"|\"partial\"|\"unsupported\",\"issues\":[\"<short claim not supported by the evidence>\"],\"used\":[\"<exact source name(s) whose excerpt actually supports the answer>\"]}. " +
  "Use \"supported\" if every data claim checks out, \"partial\" if some do and some don't, \"unsupported\" if the main claim isn't in the evidence. " +
  "In \"used\", list ONLY the sources the answer actually relies on — usually one — not every source shown. At most 3 short issues.";
// completeJSON / completeText → src/llm/ollama.js
// stripThink / fitCtx / snippetFor / buildProvenance → src/util/text.js

/* ---- web search (DuckDuckGo) → src/web/search.js ---- */

// shared extraction: read each file (vision OCR for photos) and pull `fields` into table rows. used by the tool AND the /api/extract button.
// runExtraction (multi-file structured extraction → table) → src/rag/extract-batch.js

/* ---- TOOL REGISTRY — add a tool by appending one entry { def, run } ---- */
const TOOL_REGISTRY = {
  web_search: {
    def: { type: "function", function: {
      name: "web_search",
      description: "Search the public web (DuckDuckGo) for current events or information NOT in the user's files. Use type 'text' for web pages/answers, 'images' to fetch pictures to show. Always cite the result URLs in your answer.",
      parameters: { type: "object", properties: { query: { type: "string" }, type: { type: "string", enum: ["text", "images"], description: "'text' (default) or 'images'" } }, required: ["query"] },
    } },
    run: async (args, ctx) => {
      const q = String(args.query || "").trim();
      if (!q) return { result: "Empty search query.", summary: "empty" };
      // honor an explicit type; otherwise fall back to image search when the user clearly asked for pictures
      const type = args.type === "images" ? "images" : args.type === "text" ? "text" : (ctx && ctx.wantsImages ? "images" : "text");
      try {
        if (type === "images") {
          const imgs = (await ddgImages(q)).slice(0, 12);
          if (!imgs.length) return { result: `No images found for "${q}".`, summary: "0 images" };
          const render = [{ type: "images", title: `Images · ${q}`, items: imgs.map(i => ({ thumb: i.thumbnail || i.image, image: i.image, url: i.url, title: i.title, source: i.source })) }];
          return { result: `Found ${imgs.length} images for "${q}": ` + imgs.slice(0, 6).map(i => `${i.title} (${i.source})`).join("; "), summary: `${imgs.length} images`, render, sources: imgs.slice(0, 6).map(i => ({ name: i.title || i.source, path: i.url, score: 1 })) };
        }
        const res = (await ddgText(q)).slice(0, 6);
        if (!res.length) return { result: `No web results for "${q}".`, summary: "0 results" };
        // no inline card — these are the agent's working results; they surface as cited source chips + in the step trace
        const result = res.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n");
        return { result, summary: `${res.length} results`, sources: res.map(r => ({ name: r.title, path: r.url, score: 1 })) };
      } catch (e) { return { result: `Web search failed: ${e.message}`, summary: "error" }; }
    },
  },
  read_url: {
    def: { type: "function", function: {
      name: "read_url",
      description: "Fetch a web page (or any http/https link) and read its main text — a direct scrape, no web search involved. Use whenever the user pastes or names a URL and wants it read/summarized/scraped, or to read a specific web_search result in full. Pass the complete URL.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    } },
    run: async (args) => {
      const url = String(args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { result: "Provide a full http(s) URL.", summary: "bad url" };
      try {
        const r = await fetch(url, { headers: DDG_HEADERS, redirect: "follow", signal: AbortSignal.timeout(15000) });
        if (!r.ok) return { result: `That page returned HTTP ${r.status}.`, summary: `http ${r.status}` };
        const ct = r.headers.get("content-type") || "";
        if (!/text\/html|text\/plain|xhtml/i.test(ct)) return { result: `That URL is ${ct || "non-text"} — can't read it as text.`, summary: "non-text" };
        const html = await r.text();
        const text = htmlToText(html);
        const imgs = extractImages(html, r.url || url);
        if (!text && !imgs.length) return { result: "No readable text found on that page.", summary: "empty" };
        const body = text.length > 8000 ? text.slice(0, 8000) + "\n…[truncated]" : text;
        const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
        const render = imgs.length ? [{ type: "images", title: `Images · ${host}`, items: imgs }] : undefined;
        const imgNote = imgs.length ? `\n\n[${imgs.length} image${imgs.length === 1 ? "" : "s"} on the page shown below.]` : "";
        return { result: `Content of ${url}:\n${body}${imgNote}`, summary: `read ${host}${imgs.length ? ` · ${imgs.length} img` : ""}`, render, sources: [{ name: host, path: url, score: 1 }] };
      } catch (e) { return { result: `Could not fetch the page: ${e.message}`, summary: "error" }; }
    },
  },
  make_chart: {
    def: { type: "function", function: {
      name: "make_chart",
      description: "Render a chart or table to display to the user. Call this WHENEVER the user asks to plot, chart, graph, visualize, or tabulate data — you decide the type, labels, and values from their request and the data you have. NEVER draw a chart with ASCII art, emoji bars, or a Markdown table when a visual is asked for; always call this tool instead.",
      parameters: { type: "object", properties: {
        type: { type: "string", enum: ["bar", "pie", "line", "table"], description: "the kind of visual the user asked for" },
        title: { type: "string", description: "short title for the chart" },
        labels: { type: "array", items: { type: "string" }, description: "category / x-axis labels — one per value (bar, pie, line)" },
        values: { type: "array", items: { type: "number" }, description: "numeric values aligned 1:1 with labels (bar, pie, line)" },
        columns: { type: "array", items: { type: "string" }, description: "column headers (table only)" },
        rows: { type: "array", items: { type: "array" }, description: "rows of cells, each aligned with columns (table only)" },
      }, required: ["type"] },
    } },
    run: async (args) => {
      const type = String(args.type || "bar").toLowerCase();
      if (type === "table") {
        const cols = (Array.isArray(args.columns) ? args.columns : []).map(String);
        const rows = (Array.isArray(args.rows) ? args.rows : []).map(r => Array.isArray(r) ? r : [r]);
        if (cols.length < 1 || rows.length < 1) return { result: "make_chart(table) needs both columns and rows.", summary: "skipped" };
        return { result: `Rendered a ${rows.length}×${cols.length} table.`, summary: "rendered table", render: [tableSpec(cols, rows)] };
      }
      const labels = (Array.isArray(args.labels) ? args.labels : []).map(String);
      const values = (Array.isArray(args.values) ? args.values : []).map(v => typeof v === "number" ? v : parseFloat(v) || 0);
      const n = Math.min(labels.length, values.length);
      if (n < 2) return { result: "make_chart needs at least 2 labels and 2 matching values.", summary: "skipped" };
      let chart = type, extra = {};
      if (chart === "pie" && values.slice(0, n).some(v => v < 0)) chart = "bar";   // a pie can't show negative values
      if (chart === "bar") extra.orient = n <= 12 ? "v" : "h";
      return { result: `Rendered a ${chart} chart with ${n} points.`, summary: `rendered ${chart}`, render: [chartSpec(chart, args.title || "", labels.slice(0, n), values.slice(0, n), extra)] };
    },
  },
  extract_table: {
    def: { type: "function", function: {
      name: "extract_table",
      description: "Extract structured fields from EVERY document and photo ALREADY in the user's current folder/knowledge base into a spreadsheet-style table — e.g. receipts/invoices → vendor, date, amount; business cards → name, company, email; IDs → name, number, expiry. It automatically finds and reads every file itself (it reads photos/scans with the vision model — OCR), so you do NOT need the user to attach or provide any file: just call it. Use whenever the user asks to extract, tabulate, pull fields, OCR, read, or turn documents/receipts/photos into a table/spreadsheet. Pass the field names to use as columns (or omit to auto-detect).",
      parameters: { type: "object", properties: {
        fields: { type: "array", items: { type: "string" }, description: "columns to extract from each document, e.g. [\"vendor\",\"date\",\"amount\"]. Leave empty to auto-detect sensible fields." },
      }, required: [] },
    } },
    run: async (args, ctx) => {
      const files = (ctx.isFile ? [ctx.path] : ctx.files || (await walkFiles(ctx.path))).slice(0, 30);
      if (!files.length) return { result: "No documents found to extract from.", summary: "no files" };
      const { fields, columns, rows, sources } = await runExtraction(files, args.fields);
      const preview = [columns.join(" | "), ...rows.slice(0, 6).map(r => r.join(" | "))].join("\n");
      return {
        result: `Extracted [${fields.join(", ")}] from ${rows.length} document${rows.length === 1 ? "" : "s"}.\n\n${preview}`,
        summary: `extracted ${rows.length}×${fields.length}`,
        render: [tableSpec(columns, rows)],
        sources,
      };
    },
  },
  search_docs: {
    def: { type: "function", function: {
      name: "search_docs",
      description: "Search the documents by meaning and return the most relevant excerpts with source filenames. Works for PDF, Word, Markdown, CSV, code, text, and images (indexed by a description of their visual content). Use this to find content or answer questions about the user's files.",
      parameters: { type: "object", properties: { query: { type: "string", description: "what to look for" } }, required: ["query"] },
    } },
    run: async (args, ctx) => {
      await ensureIndex(ctx);
      const q0 = String(args.query || "");
      let hits = (await retrieve(ctx.key, q0, 8)).hits.filter(h => h.score >= 0.4);
      // corrective pass (CRAG-lite): weak retrieval → rephrase the query once and merge the second round
      let rephrased = "";
      if (!hits.length || hits[0].score < 0.5) {
        try {
          const j = await routedCompleteJSON(ctx.model || OLLAMA_MODEL,
            'You rewrite a search query for semantic document search. Reply ONLY {"query":"…"} — the same information need rephrased with different words/synonyms, phrased the way a document would state it. Keep names, numbers, and identifiers EXACTLY as given.',
            q0, 60);
          const q1 = j && String(j.query || "").trim();
          if (q1 && q1.toLowerCase() !== q0.toLowerCase()) {
            rephrased = q1;
            const more = (await retrieve(ctx.key, q1, 8)).hits.filter(h => h.score >= 0.4);
            const seen = new Set(hits.map(h => h.path + "|" + h.text.slice(0, 60)));
            for (const h of more) { const key = h.path + "|" + h.text.slice(0, 60); if (!seen.has(key)) { hits.push(h); seen.add(key); } }
            hits.sort((a, b) => b.score - a.score);
            hits = hits.slice(0, 8);
          }
        } catch {}
      }
      // GraphRAG: also pull documents relationally connected to entities named in the query, so
      // "who/where/connected-to" questions surface linked context that chunk-similarity alone misses.
      let folder = null;
      try { if (ctx.key && fs.statSync(ctx.key).isDirectory()) folder = ctx.key; } catch {}
      const gr = graphRetrieve(ctx.user, q0, { folder, cap: 5 });
      const seenKeys = new Set(hits.map(h => (h.path || h.name) + "|" + h.text.slice(0, 60)));
      const graphHits = gr.hits.filter(h => { const k = (h.path || h.name) + "|" + h.text.slice(0, 60); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });

      const sources = [...hits, ...graphHits].map(h => ({ name: h.name, path: h.path, score: h.score }));
      let text;
      if (!hits.length && !graphHits.length) text = "No relevant content found in the documents.";
      else {
        const parts = [];
        if (hits.length) parts.push("Most similar excerpts (verify they concern your exact subject before using):\n\n" +
          hits.map(h => `SOURCE: ${h.name}\n${h.text}`).join("\n\n---\n\n"));
        if (graphHits.length) parts.push(`Related via the knowledge graph — documents connected to ${gr.entities.map(e => e.label).join(", ")}:\n\n` +
          graphHits.map(h => `SOURCE: ${h.name}\n${h.text}`).join("\n\n---\n\n"));
        text = parts.join("\n\n===\n\n");
      }
      const uniq = [...new Set([...hits, ...graphHits].map(h => h.name))];
      const gnote = graphHits.length ? ` +${graphHits.length} via graph (${gr.entities.map(e => e.label).slice(0, 3).join(", ")})` : "";
      return { result: text, sources, summary: (hits.length || graphHits.length) ? `${hits.length} matches in ${uniq.join(", ")}${gnote}${rephrased ? ` (auto-rephrased: "${rephrased.slice(0, 60)}")` : ""}` : `no relevant matches${rephrased ? ` (also tried: "${rephrased.slice(0, 60)}")` : ""}` };
    },
  },
  find_text: {
    def: { type: "function", function: {
      name: "find_text",
      description: "Find an exact literal string (a specific word, name, number, code, or phrase) across the documents. Use when precise wording matters.",
      parameters: { type: "object", properties: { text: { type: "string", description: "the exact text to find" } }, required: ["text"] },
    } },
    run: async (args, ctx) => {
      await ensureIndex(ctx);
      const idx = loadIndex(ctx.key);
      const needle = String(args.text || "").toLowerCase();
      if (!idx || !needle) return { result: "Nothing to search.", summary: "no input" };
      const out = [], hits = [];
      for (const [p, f] of Object.entries(idx.files)) {
        for (const c of f.chunks) {
          const i = c.text.toLowerCase().indexOf(needle);
          if (i >= 0) { out.push(`${f.name}: …${c.text.slice(Math.max(0, i - 80), i + needle.length + 80).replace(/\s+/g, " ").trim()}…`); hits.push({ name: f.name, path: p, score: 1 }); break; }
        }
        if (out.length >= 10) break;
      }
      return { result: out.length ? out.join("\n") : `No exact match for "${args.text}".`, sources: hits, summary: out.length ? `found in ${hits.map(h => h.name).join(", ")}` : "no exact match" };
    },
  },
  list_files: {
    def: { type: "function", function: {
      name: "list_files",
      description: "List the available files — documents AND images/photos — with their type/size/date (and a total count). Optionally filter by filename text or sort by most recent. Use for questions about what files exist, how many, or what's newest (e.g. 'what is this folder about').",
      parameters: { type: "object", properties: { query: { type: "string", description: "filename contains" }, sort: { type: "string", enum: ["name", "recent"] }, limit: { type: "number" } } },
    } },
    run: async (args, ctx) => {
      // Enumerate the ACTUAL files in scope (incl. images/photos), not just the text index — images
      // aren't embedded, so an image folder would otherwise come back empty ("0 documents").
      let paths;
      if (ctx.files) paths = ctx.files;
      else if (ctx.isFile) paths = [ctx.path];
      else { try { paths = await walkFiles(ctx.path); } catch { paths = []; } }
      let files = paths.map(p => ({ path: p, name: path.basename(p), kind: kindOf(path.basename(p)) }));
      if (!files.length) { await ensureIndex(ctx); files = indexedFiles(ctx.key); }   // fallback for odd scopes
      if (args.query) files = files.filter(f => f.name.toLowerCase().includes(String(args.query).toLowerCase()));
      const withT = [];
      for (const f of files) { let st; try { st = await fsp.stat(f.path); withT.push({ ...f, mtime: st.mtimeMs, size: st.size }); } catch { withT.push({ ...f, mtime: 0, size: 0 }); } }
      if (args.sort === "recent") withT.sort((a, b) => b.mtime - a.mtime);
      else withT.sort((a, b) => a.name.localeCompare(b.name));
      const shown = args.limit ? withT.slice(0, args.limit) : withT;
      const lines = shown.map(f => `- ${f.name} (.${extOf(f.name)}, ${fmtSize(f.size)}, ${fmtDate(f.mtime)})${getTags(f.path).length ? " [tags: " + getTags(f.path).join(", ") + "]" : ""}`);
      return { result: `${withT.length} file(s).\n${lines.join("\n")}`, summary: `${withT.length} files` };
    },
  },
  read_file: {
    def: { type: "function", function: {
      name: "read_file",
      description: "Read a document's text by name (PDF, Word, Markdown, CSV, code, text). Provide a `focus` to get only the most relevant sections of a large file instead of the whole thing.",
      parameters: { type: "object", properties: { name: { type: "string" }, focus: { type: "string", description: "optional: only return parts relevant to this" } }, required: ["name"] },
    } },
    run: async (args, ctx) => {
      await ensureIndex(ctx);
      const f = findIndexed(ctx, args.name);
      if (!f) return { result: `No document named "${args.name}".`, summary: "not found" };
      if (args.focus) {
        const idx = loadIndex(ctx.key);
        if (idx && idx.files[f.path]) {
          const [qv] = await embed([args.focus]);
          const ranked = idx.files[f.path].chunks.map(c => ({ text: c.text, score: cosine(qv, c.vec) })).sort((a, b) => b.score - a.score).slice(0, 4);
          return { result: `Relevant sections of ${f.name}:\n\n${ranked.map(r => r.text).join("\n\n---\n\n")}`, sources: [{ name: f.name, path: f.path, score: 1 }], summary: `read sections of ${f.name}` };
        }
      }
      const { text, status } = await extractText(f.path);
      const body = status === "ok" ? (text.length > 12000 ? text.slice(0, 12000) + "\n…[truncated — pass a `focus` to find specific parts]" : text) : `(could not extract text: ${status})`;
      return { result: `FILE: ${f.name}\n\n${body}`, sources: [{ name: f.name, path: f.path, score: 1 }], summary: `read ${f.name}` };
    },
  },
  query_csv: {
    def: { type: "function", function: {
      name: "query_csv",
      description: "Analyze a CSV/TSV file: columns, row count, and stats (sum/avg/min/max) for numeric columns, plus sample rows. Use before answering questions about tabular data or spreadsheet math.",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    } },
    run: async (args, ctx) => {
      await ensureIndex(ctx);
      const f = findIndexed(ctx, args.name);
      if (!f) return { result: `No file named "${args.name}".`, summary: "not found" };
      const raw = (await extractRaw(f.path)).text || "";
      const lines = raw.split(/\r?\n/).filter(l => l.trim());
      if (!lines.length) return { result: "Empty file.", summary: "empty" };
      const delim = (raw.includes("\t") && !lines[0].includes(",")) ? "\t" : ",";
      const split = l => l.split(delim).map(c => c.trim().replace(/^"|"$/g, ""));
      const header = split(lines[0]), rows = lines.slice(1).map(split);
      const stats = header.map((h, ci) => {
        const nums = rows.map(r => parseFloat(r[ci])).filter(n => !isNaN(n));
        if (nums.length >= Math.max(1, rows.length * 0.5)) { const sum = nums.reduce((a, b) => a + b, 0); return `${h}: numeric (sum ${sum}, avg ${(sum / nums.length).toFixed(2)}, min ${Math.min(...nums)}, max ${Math.max(...nums)})`; }
        return `${h}: text`;
      });
      const sample = [header.join(" | "), ...rows.slice(0, 5).map(r => r.join(" | "))].join("\n");
      const render = [];
      if (ctx.chartHint && rows.length >= RENDER_MIN_ROWS) {   // only when the user asked for a visual
        render.push(tableSpec(header, rows));
        const num = numericCol(rows, header), labelIdx = header.findIndex((c, i) => rows.some(r => isNaN(parseFloat(r[i]))));
        if (num && labelIdx >= 0 && labelIdx !== num.idx)
          render.push(...seriesRenders(header[labelIdx], header[num.idx], rows.map(r => String(r[labelIdx])), rows.map(r => parseFloat(r[num.idx]) || 0), ctx.chartHint));
      }
      return { result: `CSV ${f.name}: ${rows.length} rows × ${header.length} cols.\nColumns:\n${stats.join("\n")}\n\nSample:\n${sample}`, sources: [{ name: f.name, path: f.path, score: 1 }], summary: `${rows.length}×${header.length} table`, render };
    },
  },
  compare_files: {
    def: { type: "function", function: {
      name: "compare_files",
      description: "Read two named documents at once so you can compare or contrast them. Returns both files' text.",
      parameters: { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a", "b"] },
    } },
    run: async (args, ctx) => {
      await ensureIndex(ctx);
      const fa = findIndexed(ctx, args.a), fb = findIndexed(ctx, args.b);
      if (!fa || !fb) return { result: `Could not find ${!fa ? `"${args.a}"` : `"${args.b}"`}.`, summary: "not found" };
      const cut = s => (s.length > 6000 ? s.slice(0, 6000) + "\n…[truncated]" : s);
      const ta = (await extractText(fa.path)).text || "", tb = (await extractText(fb.path)).text || "";
      return { result: `FILE A — ${fa.name}\n${cut(ta)}\n\n==========\n\nFILE B — ${fb.name}\n${cut(tb)}`, sources: [{ name: fa.name, path: fa.path, score: 1 }, { name: fb.name, path: fb.path, score: 1 }], summary: `compared ${fa.name} & ${fb.name}` };
    },
  },
  save_note: {
    def: { type: "function", function: {
      name: "save_note",
      description: "Save a note, summary, answer, or generated data into the knowledge base so it's kept and searchable later. Use when the user asks to save, remember, note, jot down, or take notes on something. Defaults to a Markdown note; if `title` ends in .csv/.json/.txt AND `text` is actually in that format, it's saved as a real file of that type (raw, not wrapped in Markdown) so tools like query_csv can use it and it shows with the right file type.",
      parameters: { type: "object", properties: {
        title: { type: "string", description: "The note's title. Give it a .csv/.json/.txt extension ONLY if `text` is genuinely raw data in that format — otherwise leave it as a plain title and it's saved as a Markdown note." },
        text: { type: "string", description: "The content. For a Markdown note: written in full and well-structured — a short intro, ## sections, bullet/numbered lists, the key facts, decisions, names, numbers and their sources, and a closing summary or action items. Be thorough, not a one-liner. For .csv/.json/.txt: the raw file content, nothing else." },
        images: { type: "array", items: { type: "string" }, description: "Filenames of conversation images to embed in the note, or [\"all\"] for every image in the chat. Markdown notes only." },
      }, required: ["title", "text"] },
    } },
    run: async (args, ctx) => {
      const kb = ctx.kbDir;
      const rawTitle = String(args.title || "note");
      const dataExt = (rawTitle.match(/\.(csv|json|txt)$/i) || [])[1];
      const ext = dataExt ? dataExt.toLowerCase() : "md";
      const base = safeName(rawTitle).replace(/\.[a-z0-9]{1,8}$/i, "") || "note";   // strip ANY existing extension — never double it up (was producing "name.csv.md")
      let p = path.join(kb, `${base}.${ext}`), i = 1;
      while (fs.existsSync(p)) { p = path.join(kb, `${base} (${i}).${ext}`); i++; }
      if (ext !== "md") {   // raw data file — no title-wrapping, images don't apply
        await fsp.writeFile(p, args.text || "");
        await buildIndex(kb);
        return { result: `Saved "${path.basename(p)}" to the knowledge base.`, summary: `saved ${path.basename(p)}`, sources: [{ name: path.basename(p), path: p, score: 1 }] };
      }
      // embed conversation images the agent asked for (matched by filename, or "all")
      const avail = ctx.convoImages || [];
      const want = (Array.isArray(args.images) ? args.images : []).map(s => String(s).toLowerCase().trim()).filter(Boolean);
      let chosenImgs = want.includes("all") ? avail
        : avail.filter(im => { const n = (im.name || "").toLowerCase(); return want.some(w => n === w || n.includes(w) || w.includes(n)); });
      if (!chosenImgs.length && ctx.embedConvoImages) chosenImgs = avail;   // request was about the chat/images → include them even if the model didn't ask
      const pick = chosenImgs.map(im => materializeChatImage(kb, im)).filter(Boolean);   // write to KB only now
      const imgMd = pick.length ? "\n\n## Images\n\n" + pick.map(im => `![${im.name}](/api/file?path=${encodeURIComponent(im.path)})`).join("\n\n") + "\n" : "";
      await fsp.writeFile(p, `# ${args.title}\n\n${args.text || ""}\n${imgMd}`);
      await buildIndex(kb);
      return { result: `Saved note "${path.basename(p)}"${pick.length ? ` with ${pick.length} image${pick.length === 1 ? "" : "s"}` : ""} to the knowledge base.`, summary: `saved ${path.basename(p)}`, sources: [{ name: path.basename(p), path: p, score: 1 }] };
    },
  },
  image_tool: {
    def: { type: "function", function: {
      name: "image_tool",
      description: "Work with an image. action 'describe' uses the vision model to SEE and describe what's in the image (use this to answer questions about a photo/screenshot, including reading text in it). action 'exif' returns its date taken, camera, and GPS.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["describe", "exif"] }, name: { type: "string" } }, required: ["action", "name"] },
    } },
    run: async (args, ctx) => {
      const fp = await resolveImageRef(args.name, ctx);
      if (!fp) {
        const attached = (ctx.convoImages || []).map(im => im.name).filter(Boolean);
        return { result: `No image named "${args.name}" found.` + (attached.length ? ` Images attached to this chat: ${attached.join(", ")} — use one of those names.` : " Ask the user to attach an image, or name one from their library."), summary: "not found" };
      }
      if (args.action === "exif") {
        const x = await exifr.parse(fp, { gps: true }).catch(() => null);
        if (!x) return { result: "No EXIF metadata.", summary: "no exif" };
        const camera = [x.Make, x.Model].filter(Boolean).join(" ");
        const taken = x.DateTimeOriginal || x.CreateDate;
        const gps = (typeof x.latitude === "number") ? `${x.latitude}, ${x.longitude}` : "none";
        return { result: `EXIF for ${path.basename(fp)}:\ncamera: ${camera || "?"}\ntaken: ${taken ? new Date(taken).toLocaleString() : "?"}\ngps: ${gps}`, summary: "got EXIF", sources: [{ name: path.basename(fp), path: fp, score: 1 }] };
      }
      try {
        const m = await describeImage(fp, (imageMeta[fp] && imageMeta[fp].context) || "");
        return { result: `Description of ${path.basename(fp)}:\n${m.description}`, sources: [{ name: path.basename(fp), path: fp, score: 1 }], summary: `described ${path.basename(fp)}` };
      } catch (e) { return { result: `Could not analyze image: ${e.message}`, summary: "error" }; }
    },
  },
  generate_image: {
    def: { type: "function", function: {
      name: "generate_image",
      description: "Generate a NEW image from a text prompt using the user's LOCAL Draw Things image model. Use whenever the user asks you to create / generate / draw / make / render an image, illustration, picture, logo, icon, or piece of art from a description. Write a vivid, detailed prompt (subject, style, lighting, composition). The image is saved to the knowledge base and shown inline — do NOT describe it in words instead of calling this.",
      parameters: { type: "object", properties: {
        prompt: { type: "string", description: "Detailed description of the image to generate." },
        negative_prompt: { type: "string", description: "What to avoid in the image (optional)." },
        width: { type: "integer", description: "Pixel width, multiple of 64 (default from the user's settings)." },
        height: { type: "integer", description: "Pixel height, multiple of 64 (default from the user's settings)." },
        model: { type: "string", description: "Optional model filename override (otherwise the user's default / first installed model)." },
      }, required: ["prompt"] },
    } },
    run: async (args, ctx) => {
      const cfg = dtSettings(ctx);
      const d = ctx.imageDefaults || {};   // steps / guidance come from the user's Settings, not the model
      try {
        const model = await dtPickModel(cfg, args.model);
        const { images } = await dtGenerate({ url: cfg.url, sharedSecret: cfg.sharedSecret, model,
          prompt: args.prompt, negativePrompt: args.negative_prompt,
          width: args.width || d.width || 512, height: args.height || d.height || 512,
          steps: d.steps || 4, guidanceScale: d.guidance != null ? d.guidance : 1.5 });
        const paths = [];
        for (const im of images) paths.push(await dtSaveImage(ctx, im.png, args.prompt));
        return { result: `Generated ${paths.length} image${paths.length === 1 ? "" : "s"} with ${model} (saved to the knowledge base under generated/). Showing ${paths.length === 1 ? "it" : "them"} below.`,
          render: dtImageRender(paths, "Generated image"), sources: paths.map(p => ({ name: path.basename(p), path: p, score: 1 })), summary: `generated ${paths.length} image(s)` };
      } catch (e) { return { result: `Image generation failed: ${e.message}`, summary: "error" }; }
    },
  },
  edit_image: {
    def: { type: "function", function: {
      name: "edit_image",
      description: "Edit / transform an EXISTING image (image-to-image) with the user's local Draw Things model — restyle, alter, or reimagine a photo the user attached to this chat or has in their library. The source image is loaded as the base and regenerated with your change applied. Provide the image's name and a prompt describing the desired result.",
      parameters: { type: "object", properties: {
        name: { type: "string", description: "Name of the image to edit — an attached/pasted image, a library photo, or a file path." },
        prompt: { type: "string", description: "Describe the edited result you want." },
        negative_prompt: { type: "string", description: "What to avoid (optional)." },
        model: { type: "string", description: "Optional model filename override." },
      }, required: ["name", "prompt"] },
    } },
    run: async (args, ctx) => {
      const cfg = dtSettings(ctx);
      const d = ctx.imageDefaults || {};   // strength / steps / guidance come from the user's Settings, not the model
      try {
        const fp = await resolveImageRef(args.name, ctx);
        if (!fp) {
          const attached = (ctx.convoImages || []).map(im => im.name).filter(Boolean);
          return { result: `No image named "${args.name}" found to edit.` + (attached.length ? ` Images attached to this chat: ${attached.join(", ")}.` : " Ask the user to attach one, or name a library photo."), summary: "not found" };
        }
        const model = await dtPickModel(cfg, args.model);
        const imageBuffer = await fsp.readFile(fp);
        const { images } = await dtEdit({ url: cfg.url, sharedSecret: cfg.sharedSecret, model,
          prompt: args.prompt, negativePrompt: args.negative_prompt, imageBuffer,
          strength: d.strength != null ? d.strength : 0.99, steps: d.steps || 4,
          guidanceScale: d.guidance != null ? d.guidance : 1.5, maxDim: d.maxDim != null ? d.maxDim : 1024 });
        const paths = [];
        for (const im of images) paths.push(await dtSaveImage(ctx, im.png, args.prompt || ("edit of " + path.basename(fp))));
        return { result: `Edited ${path.basename(fp)} into ${paths.length} new image${paths.length === 1 ? "" : "s"} (saved under generated/). Showing below.`,
          render: dtImageRender(paths, "Edited image"),
          sources: [{ name: path.basename(fp), path: fp, score: 1 }, ...paths.map(p => ({ name: path.basename(p), path: p, score: 1 }))], summary: "edited image" };
      } catch (e) { return { result: `Image edit failed: ${e.message}`, summary: "error" }; }
    },
  },
  list_connectors: {
    def: { type: "function", function: {
      name: "list_connectors",
      description: "List the available external connectors (MCP servers) and the tools each provides. Use FIRST to discover what external or live data/actions you can access before calling use_connector.",
      parameters: { type: "object", properties: {} },
    } },
    run: async (_args, ctx) => {
      const enabled = mcpEnabled(ctx.user);
      if (!enabled.length) return { result: "No connectors are enabled.", summary: "0 connectors" };
      const parts = [];
      for (const s of enabled) {
        try { const tools = await mcpListTools(ctx.user, s); parts.push(`Connector "${s.name}" provides:\n` + tools.map(t => `  - ${t.name}: ${t.description}`).join("\n")); }
        catch (e) { parts.push(`Connector "${s.name}": offline (${e.message})`); }
      }
      return { result: parts.join("\n\n"), summary: `${enabled.length} connector(s)` };
    },
  },
  use_connector: {
    def: { type: "function", function: {
      name: "use_connector",
      description: "Call a tool on an external connector (MCP server). Use list_connectors first to find the connector name and tool name and its arguments.",
      parameters: { type: "object", properties: { server: { type: "string", description: "connector name" }, tool: { type: "string" }, args: { type: "object", description: "arguments for the tool" } }, required: ["server", "tool"] },
    } },
    run: async (args, ctx) => {
      const s = mcpEnabled(ctx.user).find(x => x.name.toLowerCase() === String(args.server || "").toLowerCase() || x.id === args.server);
      if (!s) return { result: `No enabled connector named "${args.server}".`, summary: "not found" };
      try {
        const out = String(await mcpCallTool(ctx.user, s, args.tool, args.args || {}));
        const LIMIT = 60000;   // connector results (datasets) can be large; keep generous, num_ctx bounds the rest
        const body = out.length > LIMIT ? out.slice(0, LIMIT) + "\n…[truncated — ask for a narrower query]" : out;
        // if the result has structured records (possibly nested / prose-wrapped), offer a table/chart
        let render = [];
        const parsed = parseRecords(out);
        if (parsed != null) render = rendersFromObjects(parsed, `${args.tool}`, ctx && ctx.chartHint);
        const recs = parsed != null ? findRecords(parsed) : null;
        const cols = Array.isArray(recs) && recs[0] && typeof recs[0] === "object" ? Object.keys(recs[0]).join(",") : "(no flat records)";
        console.log(`[use_connector] ${s.name}/${args.tool} outLen=${out.length} parsed=${parsed != null} recs=${Array.isArray(recs) ? recs.length : 0} cols=[${cols}] hint=${(ctx && ctx.chartHint) || "none"} renders=${render.length}`);
        if (parsed == null) console.log(`[use_connector] non-JSON head: ${out.slice(0, 200).replace(/\s+/g, " ")}`);
        return { result: `[${s.name} · ${args.tool}]\n${body}`, summary: `called ${s.name}/${args.tool}`, render };
      }
      catch (e) { return { result: `Connector error: ${e.message}`, summary: "error" }; }
    },
  },
  remember: {
    def: { type: "function", function: {
      name: "remember",
      description: "Save a durable fact or preference about the user to long-term memory. Use when the user says to remember something, or shares a lasting preference/fact (name, role, projects, how they like answers). Set kind: 'preference' (how they like answers), 'instruction' (a standing rule to always follow), or 'fact' (a durable fact about them).",
      parameters: { type: "object", properties: { text: { type: "string" }, kind: { type: "string", enum: ["preference", "instruction", "fact"] } }, required: ["text"] },
    } },
    run: async (args, ctx) => {
      const t = String(args.text || "").trim();
      if (!t) return { result: "Nothing to remember.", summary: "empty" };
      await addMemory(ctx.user, t, "auto", args.kind, ctx.sessionId ? { sessionId: ctx.sessionId } : null);
      return { result: `Saved to memory: "${t}"`, summary: "remembered" };
    },
  },
  save_skill: {
    def: { type: "function", function: {
      name: "save_skill",
      description: "Save a reusable HOW-TO procedure to long-term skill memory so you can re-apply it later instead of re-deriving it. Use ONLY after you've worked out a repeatable, multi-step way to do something the user is likely to ask for again (e.g. how to reconcile their bank statements from PDFs, how to format their weekly report). Do NOT save one-off answers, facts about the user (use remember), or trivial single steps. Write `steps` as a clear numbered Markdown how-to, and `trigger` as one line describing when this skill applies.",
      parameters: { type: "object", properties: {
        title: { type: "string", description: "short name for the procedure" },
        steps: { type: "string", description: "the how-to as a numbered Markdown list — concrete, repeatable steps" },
        trigger: { type: "string", description: "one line: when to use this skill (the situation it applies to)" },
        tags: { type: "array", items: { type: "string" }, description: "optional keywords" },
      }, required: ["title", "steps", "trigger"] },
    } },
    run: async (args, ctx) => {
      const sk = await addSkill(ctx.user, { title: args.title, steps: args.steps, trigger: args.trigger, tags: args.tags, source: "auto" });
      if (!sk) return { result: "A skill needs at least a title and steps.", summary: "skipped" };
      return { result: `Saved skill "${sk.title}". You'll be able to recall it when "${sk.trigger}".`, summary: `saved skill: ${sk.title}` };
    },
  },
  recall_skill: {
    def: { type: "function", function: {
      name: "recall_skill",
      description: "Look up a saved how-to skill by what you need to do, and get back its full step-by-step instructions. Use this to expand a skill listed in your 'Learned skills' before applying it, or to check whether you already know how to do something the user asked for.",
      parameters: { type: "object", properties: { query: { type: "string", description: "what you're trying to do" } }, required: ["query"] },
    } },
    run: async (args, ctx) => {
      const q = String(args.query || "").trim();
      if (!q) return { result: "What procedure are you looking for?", summary: "empty" };
      const matches = await findSkills(ctx.user, q);
      if (!matches.length) return { result: `No saved skill matches "${q}". Work it out from scratch, then call save_skill if it's reusable.`, summary: "no skill" };
      matches.forEach(s => markSkillUsed(ctx.user, s.id));
      const body = matches.map(s => `## ${s.title}\n_Use when ${s.trigger}_\n\n${s.steps}`).join("\n\n---\n\n");
      return { result: body, summary: `recalled ${matches.length} skill${matches.length === 1 ? "" : "s"}` };
    },
  },
  ask_user: {
    def: { type: "function", function: {
      name: "ask_user",
      description: "Ask the user ONE short clarifying question when their request is ambiguous and acting on a guess could do the wrong thing (several files match, unclear target, missing required detail). This ends your turn — the user's reply comes back as the next message. Use sparingly; never use it when you can find the answer with your other tools.",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
    } },
    run: async (args) => {
      const q = String(args.question || "").trim();
      if (!q) return { result: "No question given — proceed with your best judgment.", summary: "empty" };
      return { result: "Question sent to the user.", summary: "asked for clarification", askUser: q };
    },
  },
  find_related: {
    def: { type: "function", function: {
      name: "find_related",
      description: "Find files similar/related to a given file (semantic for documents, visual for images).",
      parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    } },
    run: async (args, ctx) => {
      await ensureIndex(ctx);
      const f = findIndexed(ctx, args.name);
      if (!f) return { result: `No document named "${args.name}".`, summary: "not found" };
      const rel = await relatedFor(f.path, ctx.kbDir);
      return { result: rel.length ? `Related to ${f.name}:\n` + rel.map(r => `- ${r.name} (${r.score})`).join("\n") : "No related files found.", sources: rel.map(r => ({ name: r.name, path: r.path, score: r.score })), summary: `${rel.length} related` };
    },
  },
  find_photos_of: {
    def: { type: "function", function: {
      name: "find_photos_of",
      description: "Show the user's own photos of a specific person they have labeled in People albums (local face recognition). ALWAYS use this when the user asks to see/show/find photos or pictures of a person by name — e.g. 'show me Taylor Swift', 'photos of Sarah', 'pics of mom'. It displays the matching images inline. Set describe=true to ALSO analyze a representative photo with the vision model and report what the person actually looks like — use this when the user asks how someone looks, their appearance, what they're wearing, etc.",
      parameters: { type: "object", properties: { name: { type: "string", description: "the person's name" }, describe: { type: "boolean", description: "also describe what the person looks like (vision)" } }, required: ["name"] },
    } },
    run: async (args, ctx) => {
      const want = String(args.name || "").trim().toLowerCase();
      if (!want) return { result: "No name given.", summary: "no name" };
      const people = storesFor(ctx.user).people;
      const entries = Object.entries(people);
      const matchEntries = entries.filter(([, p]) => p.name && (p.name.toLowerCase() === want || p.name.toLowerCase().includes(want) || want.includes(p.name.toLowerCase())));
      if (!matchEntries.length) {
        const names = entries.map(([, p]) => p.name).filter(Boolean);
        return { result: `No one named "${args.name}" has been labeled yet.` + (names.length ? ` Labeled people: ${names.join(", ")}.` : " Open a folder → People to scan faces and name them first."), summary: "unknown person" };
      }
      const matchIds = new Set(matchEntries.map(([id]) => id));
      const personName = matchEntries[0][1].name;
      const SIM = 0.5;   // strict: confident same-person distance for the 128-d descriptor
      // every named person's reference faces — so a face is attributed to its NEAREST person, not just "close enough"
      const refs = entries.map(([id, p]) => ({ id, descs: personDescs(p).filter(d => d && d.length === 128) }));
      const hits = [];
      for (const [p, c] of Object.entries(faceStore)) {
        if (!c || !c.faces || !canAccessPath(ctx.user, p)) continue;
        let hit = false;
        for (const f of c.faces) {
          if ((f.descriptor || []).length !== 128) continue;
          if (f.personId) { if (matchIds.has(f.personId)) { hit = true; break; } continue; }   // assigned → only its own person; never leaks
          // unassigned → attribute to the closest named person, and only count it if that's a target (within SIM)
          let bestId = null, bestD = Infinity;
          for (const r of refs) for (const d of r.descs) { const dist = faceDist(f.descriptor, d); if (dist < bestD) { bestD = dist; bestId = r.id; } }
          if (bestD < SIM && matchIds.has(bestId)) { hit = true; break; }
        }
        if (hit) hits.push(p);
      }
      if (!hits.length) return { result: `No photos found containing ${personName}.`, summary: "0 photos" };
      const sources = hits.slice(0, 80).map(p => ({ name: path.basename(p), path: p, score: 1 }));
      // inline image grid so the user actually SEES the photos
      const render = [{ type: "images", title: `Photos of ${personName}`, items: hits.slice(0, 40).map(p => ({
        thumb: "/api/thumb?path=" + encodeURIComponent(p) + "&w=320",
        image: "/api/file?path=" + encodeURIComponent(p),
        url: "/api/file?path=" + encodeURIComponent(p),
        title: path.basename(p),
      })) }];
      // appearance question → actually LOOK at up to N of their photos (vision) and report what it sees
      let appearance = "";
      if (args.describe) {
        const n = Math.max(1, Math.min(ctx.describePhotos || 5, 10));
        // pick up to n: the representative face first, then an even spread across the rest for variety
        const repPath = matchEntries[0][1].rep && hits.includes(matchEntries[0][1].rep.path) ? matchEntries[0][1].rep.path : null;
        const pick = repPath ? [repPath] : [];
        const rest = hits.filter(p => p !== repPath);
        const step = Math.max(1, Math.floor(rest.length / Math.max(1, n - pick.length)));
        for (let i = 0; i < rest.length && pick.length < n; i += step) pick.push(rest[i]);
        for (const p of rest) { if (pick.length >= n) break; if (!pick.includes(p)) pick.push(p); }
        const descs = [];
        for (const p of pick.slice(0, n)) {
          try { const m = await describeImage(p, ""); if (m && m.description) descs.push(`• ${path.basename(p)}: ${m.description}`); } catch {}
        }
        if (descs.length) appearance = `\n\nVISION ANALYSIS of ${descs.length} photo(s) of ${personName} — synthesize these into a description of how they look:\n${descs.join("\n")}`;
      }
      return { result: `Found ${hits.length} photo(s) of ${personName}. Showing them below.${appearance}`, sources, render, summary: `${hits.length} photos of ${personName}` };
    },
  },
  create_instagram_post: {
    def: { type: "function", function: {
      name: "create_instagram_post",
      description: "Compose a ready-to-publish Instagram post from one OR several photos (a multi-photo post renders as a swipeable carousel, like a real IG carousel) and show it as a polished preview card with caption options, hashtag chips, and alt text. Use this whenever the user asks to create/make/draft an Instagram (or IG) post, caption, carousel, or social post. Photos can be ones the user ATTACHED OR PASTED into this chat, ones in their library, or file paths they gave you — not just indexed documents. YOU write the creative copy: look at the photo(s) first (image_tool describe, or find_photos_of describe for a person) so the caption fits what's actually in them, then call this tool. Provide 2-3 distinct caption options (one shared caption set for the whole post), relevant hashtags, and one concise alt text PER photo.",
      parameters: { type: "object", properties: {
        photos: { type: "array", items: { type: "string" }, description: "The photo(s) to feature, in order (1-10 for a carousel). Each item is a chat-attached/pasted image's filename, a library filename, or a file path. If the user attached photos and didn't single one out, pass all of them. May be omitted when exactly one photo is attached." },
        photo: { type: "string", description: "Single-photo shortcut (use `photos` for more than one). Optional — leave blank or say 'attached' to use the most recent attached image." },
        captions: { type: "array", items: { type: "string" }, description: "2-3 caption options for the post in different tones/styles (include emoji where natural); each ready to post as-is" },
        hashtags: { type: "array", items: { type: "string" }, description: "relevant hashtags; the '#' is optional and added automatically" },
        alts: { type: "array", items: { type: "string" }, description: "accessibility alt text, ONE per photo in the same order as `photos`" },
        alt: { type: "string", description: "alt text when there is a single photo (use `alts` for a carousel)" },
      }, required: ["captions"] },
    } },
    run: async (args, ctx) => {
      // Local models often pass array args as a string ("a.jpg, b.jpg" or a JSON-ish string) instead of
      // a real array — coerce so a multi-photo request doesn't silently collapse to one photo.
      const toList = (v) => {
        if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
        if (v == null) return [];
        const s = String(v).trim();
        if (!s) return [];
        if (s[0] === "[") { try { const a = JSON.parse(s); if (Array.isArray(a)) return a.map(x => String(x).trim()).filter(Boolean); } catch {} }
        return s.split(/\s*[\n,;|]\s*/).map(x => x.replace(/^["'\[\]\s]+|["'\[\]\s]+$/g, "")).filter(Boolean);
      };
      // accept photos[] (carousel), a single photo, or nothing → ALL attached images (so "make a carousel"
      // works even when the model forgets to list them); dedupe + cap at 10 happens below.
      let refs = toList(args.photos);
      if (!refs.length && args.photo != null) refs = toList(args.photo);
      if (!refs.length) {
        const attachedNames = (ctx.convoImages || []).map(im => im.name).filter(Boolean);
        refs = attachedNames.length ? attachedNames : [undefined];   // undefined → resolveImageRef picks the most recent attachment
      }
      const altList = toList(args.alts).length ? toList(args.alts) : (args.alt != null ? [String(args.alt)] : []);
      const items = [], seen = new Set(), missed = [];
      for (let i = 0; i < refs.length && items.length < 10; i++) {
        const fp = await resolveImageRef(refs[i], ctx);
        if (!fp || !isImageFile(fp)) { if (refs[i]) missed.push(String(refs[i])); continue; }
        if (seen.has(fp)) continue;            // same photo named twice → keep one
        seen.add(fp);
        items.push({
          thumb: "/api/thumb?path=" + encodeURIComponent(fp) + "&w=640",
          image: "/api/file?path=" + encodeURIComponent(fp),
          alt: String(altList[i] || "").trim(),
          path: fp, name: path.basename(fp),
        });
      }
      if (!items.length) {
        const attached = (ctx.convoImages || []).map(im => im.name).filter(Boolean);
        return { result: (missed.length ? `Couldn't find ${missed.length === 1 ? `a photo matching "${missed[0]}"` : `photos matching: ${missed.join(", ")}`}. ` : "No photo to use. ") + (attached.length ? `Attached in this chat: ${attached.join(", ")} — pass those names (or omit photos to use the most recent).` : "Ask the user to attach/paste a photo, or name one from their library (find_photos_of / list_files)."), summary: "photo not found" };
      }
      const captions = (Array.isArray(args.captions) ? args.captions : [args.captions]).map(c => String(c || "").trim()).filter(Boolean).slice(0, 3);
      if (!captions.length) return { result: "No caption text was provided — write at least one caption option.", summary: "no caption" };
      const hashtags = (Array.isArray(args.hashtags) ? args.hashtags : []).map(h => "#" + String(h || "").trim().replace(/^#+/, "")).filter(h => h.length > 1).slice(0, 30);
      const render = [{
        type: "instagram",
        title: items.length > 1 ? `Instagram carousel · ${items.length} photos` : `Instagram post · ${items[0].name}`,
        images: items.map(it => ({ thumb: it.thumb, image: it.image, alt: it.alt })),
        // single-photo fields kept for backward compatibility with older saved cards
        thumb: items[0].thumb, image: items[0].image, alt: items[0].alt,
        captions, hashtags,
      }];
      const sources = items.map(it => ({ name: it.name, path: it.path, score: 1 }));
      const noted = missed.length ? ` (couldn't find: ${missed.join(", ")})` : "";
      return { result: `Created an Instagram ${items.length > 1 ? `carousel with ${items.length} photos` : `post for ${items[0].name}`}${noted}, ${captions.length} caption option(s)${hashtags.length ? ` and ${hashtags.length} hashtag(s)` : ""}. The preview is shown below — tell the user they can swipe the photos, copy any caption, or ask for tweaks.`, summary: items.length > 1 ? `made IG carousel (${items.length})` : "made IG post", sources, render };
    },
  },
  knowledge_graph: {
    def: { type: "function", function: {
      name: "knowledge_graph",
      description: "Summarize everything the user's files connect to a given entity — a person, place, topic, or organization — using their personal knowledge graph. Returns ACTUAL TEXT EXCERPTS from the connected documents (so you can say what they contain, not just how often the entity appears), plus the photos and the people/places/topics it co-occurs with. Use when the user asks 'what do I know about X', 'tell me/summarize what we have on X', or how things/people are connected. Synthesize from the excerpts into a grounded answer that cites the documents.",
      parameters: { type: "object", properties: { name: { type: "string", description: "the entity to look up (person, place, topic, or organization)" } }, required: ["name"] },
    } },
    run: async (args, ctx) => {
      const want = String(args.name || "").trim().toLowerCase();
      if (!want) return { result: "No entity name given.", summary: "no name" };
      let g = graphFor(ctx.user, false);
      if (!g.nodes.length) return { result: `Nothing in the user's own files or photos is linked to "${args.name}" yet (their knowledge graph has no entries). Do NOT stop here and do NOT lecture them about populating the graph: answer their question from your OWN general knowledge, and you may briefly note you didn't find anything in their files.`, summary: "empty graph" };
      const findMatches = gr => gr.nodes.filter(n => n.label.toLowerCase() === want)
        .concat(gr.nodes.filter(n => n.label.toLowerCase() !== want && n.label.toLowerCase().includes(want)));
      let matches = findMatches(g);
      // if nothing matched and online place lookup is enabled, name un-named place clusters and retry —
      // lets "what do I know about Bengaluru" resolve even before the user clicked "Name places".
      if (!matches.length && ctx.placeLookup) {
        const unnamed = g.nodes.filter(n => n.kind === "place" && !placeNames[n.id.slice(6)]).slice(0, 16);
        let done = 0;
        for (const n of unnamed) { const key = n.id.slice(6); const [lat, lng] = key.split(",").map(Number); try { const nm = await reverseGeocode(lat, lng); if (nm) { placeNames[key] = nm; done++; } } catch {} }
        if (done) { persistPlaceNames(); graphCache.delete(ctx.user.id); g = graphFor(ctx.user, true); matches = findMatches(g); }
      }
      if (!matches.length) {
        const top = [...g.nodes].sort((a, b) => b.weight - a.weight).slice(0, 12).map(n => n.label);
        return { result: `Nothing in the user's own files is linked to "${args.name}". Answer their question from your OWN general knowledge instead; you may briefly note it isn't in their files. (Entities their files DO mention: ${top.join(", ")}.)`, summary: "not found" };
      }
      const n = matches.sort((a, b) => b.weight - a.weight)[0];
      // neighbors by shared connections, grouped by kind
      const nb = {};
      for (const e of g.edges) { const other = e.a === n.id ? e.b : e.b === n.id ? e.a : null; if (other) nb[other] = (nb[other] || 0) + e.w; }
      const byId = Object.fromEntries(g.nodes.map(x => [x.id, x]));
      const ranked = Object.entries(nb).sort((a, b) => b[1] - a[1]).map(([id, w]) => ({ ...byId[id], w })).filter(x => x.label);
      const groupLine = kind => { const items = ranked.filter(x => x.kind === kind).slice(0, 8); return items.length ? items.map(x => `${x.label} (${x.w})`).join(", ") : null; };
      const kindLabel = { person: "person", place: "place", topic: "topic", org: "organization", term: "term" }[n.kind] || n.kind;
      const photos = [...n.photos].filter(p => { try { return fs.existsSync(p); } catch { return false; } });
      const docs = [...n.docs].filter(p => { try { return fs.existsSync(p); } catch { return false; } });
      const lines = [`Knowledge graph for "${n.label}" (${kindLabel}) — appears in ${photos.length} photo(s) and ${docs.length} document(s).`];
      for (const [k, head] of [["person", "Connected people"], ["place", "Connected places"], ["topic", "Connected topics"], ["org", "Connected organizations"], ["term", "Also mentioned with"]]) {
        const l = groupLine(k); if (l) lines.push(`${head}: ${l}.`);
      }
      if (docs.length) lines.push(`Documents: ${docs.slice(0, 20).map(p => path.basename(p)).join(", ")}.`);
      // read actual text from the connected documents so the answer is grounded in CONTENT, not just counts.
      const term = n.kind === "place" ? n.label.split(",")[0].trim() : n.label;
      let excerpts = docExcerptsFor(ctx.user, n.docs, term, 6);
      if (!excerpts.length && n.docs.size) excerpts = docExcerptsFor(ctx.user, n.docs, null, 4);   // fallback: any text from those docs
      if (excerpts.length) lines.push(`\nExcerpts from those documents:\n${excerpts.map(e => `• [${e.name}] ${e.text}`).join("\n")}`);
      const sources = docs.slice(0, 40).map(p => ({ name: path.basename(p), path: p, score: 1 }))
        .concat(photos.slice(0, 20).map(p => ({ name: path.basename(p), path: p, score: 1 })));
      const render = photos.length ? [{ type: "images", title: `Photos linked to ${n.label}`, items: photos.slice(0, 24).map(p => ({
        thumb: "/api/thumb?path=" + encodeURIComponent(p) + "&w=320",
        image: "/api/file?path=" + encodeURIComponent(p),
        url: "/api/file?path=" + encodeURIComponent(p),
        title: path.basename(p),
      })) }] : undefined;
      return { result: lines.join("\n") + "\n\nUsing the EXCERPTS above (not just the counts), write a short, grounded summary of what the user actually knows about this entity — what the documents say about it and how it connects to people/places/topics. Cite documents by name. If the excerpts are thin, say so.", sources, render, summary: `graph: ${n.label}` };
    },
  },
  manage_file: {
    def: { type: "function", function: {
      name: "manage_file",
      description: "Perform a file action ONLY when the user explicitly asks: open (show in viewer), rename, delete, tag, or EDIT a text file (append text, overwrite it, or find-and-replace).",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["open", "rename", "delete", "tag", "append", "overwrite", "replace"] },
        name: { type: "string" },
        new_name: { type: "string", description: "for rename" },
        tags: { type: "array", items: { type: "string" }, description: "for tag" },
        text: { type: "string", description: "for append / overwrite" },
        find: { type: "string", description: "for replace: text to find" },
        replace: { type: "string", description: "for replace: text to substitute" },
      }, required: ["action", "name"] },
    } },
    run: async (args, ctx) => {
      await ensureIndex(ctx);
      const f = findIndexed(ctx, args.name);
      if (!f) return { result: `No document named "${args.name}".`, summary: "not found" };
      // destructive actions never execute on the agent's say-so alone: surface an Approve/Cancel
      // card in chat and end the turn. /api/agent/approve re-runs this with ctx.approved set.
      if (["delete", "overwrite", "rename"].includes(args.action) && !ctx.approved) {
        return {
          result: "This action needs the user's explicit approval — a confirmation card was shown. Stop and wait for their decision; do not retry.",
          summary: "awaiting your approval",
          pendingAction: { action: args.action, name: f.name, path: f.path, new_name: args.new_name || undefined, text: args.text || undefined },
        };
      }
      const reindex = async () => { await buildIndex(ctx.key); if (f.path.startsWith(ctx.kbDir + path.sep) || ctx.key !== ctx.kbDir) { try { await buildIndex(ctx.kbDir); } catch {} } };
      if (["append", "overwrite", "replace"].includes(args.action)) {
        if (!TEXTLIKE.has(extOf(f.name))) return { result: `Can only edit text files; "${f.name}" can't be edited as text.`, summary: "not editable" };
        let content = await fsp.readFile(f.path, "utf8").catch(() => "");
        if (args.action === "append") content = content + (content.endsWith("\n") || !content ? "" : "\n") + (args.text || "");
        else if (args.action === "overwrite") content = args.text || "";
        else { if (!args.find) return { result: "`find` is required for replace.", summary: "missing find" }; content = content.split(args.find).join(args.replace || ""); }
        await fsp.writeFile(f.path, content);
        await reindex();
        return { result: `Updated ${f.name} (${args.action}).`, summary: `edited ${f.name}`, sources: [{ name: f.name, path: f.path, score: 1 }] };
      }
      if (args.action === "open")
        return { result: `Opened ${f.name} in the viewer.`, summary: `opened ${f.name}`, action: { type: "open_file", name: f.name, path: f.path } };
      if (args.action === "tag") {
        const clean = setTags(f.path, Array.isArray(args.tags) ? args.tags : String(args.tags || "").split(","));
        await reindex();
        return { result: `Tagged ${f.name}: ${clean.join(", ") || "(cleared)"}.`, summary: `tagged ${f.name}`, sources: [{ name: f.name, path: f.path, score: 1 }] };
      }
      if (args.action === "rename") {
        const target = path.join(path.dirname(f.path), safeName(args.new_name || ""));
        if (!args.new_name) return { result: "new_name is required to rename.", summary: "missing name" };
        if (fs.existsSync(target)) return { result: `"${path.basename(target)}" already exists.`, summary: "exists" };
        await fsp.rename(f.path, target);
        if (tagStore[f.path]) { tagStore[target] = tagStore[f.path]; delete tagStore[f.path]; persistTags(); }
        if (imageMeta[f.path]) { imageMeta[target] = imageMeta[f.path]; delete imageMeta[f.path]; persistImageMeta(); }
        await reindex();
        return { result: `Renamed "${f.name}" to "${path.basename(target)}".`, summary: `renamed → ${path.basename(target)}` };
      }
      if (args.action === "delete") {
        await fsp.rm(f.path, { force: true });
        delete tagStore[f.path]; delete imageMeta[f.path]; persistTags(); persistImageMeta();
        await reindex();
        return { result: `Deleted "${f.name}".`, summary: `deleted ${f.name}` };
      }
      return { result: `Unknown action "${args.action}".`, summary: "unknown action" };
    },
  },
};
const ALIASES = { search_kb: "search_docs" };
const MCP_META_TOOLS = new Set(["list_connectors", "use_connector"]);
const WEB_TOOLS = new Set(["web_search"]);   // web SEARCH needs the Web toggle; read_url is gated separately below
const IMAGE_TOOLS = new Set(["generate_image", "edit_image"]);   // only offered when image generation is enabled in Settings
const MEMORY_TOOLS = new Set(["remember", "save_skill", "recall_skill"]);   // gated off when memory is disabled
// tools a headless/scheduled run must NOT get: destructive file edits + interactive prompts (no human to approve/answer)
const HEADLESS_BLOCKED = new Set(["manage_file", "ask_user"]);
// tools that read/write the user's own files — gated off for "pure persona" custom agents (files capability)
const FILE_TOOLS = new Set(["search_docs", "find_text", "list_files", "read_file", "query_csv", "compare_files", "save_note", "image_tool", "find_related", "find_photos_of", "knowledge_graph", "manage_file", "extract_table", "create_instagram_post"]);
// tools that read external/own data — running one means the answer had a chance to be grounded
const RETRIEVAL_TOOLS = new Set(["search_docs", "find_text", "read_file", "read_section", "query_csv", "compare_files", "find_related", "find_photos_of", "knowledge_graph", "image_tool", "use_connector", "web_search", "read_url"]);
// connector meta-tools are only offered to the agent when at least one connector is enabled.
// opts.files / opts.memory / opts.connectors default ON; a custom agent can switch each off.
function agentToolDefs(opts = {}) {
  const hasMcp = mcpEnabled(opts.user).length > 0;
  const files = opts.files !== false, memory = opts.memory !== false, connectors = opts.connectors !== false;
  return Object.entries(TOOL_REGISTRY)
    .filter(([name]) => {
      if (WEB_TOOLS.has(name) && !opts.web) return false;
      // read_url is a plain page fetch — offer it whenever web search is on OR the user pasted a link,
      // so "read this URL" works even with the Web toggle off.
      if (name === "read_url" && !opts.web && !opts.urls) return false;
      if (IMAGE_TOOLS.has(name) && !opts.imageGen) return false;
      if (MCP_META_TOOLS.has(name) && (!hasMcp || !connectors)) return false;
      if (FILE_TOOLS.has(name) && !files) return false;
      if (MEMORY_TOOLS.has(name) && !memory) return false;
      if (HEADLESS_BLOCKED.has(name) && opts.headless) return false;   // scheduled runs: no destructive/interactive tools
      return true;
    })
    .map(([, t]) => t.def);
}

// Operational tool-use rules (charts, diagrams, memory, connectors, web). Always appended so tools
// keep working — even for a custom agent whose persona fully replaces the default grounding text.
function agentToolMechanics({ autoMem = true, web = false, memory = true, connectors = true, imageGen = false, user = null } = {}) {
  return "VISUALS: when the user asks to plot, chart, graph, visualize, or tabulate data, you MUST call the make_chart tool with the data points (you choose the type, labels, and values from their request). " +
    "Never draw a chart as ASCII art, emoji bars, or a Markdown table, and never just describe a chart in words. " +
    "If you don't yet have the numbers, fetch them first, then call make_chart, then add a one- or two-sentence summary. " +
    "You may include Mermaid diagrams in a ```mermaid fenced code block (for flowcharts, sequences, timelines, org charts) and LaTeX math ($$…$$ for display, \\(…\\) for inline) — they render as real diagrams and equations. " +
    "For Mermaid, keep it SIMPLE and valid: prefer `flowchart TD` or `sequenceDiagram`; put node text in double quotes if it has spaces/punctuation (e.g. A[\"User logs in\"]); avoid commas/parentheses/special characters in labels and don't use experimental diagram types. Only include a diagram when it genuinely helps." +
    (memory ? (autoMem
      ? "\nUse the `remember` tool ONLY for durable facts or preferences about the USER themselves — their name, role, ongoing projects, or how they like answers. " +
        "Do NOT remember task details, file contents, one-off requests, general knowledge, or anything trivial or temporary. When unsure, don't remember."
      : "\nUse the `remember` tool only when the user explicitly asks you to remember something; do not save anything to memory on your own.") : "") +
    (connectors && mcpEnabled(user).length ? "\nFor external or live data/actions beyond the user's files, you have connectors: call list_connectors to see them, then use_connector to run one." : "") +
    (imageGen ? "\nIMAGE CREATION: when the user asks you to create, generate, draw, make, or render an image/illustration/picture/logo/art from a description, call generate_image with a vivid, detailed prompt — never reply that you can't make images. To restyle or transform an existing photo (one they attached or have in their library), call edit_image with its name. The result is shown inline." : "") +
    (web
      ? "\nFor current events or information not in the user's files, use web_search (type 'images' to fetch pictures to display), then read_url to read a promising result in full; cite the result URLs. If a web_search or read_url returns an error or says it was rate-limited/blocked/timed out, TELL the user it failed and why and suggest trying again — do NOT pretend you searched or silently fall back to memory."
      : "\nWeb search is currently OFF for this chat. If the user asks you to search the web or for current events/news, tell them to turn on the Web toggle in the chat composer (or enable Web search in Settings) — do NOT claim you have no ability to search, and do NOT pretend to have searched.");
}

function agentSys(domainLabel, autoMem = true, web = false, deep = false, user = null, memBlock = "", imageGen = false) {
  if (deep) return "You are Heap Chat in RESEARCH mode. The user wants a thorough, well-sourced answer — take your time and use many sources.\n" +
    "Process: (1) break the question into sub-topics; (2) for each, search the user's files (search_docs, find_text, read_file/read_section)" + (web ? " AND the web (run SEVERAL focused web_search queries, then read_url the most promising results in full)" : "") + "; (3) gather corroborating facts from MULTIPLE sources before concluding.\n" +
    "Keep searching and reading until you have solid coverage (you have many steps). Do not stop after one search.\n" +
    "Then write a STRUCTURED REPORT: a short summary, then clear sections with headings, specific facts and figures, and a citation after every claim that came from a source (a URL [like this](url) for web, or the filename in [brackets] for your files). End with a 'Sources' list. Be comprehensive and precise; never pad or invent.\n" +
    "You may include Mermaid diagrams (```mermaid — keep them simple and valid: `flowchart TD` or `sequenceDiagram`, quote node labels that contain spaces/punctuation, avoid special characters) and LaTeX math ($$…$$, \\(…\\)) where they clarify. Call make_chart for any data you want to plot." +
    memBlock;
  return "You are Heap Chat, a helpful assistant that can use tools to search and work with " + domainLabel + ". " +
    "When a request needs the user's files, immediately call the appropriate tool to do it — do NOT describe your capabilities or list what you can do; just perform the task. " +
    "Use search_docs to find content, find_text for an exact string, query_csv for spreadsheet math, read_file/read_section to read a document, extract_table to pull fields from many documents into a table, find_photos_of to find photos of a named person (face recognition); " +
    "only rename, delete, tag, save, or open when the user explicitly asks. " +
    "GROUNDING & HONESTY: First decide whether the question is actually about the user's files/data, or is a general question. " +
    "If the question plausibly concerns things people keep in documents — policies, budgets, invoices, people, teams, dates, amounts — run search_docs FIRST and only fall back to general knowledge if nothing relevant is found. " +
    "For general questions — or anything not about their files — answer fully and directly from your own knowledge; do NOT refuse, do NOT say it isn't in the files, and do NOT force a document search. Grounding is only needed when the question is about the user's own files/data. " +
    "When you do use the files: verify each retrieved excerpt genuinely concerns the exact subject asked (it may be a merely similar topic), and never attribute a fact to a source that doesn't state it. " +
    "If the user asks about their files and the answer truly isn't there, say plainly that it isn't in their files — then still give the best general answer you can. Never refuse to answer just because something isn't grounded. " +
    "Cite a filename in [square brackets] only when you actually used that document. " +
    "Answer general or simple questions directly without tools, and stop calling tools once you can answer. " +
    "PEOPLE/PHOTOS: when the user asks to see, show, or find photos/pictures of a PERSON by name (e.g. 'show me Taylor', 'photos of Sarah', 'pics of mom'), you MUST call find_photos_of with that name — it returns and displays their labeled photos. " +
    "When the user asks how a person LOOKS, their appearance, or what they're wearing, call find_photos_of with that name AND describe=true — it analyzes one of their photos with vision; then answer from what it reports, citing the photo. " +
    "Do NOT answer from general knowledge about who that person is, and do NOT say you can't see or show images. " +
    "KNOWLEDGE GRAPH: call knowledge_graph ONLY when the user is clearly asking about THEIR OWN data — e.g. 'what do I/we have on X', 'what's in my files about X', or how entities in their files/photos are connected. It returns the connected photos, documents, and co-occurring entities; synthesize that into a short grounded summary and cite the documents. A bare 'what do you know about <some public person/place/topic>' is a GENERAL-knowledge question — answer it directly from your own knowledge, do NOT route it through the knowledge graph. And whenever knowledge_graph (or any file tool) comes back empty or finds no match, do NOT stop and do NOT just report the empty state — fall back and answer from your own general knowledge, noting briefly that nothing was found in their files if relevant. " +
    "If the request is genuinely ambiguous (several files match, unclear which thing to act on), call ask_user with ONE short question instead of guessing — especially before destructive actions. " +
    "IMPORTANT: never end your reply by merely announcing that you will run/call a tool (e.g. 'running X now…'). If you intend to use a tool, actually call it in that same turn; otherwise give your final answer. " +
    agentToolMechanics({ autoMem, web, memory: true, connectors: true, imageGen, user }) +
    memBlock;
}

async function execTool(name, rawArgs, ctx) {
  const tool = TOOL_REGISTRY[name] || TOOL_REGISTRY[ALIASES[name]];
  if (!tool) return { result: `Unknown tool: ${name}`, summary: "unknown tool" };
  let args = rawArgs || {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
  try { return await tool.run(args, ctx); }
  catch (e) { return { result: `Tool ${name} failed: ${e.message}`, summary: "error" }; }
}

// incremental splitter for models that embed <think> tags inline in content (e.g. Qwen3-MLX):
// routes tagged spans to onThink and the rest to onContent, handling tags split across chunks
function makeThinkSplitter(onThink, onContent) {
  let buf = "", inThink = false;
  return {
    push(chunk) {
      buf += chunk;
      for (;;) {
        if (inThink) {
          const ci = buf.indexOf("</think>");
          if (ci >= 0) { const t = buf.slice(0, ci); if (t) onThink(t); buf = buf.slice(ci + 8); inThink = false; }
          else { const safe = buf.length > 8 ? buf.slice(0, -8) : ""; if (safe) { onThink(safe); buf = buf.slice(safe.length); } break; }
        } else {
          const oi = buf.indexOf("<think>");
          if (oi >= 0) { const c = buf.slice(0, oi); if (c) onContent(c); buf = buf.slice(oi + 7); inThink = true; }
          else { const safe = buf.length > 7 ? buf.slice(0, -7) : ""; if (safe) { onContent(safe); buf = buf.slice(safe.length); } break; }
        }
      }
    },
    flush() { const b = buf, t = inThink; buf = ""; if (b) (t ? onThink : onContent)(b); },
  };
}

// stream a completion's tokens to the client (used for the final research report and the drafter).
// `tag` (optional) labels thinking events with the agent that produced them, for the deep-work UI.
async function streamReport(model, messages, options, write, tag) {
  let content = "";
  const split = makeThinkSplitter(
    t => write({ message: { thinking: t, ...(tag ? { agent: tag } : {}) } }),
    c => { content += c; write({ message: { content: c } }); });
  const _pid = modelProviderOf(model);
  if (_pid !== "ollama") {
    try {
      await providerLLM.streamChatTurn(_pid, {
        model: routedBareModel(model), messages, temperature: options && options.temperature,
        onContent: c => split.push(c),
        onThinking: t => write({ message: { thinking: t, ...(tag ? { agent: tag } : {}) } }),
      });
    } catch { return ""; }   // matches the Ollama branch below: fail silently, don't crash the pipeline
    split.flush();
    return content;
  }
  const up = await fetch(`${ollamaConn.baseUrl()}/api/chat`, { method: "POST", headers: ollamaConn.headers(), body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE, model, messages, stream: true, think: false, options }) });
  if (!up.ok || !up.body) return "";
  const reader = up.body.getReader(); const dec = new TextDecoder(); let buf = "";
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.message && o.message.thinking) write({ message: { thinking: o.message.thinking, ...(tag ? { agent: tag } : {}) } });
      const c = o.message && o.message.content; if (c) split.push(c);
    }
  }
  split.flush();
  return content;
}
// server-orchestrated deep research: plan → research each sub-topic on the web (+ user's files) → synthesize a cited report.
// drives search/read itself (doesn't rely on the local model's tool-calling), so it can go deep reliably. time is not a constraint.
async function deepResearchPipeline({ q, history, urls = [], chosen, ctx, write, temperature, contextWindow, web, files = true }) {
  const opt = { temperature, ...(contextWindow ? { num_ctx: contextWindow } : {}) };
  if (!web && files) { try { await ensureIndex(ctx); } catch {} }   // files-only research needs the index built
  // conversation context, so the plan/report can resolve references like "the actress we discussed" to
  // the ACTUAL names/entities from earlier turns instead of inventing placeholders.
  const convoText = (history || []).filter(m => m.role && m.content && m.role !== "system")
    .slice(-8).map(m => `${String(m.role).toUpperCase()}: ${String(m.content).slice(0, 1400)}`).join("\n");
  const convoBlock = convoText ? `\n\nCONVERSATION SO FAR (resolve any reference in the question — "the actress/topic/company we discussed", "these", "them" — to the ACTUAL names/entities below; NEVER use placeholders like [Name]):\n${convoText}` : "";
  const findings = []; const sourceMap = new Map();
  const stepName = web ? "web_search" : "search_docs";

  // gather evidence for one sub-question from the web (search + read several pages) and the user's files
  const gather = async (sub) => {
    let evidence = "", count = 0, webErr = null;
    if (web) {
      let results = [];
      try { results = (await ddgText(sub)).slice(0, 6); }
      catch (e) { webErr = e.message; }   // keep the real reason (rate-limited / blocked / timeout) — don't hide it
      results.forEach(r => sourceMap.set(r.url, r.title)); count += results.length;
      const pages = await Promise.all(results.slice(0, 4).map(r => fetchPageText(r.url).then(t => ({ r, t })).catch(() => null)));
      let readText = "";
      for (const p of pages) if (p && p.t) readText += `\n\n=== ${p.r.title} (${p.r.url}) ===\n${p.t.slice(0, 6000)}`;
      evidence += results.map(r => `- ${r.title} (${r.url}): ${r.snippet}`).join("\n") + readText;
    }
    if (files) try {   // search the user's own files for this sub-topic ("Use my documents" must be on)
      const fr = await retrieve(ctx.key, sub, 8);
      const fh = (fr.hits || []).filter(h => h.score >= 0.4);
      fh.forEach(h => { evidence += `\n\n[file: ${h.name}]\n${h.text.slice(0, 1600)}`; if (h.path) sourceMap.set("file://" + h.path, h.name); });
      count += fh.length;
    } catch {}
    return { evidence: evidence.slice(0, 16000), count, webErr };
  };
  // research a wave of sub-questions. Gather with BOUNDED concurrency (a burst of parallel DuckDuckGo
  // queries gets rate-limited / bot-blocked), then summarize each in order (serial GPU).
  const runWave = async (subList) => {
    const gathered = new Array(subList.length);
    let gi = 0;
    await Promise.all(Array.from({ length: Math.min(3, subList.length) }, async () => {
      while (gi < subList.length) { const i = gi++; gathered[i] = await gather(subList[i]); }
    }));
    for (let i = 0; i < subList.length; i++) {
      const sub = subList[i], g = gathered[i];
      write({ step: { name: stepName, args: { query: sub } } });
      // surface the actual failure (rate-limit / blocked / timeout) instead of a bland "no sources found",
      // so the report — and the user — can tell "the web is throttling us" from "nothing exists on this".
      const summary = g.evidence.trim()
        ? await routedCompleteText(chosen, "Summarize the key findings for the SUB-QUESTION using ONLY the evidence. Be specific and thorough: facts, figures, names, dates, and the relationships between them. Cite source URLs or [filenames] inline after each fact. 2-3 tight paragraphs; if the evidence is thin or conflicting, say so explicitly.", `SUB-QUESTION: ${sub}\n\nEVIDENCE:\n${g.evidence}`, 700)
        : g.webErr ? `Web search could not fetch sources for this sub-question — ${g.webErr}` : "No sources found for this sub-question.";
      findings.push({ sub, summary });
      const label = (g.webErr && !g.count) ? "search failed — " + g.webErr.slice(0, 40) : `${g.count} sources`;
      write({ step_result: { name: stepName, summary: `${label} · ${sub.slice(0, 46)}`, detail: summary } });
    }
  };

  // 1) plan the investigation (broad coverage)
  write({ step: { name: "plan", args: { q: q.slice(0, 80) } } });
  const plan = await routedCompleteJSON(chosen, "You are a meticulous research planner. Given a question (and any conversation context), return ONLY JSON {\"subqueries\":[...]} with 6-10 focused, non-overlapping sub-questions that TOGETHER cover the topic comprehensively — background/definitions, key players, concrete data/numbers, mechanisms or how-it-works, comparisons/alternatives, challenges/risks, and recent developments. Make each sub-question specific and self-contained, spelling out the REAL names/entities from the conversation — NEVER use placeholders like [Name] or [Topic]. If the question refers to multiple named entities, cover each one.", q + convoBlock, 700);
  const subs = (plan && Array.isArray(plan.subqueries) && plan.subqueries.length ? plan.subqueries : [q]).map(String).filter(Boolean).slice(0, 10);
  write({ step_result: { name: "plan", summary: `${subs.length} sub-questions`, detail: subs.map((s, i) => `${i + 1}. ${s}`).join("\n") } });

  // 1b) scrape any links the user pasted and fold them into the findings, so the report is grounded in
  // exactly the pages they asked about (not just what search turned up).
  for (const url of (urls || []).slice(0, 3)) {
    write({ step: { name: "read_url", args: { url } } });
    let text = ""; try { text = await fetchPageText(url); } catch {}
    const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    if (text && text.trim()) {
      sourceMap.set(url, host);
      const summary = await routedCompleteText(chosen, "Summarize what this page says that is relevant to the QUESTION. Be specific: facts, figures, names, dates. Cite the page URL inline. 2-4 tight paragraphs.", `QUESTION: ${q}\n\nPAGE (${url}):\n${text.slice(0, 12000)}`, 700);
      findings.push({ sub: `Pasted link: ${host}`, summary });
      write({ step_result: { name: "read_url", summary: `read ${host}`, detail: summary } });
    } else {
      findings.push({ sub: `Pasted link: ${host}`, summary: `The page ${url} could not be read (blocked, non-text, or unreachable).` });
      write({ step_result: { name: "read_url", summary: `couldn't read ${host}`, detail: "" } });
    }
  }

  // 2) first research wave over the planned sub-questions
  await runWave(subs);

  // 3) gap analysis → a second wave that drills into what the first pass left open (iterative deepening)
  write({ step: { name: "plan", args: { q: "follow-up gaps" } } });
  const gapPlan = await routedCompleteJSON(chosen, "You review research findings for gaps. Given the QUESTION and the FINDINGS gathered so far, return ONLY JSON {\"subqueries\":[...]} with up to 4 NEW, specific follow-up questions that dig into what is still missing, unclear, unquantified, or contradictory — or [] if coverage is already thorough. Do not repeat earlier questions.", `QUESTION: ${q}\n\nFINDINGS SO FAR:\n${findings.map(f => `- ${f.sub}: ${f.summary.slice(0, 240)}`).join("\n")}`, 500);
  const follow = (gapPlan && Array.isArray(gapPlan.subqueries) ? gapPlan.subqueries : []).map(String).filter(Boolean).slice(0, 4);
  write({ step_result: { name: "plan", summary: follow.length ? `${follow.length} follow-up question${follow.length === 1 ? "" : "s"}` : "coverage looks complete", detail: follow.map((s, i) => `${i + 1}. ${s}`).join("\n") } });
  if (follow.length) await runWave(follow);

  // 4) synthesize the final report (streamed)
  const sourcesList = [...sourceMap.entries()].map(([u, title], i) => `[${i + 1}] ${title} — ${u.startsWith("file://") ? u.slice(7) : u}`).join("\n");
  const synthSys = "You are writing a thorough, in-depth, well-structured research report. Use ONLY the research findings provided — never invent facts, names, numbers, or example/placeholder entities (no '[Actress Name]', no made-up stand-ins). If the findings contain little or no real data, say so plainly and report only what was actually found — do NOT fabricate a demonstration. Structure: a short Executive Summary (3-5 sentences), then clear sections with ## headings that follow the logical arc of the topic, with specific facts/figures, comparisons, and a citation after every claim (a URL [like this](url) for web, or [filename] for the user's files). Where useful, include a Markdown table or a simple ```mermaid diagram. Surface uncertainties and conflicting evidence honestly. End with a '## Sources' list. Be comprehensive, precise, and well-organized — this is a deep report, not a summary." + sysInfoBlock();
  const synthUser = `QUESTION: ${q}${convoBlock}\n\nRESEARCH FINDINGS:\n${findings.map(f => `### ${f.sub}\n${f.summary}`).join("\n\n")}\n\nAVAILABLE SOURCES:\n${sourcesList}`;
  await streamReport(chosen, [{ role: "system", content: synthSys }, { role: "user", content: synthUser }], { ...opt, num_predict: 8000 }, write);

  // 5) sources + grounding (web URLs + file paths)
  const sources = [...sourceMap.entries()].slice(0, 16).map(([u, title]) => u.startsWith("file://") ? { name: title, path: u.slice(7), score: 1 } : { name: title || u, path: u, score: 1 });
  if (sources.length) write({ sources });
  write({ grounding: { mode: "grounded", sources: sources.length } });
}

/* ---- "Deep work": a roster of specialist agents take turns, picked dynamically by an
   orchestrator (planner → researcher → drafter → critic), then the drafter writes the final
   streamed answer. Built on the same primitives as the single-agent loop (execTool, agentToolDefs,
   completeJSON, streamReport) so grounding, citations, and fact-check all still apply. The roster is
   a registry: adding a "retest" or "enhancer" agent later is one more entry. Time is not a
   constraint — turns run sequentially through the single local GPU. ---- */
// Built-in defaults. Each agent has a stable `kind` that drives the pipeline's control flow
// (round order, critic gating, drafter writes the final answer) — users may edit the prompt,
// whenToUse, temperature, maxTokens, enabled flag, and (researcher) tool selection, but NOT the
// kind, so the control flow never breaks. A user's edits live in roster.json as overrides merged
// over these by `rosterFor`. Adding a "retest"/"enhancer" agent later = one more entry here.
const ROSTER_DEFAULTS = [
  {
    kind: "planner", order: 0, name: "planner", label: "Planner", summaryLabel: "made a plan", enabled: true,
    whenToUse: "decompose the request into a concrete, tool-aware research plan. Pick first, before any research.",
    role: "You are the PLANNER on a multi-agent team answering the user's request about THEIR files/knowledge base " +
      "(documents, spreadsheets, photos, notes). Turn the request into a precise research plan the Researcher can " +
      "execute. You do NOT answer the question and you do NOT call tools.\n" +
      "Produce, as short skimmable bullets:\n" +
      "1. RESTATEMENT — one line capturing exactly what the user wants, including any implicit sub-goals.\n" +
      "2. SUB-QUESTIONS — 3-6 specific, non-overlapping questions that together fully answer the request. Make them " +
      "concrete (name the people, dates, amounts, files, or entities involved), never generic.\n" +
      "3. WHERE TO LOOK — for each sub-question, the likely evidence and the best tool: search_docs for topical " +
      "content, find_text for an exact string/number, query_csv for spreadsheet math, read_file/read_section to read " +
      "a specific document, find_related to expand from a hit, find_photos_of for a named person, knowledge_graph for " +
      "how people/places/things connect, and web_search/read_url for public or current facts. The task will tell you " +
      "whether WEB ACCESS is enabled — when it is, explicitly plan web lookups for any sub-question whose answer is " +
      "unlikely to be in the user's own files (current events, public facts, background), alongside the file searches.\n" +
      "4. SUCCESS CRITERIA — what a complete, well-grounded answer must contain.\n" +
      "Give direction, not prose; assume the Researcher is competent.",
    instruction: "Produce the research plan now — restatement, sub-questions, where to look, and success criteria.",
    tools: false, temperature: 0.3, maxTokens: 700,
  },
  {
    kind: "researcher", order: 1, name: "researcher", label: "Researcher", summaryLabel: "gathered evidence", enabled: true,
    whenToUse: "execute the plan with tools and collect grounded, cited evidence from the files (and web if enabled).",
    role: "You are the RESEARCHER on a multi-agent team. Execute the Planner's plan by calling tools to gather " +
      "GROUNDED evidence. Work sub-question by sub-question.\n" +
      "Method: start broad with search_docs, then narrow — find_text for exact strings/figures, query_csv for " +
      "spreadsheet calculations, read_file/read_section to read a promising document in full, find_related to expand " +
      "from a strong hit, find_photos_of for a named person, knowledge_graph to see how entities connect. " +
      "Decide per sub-question where the answer is likely to live: the user's files, the web, or both. When web access " +
      "is enabled (the task will tell you), use the files AND the web — and you MUST run web_search (then read_url on the " +
      "best results) whenever a file search returns nothing relevant, or for any current/public fact the files don't " +
      "cover. Never conclude information is unavailable before trying the web. Do NOT stop after one search — keep going " +
      "until each sub-question is covered or you have genuinely exhausted both the files and (if enabled) the web.\n" +
      "Cite as you go: every fact must carry its source — a [filename] for files, a URL for the web. Never assert " +
      "anything you did not find in a tool result.\n" +
      "Finish with a structured EVIDENCE BRIEF organized by sub-question: the specific facts, figures, names, dates, " +
      "and short quotes you found, each with its citation. Explicitly flag any sub-question where the evidence was " +
      "thin, missing, or conflicting. Do NOT write the final answer — just deliver clean, cited evidence.",
    instruction: "Now gather evidence with the tools for each sub-question, then write the cited evidence brief.",
    // used when no files/web are available (creation tasks): produce a spec/brief instead of searching
    noSourcesRole: "You are the RESEARCHER on a team, but NO external sources (the user's files and the web) are " +
      "available — you cannot search. Instead, from general knowledge, produce a concrete BRIEF that sets the drafter " +
      "up to fully satisfy the request and follow it exactly. Cover:\n" +
      "1. REQUIREMENTS — restate precisely what the artifact must do and include, with explicit acceptance criteria " +
      "(every part of the user's ask, stated concretely — not vague).\n" +
      "2. TECHNICAL FACTS — the exact details needed to build it correctly: real API endpoints and request/response " +
      "shapes, library/framework specifics and versions, config, auth (e.g. Ollama chat = POST " +
      "http://localhost:11434/api/chat, body {model, messages, stream}, NDJSON when streaming).\n" +
      "3. STRUCTURE — the concrete breakdown: files to produce, components/functions, data flow.\n" +
      "4. PITFALLS — common mistakes and edge cases the drafter must handle.\n" +
      "Be specific and correct. Do NOT claim you searched anything, and do NOT write the artifact yourself — only the brief.",
    tools: true, toolNames: ["search_docs", "find_text", "list_files", "read_file", "read_section", "query_csv",
      "compare_files", "find_related", "find_photos_of", "knowledge_graph", "image_tool", "web_search", "read_url"],
    allToolNames: ["search_docs", "find_text", "list_files", "read_file", "read_section", "query_csv",
      "compare_files", "find_related", "find_photos_of", "knowledge_graph", "image_tool", "web_search", "read_url"],
    maxToolSteps: 8, temperature: 0.2, maxTokens: 2000,
  },
  {
    kind: "drafter", order: 2, name: "drafter", label: "Drafter", summaryLabel: "wrote a draft", enabled: true, required: true,
    whenToUse: "synthesize the evidence into the answer, and revise it when the critic raises issues.",
    role: "You are the DRAFTER on a multi-agent team. Produce exactly what the user asked for.\n" +
      "FIRST decide the task type:\n" +
      "- If they asked you to CREATE or GENERATE an artifact (code, an app, a document, copy, a plan), OUTPUT THE " +
      "COMPLETE ARTIFACT ITSELF — full, runnable code in fenced ``` code blocks (with the language tag), or the full " +
      "document — not a description, explanation, plan, or partial sketch. Default to giving the thing, not talking " +
      "about it. Do not invent that you need their files; just build it.\n" +
      "  When the user asks to integrate with a real API, library, or service, write REAL working code against its " +
      "ACTUAL interface — real endpoints, real request/response shapes, real streaming — and NEVER stub, mock, fake, " +
      "or simulate it unless they explicitly ask for a mock. (E.g. Ollama = POST http://localhost:11434/api/chat with " +
      "{model, messages, stream:true} returning newline-delimited JSON; read process.env or a config for the host.) " +
      "Use concrete values, not placeholders like [Your App Name]. Provide EVERY file needed to run it — if the code " +
      "imports './App.css', include that CSS file too (as its own ``` block); don't reference files you didn't write. " +
      "Make sure props/handlers are passed with the right types (e.g. pass a function, not an object). Do NOT leave " +
      "comments that explain your edits or the review (no '// Fixed…', '(refined)') — emit clean final code only.\n" +
      "- If they asked a FACT-BASED question about their files/the world, answer using ONLY the evidence the team " +
      "gathered — never invent facts, figures, or sources — and put a citation ([filename] or URL) after every fact " +
      "drawn from a source. If the evidence is insufficient or conflicting, say so plainly; do not guess.\n" +
      "General: lead with the answer, no preamble; structure it clearly; match depth to the request. When you receive " +
      "critique, REVISE — fix every issue raised, keep what was correct. You may use Markdown tables and simple " +
      "```mermaid diagrams where they help. Output ONLY the answer/artifact — no notes about the team or your process.",
    instruction: "Write the answer now.", tools: false, temperature: 0.55, maxTokens: 3000,
  },
  {
    kind: "critic", order: 3, name: "critic", label: "Critic", summaryLabel: "reviewed the draft", enabled: true,
    whenToUse: "rigorously review the latest draft for grounding, completeness, and accuracy (after a draft exists).",
    role: "You are the CRITIC on a multi-agent team — a rigorous, skeptical reviewer. Review the latest DRAFT against " +
      "the gathered EVIDENCE and the user's request. Be specific and fair: only raise issues you can point to.\n" +
      "FIRST judge the task type. If the user asked to CREATE or GENERATE an artifact (code, an app, a document), " +
      "judge CORRECTNESS, COMPLETENESS, and QUALITY of the artifact — does the code look correct and runnable, does " +
      "it meet the request — and do NOT demand citations or evidence (generated work has none). Only for fact-based " +
      "questions, check:\n" +
      "1. GROUNDING — is every factual claim supported by the evidence and correctly cited? Flag anything " +
      "unsupported, mis-cited, or hallucinated.\n" +
      "2. COMPLETENESS — does it answer everything the user asked, including implicit sub-goals? Flag missing pieces.\n" +
      "3. ACCURACY — are figures, names, dates, and logic correct and internally consistent with the evidence? Flag " +
      "contradictions.\n" +
      "4. CLARITY — is anything confusing, mis-structured, or misleading? (Flag only if it materially hurts the answer.)\n" +
      "For each problem you MUST quote the exact offending span from the draft — never a vague complaint. Reply with " +
      "ONLY compact JSON, no prose: {\"ok\":true|false,\"summary\":\"<one line>\",\"issues\":[{\"span\":\"<quoted draft " +
      "text>\",\"problem\":\"<what's wrong + which evidence it lacks or contradicts>\",\"fix\":\"<concrete correction>\"}]}. " +
      "CONTRACT: if you list ANY issue, you MUST set ok:false. Set ok:true ONLY with a completely empty issues array — " +
      "never both at once. List at most 5 issues, most important first.",
    instruction: "Review the latest draft now and return the JSON verdict.", tools: false, temperature: 0.2, maxTokens: 900,
  },
];
// the per-user roster = code defaults with the user's saved overrides (roster.json) merged in by kind.
// non-editable behavior fields (instruction, summaryLabel, label, tools flag) always come from the defaults.
function rosterFor(user) {
  const overrides = {};
  (storesFor(user).roster || []).forEach(o => { if (o && o.kind) overrides[o.kind] = o; });
  return ROSTER_DEFAULTS.map(def => {
    const o = overrides[def.kind] || {};
    const validTools = Array.isArray(o.toolNames) && def.allToolNames
      ? o.toolNames.filter(n => def.allToolNames.includes(n)) : null;
    return {
      ...def,
      enabled: def.required ? true : (o.enabled !== undefined ? o.enabled !== false : def.enabled !== false),
      role: typeof o.role === "string" && o.role.trim() ? o.role : def.role,
      whenToUse: typeof o.whenToUse === "string" && o.whenToUse.trim() ? o.whenToUse : def.whenToUse,
      temperature: typeof o.temperature === "number" ? o.temperature : def.temperature,
      maxTokens: typeof o.maxTokens === "number" ? o.maxTokens : def.maxTokens,
      toolNames: validTools && validTools.length ? validTools : def.toolNames,
      order: typeof o.order === "number" ? o.order : def.order,
      model: typeof o.model === "string" ? o.model : (def.model || ""),   // "" = use the chat's chosen model
    };
  }).sort((a, b) => a.order - b.order);
}
const ORCH_SYS_BASE =
  "You are the ORCHESTRATOR of a team of specialist agents collaborating to answer the user's request. " +
  "Each round, pick ONE agent to act NEXT based on the TASK and the TRANSCRIPT of what the team has done so far, " +
  "or DONE when the answer is complete and the critic has approved it. " +
  "Reply with ONLY compact JSON, no prose: {\"next\":\"<kind>\"|\"DONE\",\"reason\":\"<short>\"}.\n" +
  "Typical flow: planner → researcher → drafter → critic. For a pure CREATION task (write code/an app/a " +
  "document) where there is nothing to research, SKIP the researcher: planner → drafter → critic. " +
  "This is a LOOP: if the critic reports issues " +
  "(ok:false), send it back to the drafter to revise, then back to the critic to re-check — repeat this " +
  "revise→review cycle until the critic approves (ok:true) or it clearly cannot improve further. If the critic " +
  "finds a grounding gap, you may send the researcher back to gather more evidence before the next draft. " +
  "NEVER pick the same agent twice in a row. Choose DONE only once the critic has approved the latest draft " +
  "(or you have exhausted reasonable revisions).\n" +
  "Agents available:\n";

// one specialist agent's turn: a bounded tool loop (non-streaming). Tool results and their sources/
// evidence are folded into the shared `acc` so the final answer is grounded, cited, and fact-checked
// exactly like the single-agent loop. Returns the agent's final text.
async function runAgentTurn({ agent, task, chosen, ctx, write, toolOpts, contextWindow, web, richRender, acc }) {
  const model = agent.model || chosen;   // per-agent model override (e.g. a coder model for the researcher)
  const tag = { kind: agent.kind, label: agent.label };   // so the UI can show which agent ran each step
  const msgs = [{ role: "system", content: agent.role + sysInfoBlock() }, { role: "user", content: task }];
  let defs = agent.tools ? agentToolDefs({ ...toolOpts, web }) : null;
  if (defs && agent.toolNames) defs = defs.filter(d => agent.toolNames.includes(d.function.name));
  // a tool-using agent (the researcher) with NO tools available (files + web both off) can't search —
  // don't let it fabricate a fake search log. If it has a no-sources brief role, use that to produce a
  // requirements/technical spec from general knowledge (genuinely helps the drafter follow the ask);
  // otherwise just report the situation.
  if (agent.tools && (!defs || !defs.length)) {
    if (agent.noSourcesRole) {
      const brief = await routedCompleteText(model, agent.noSourcesRole + sysInfoBlock(), task, agent.maxTokens || 1500, agent.temperature ?? 0.3);
      if (brief && brief.trim()) return brief.trim();
    }
    return "No external sources are available (the user's files and the web are both off) — nothing to research. The drafter should work from general knowledge.";
  }
  let finalText = "";
  for (let i = 0; i < (agent.tools ? (agent.maxToolSteps || 4) : 1); i++) {
    const promptChars = msgs.reduce((n, m) => n + String(m.content || "").length + 50, defs ? 4000 : 500);
    const need = Math.ceil(promptChars / 3) + (agent.maxTokens || 1500) + 256;
    const numCtx = Math.max(contextWindow || 0, [4096, 8192, 16384, 32768, 65536, 131072].find(b => b >= need) || 131072);
    let content, toolCalls;
    try {
      if (modelProviderOf(model) !== "ollama") {
        const r = await providerLLM.completeWithTools(modelProviderOf(model), { model: routedBareModel(model), messages: msgs, tools: defs, temperature: agent.temperature ?? 0.4, maxTokens: agent.maxTokens || 1500 });
        content = r.content; toolCalls = r.toolCalls;
      } else {
        const up = await fetch(`${ollamaConn.baseUrl()}/api/chat`, {
          method: "POST", headers: ollamaConn.headers(),
          body: JSON.stringify({ keep_alive: OLLAMA_KEEP_ALIVE, model, messages: msgs, stream: false, think: false,
            ...(defs ? { tools: defs } : {}),
            options: { temperature: agent.temperature ?? 0.4, num_predict: agent.maxTokens || 1500, num_ctx: numCtx } }),
        });
        if (!up.ok) break;
        const j = await up.json();
        const m = j.message || {};
        content = stripThink(m.content || ""); toolCalls = m.tool_calls || [];
      }
    } catch { break; }
    if (content) finalText = content;
    if (!toolCalls.length) break;
    msgs.push({ role: "assistant", content, tool_calls: toolCalls });
    for (const tc of toolCalls) {
      const fname = tc.function && tc.function.name;
      const fargs = tc.function && tc.function.arguments;
      write({ step: { name: fname, args: fargs, agent: tag } });
      const { result, sources, summary, render } = await execTool(fname, fargs, ctx);
      if (acc) {
        if (RETRIEVAL_TOOLS.has(fname)) acc.searched = true;
        if (RETRIEVAL_TOOLS.has(fname) && typeof result === "string" && result.trim())
          acc.evidence.push({ source: (sources && sources[0] && sources[0].name) || fname, text: result.slice(0, 4000) });
        if (fname === "web_search" || fname === "read_url") (sources || []).forEach(s => s.path && acc.forceSources.add(s.path));
        (sources || []).forEach(s => { const cur = acc.sources.get(s.path); if (!cur || cur.score < s.score) acc.sources.set(s.path, { name: s.name, score: s.score }); });
      }
      write({ step_result: { name: fname, summary, detail: typeof result === "string" ? result.slice(0, 4000) : "", agent: tag } });
      if (richRender && Array.isArray(render)) render.forEach(spec => write({ render: spec }));
      // tool_call_id links this result back to the assistant's tool call — required by NVIDIA/OpenAI-
      // compatible providers; Ollama doesn't need it and tc.id is simply absent for that path.
      msgs.push({ role: "tool", content: typeof result === "string" ? result : JSON.stringify(result), ...(tc.id ? { tool_call_id: tc.id } : {}) });
    }
  }
  return finalText;
}

// the critic approves a draft ONLY when ok:true AND it raised no issues. (Models frequently set
// ok:true while still listing problems — that must count as not-approved so the drafter fixes them.)
function criticIsApproved(text) {
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (m) { const v = JSON.parse(m[0]); return v.ok === true && (!Array.isArray(v.issues) || v.issues.length === 0); }
  } catch {}
  return /"ok"\s*:\s*true/i.test(text) && !/"issues"\s*:\s*\[\s*\{/.test(text);   // fallback: ok:true with empty issues
}

// orchestrator: pick the next agent (or DONE) from the roster given the transcript so far.
async function pickNextAgent({ chosen, roster, task, transcript, fallback }) {
  const sys = ORCH_SYS_BASE + roster.map(a => `- ${a.kind}: ${a.whenToUse}`).join("\n") +
    "\n- DONE: a reviewed draft answer is ready.";
  const j = await routedCompleteJSON(chosen, sys, `TASK:\n${task}\n\nTRANSCRIPT SO FAR:\n${transcript || "(nothing yet)"}\n\nWho should act next?`, 120);
  let next = j && j.next ? String(j.next).toLowerCase().trim() : "";
  if (next !== "done" && !roster.some(a => a.kind === next)) next = fallback();   // invalid pick → deterministic
  return { next, reason: (j && j.reason) || "" };
}

async function multiAgentPipeline({ q, history, chosen, ctx, write, temperature, contextWindow, web, toolOpts, richRender, factCheck }) {
  if (!web) { try { await ensureIndex(ctx); } catch {} }   // files-only research needs the index built
  // the user's (possibly edited) roster; the drafter always runs since it writes the final answer
  const roster = rosterFor(ctx.user).filter(a => a.enabled || a.kind === "drafter");
  const byKind = Object.fromEntries(roster.map(a => [a.kind, a]));
  const drafterAgent = byKind.drafter || ROSTER_DEFAULTS.find(d => d.kind === "drafter");
  const acc = { sources: new Map(), evidence: [], forceSources: new Set(), searched: false };
  const turns = [];   // { kind, text }
  const histText = (history || []).filter(m => m.role && m.content).slice(-8).map(m => `${m.role}: ${m.content}`).join("\n");
  // Dynamic orchestration: up to MAX_ROUNDS turns, the orchestrator picking who acts next. The
  // drafter↔critic revise→review cycle repeats until the critic approves (or caps are hit). The
  // drafter writes straight into the chat bubble — first draft streams live; each later revision
  // replaces it — so the answer you see is always the team's latest, no redundant final pass.
  const MAX_ROUNDS = 20;
  const MAX_DRAFTS = 6;            // hard cap on revise cycles so a stubborn critic can't loop forever
  const detOrder = roster.map(a => a.kind);
  const fallback = () => { const done = new Set(turns.map(t => t.kind)); return detOrder.find(n => !done.has(n)) || "done"; };
  const tagFor = k => ({ kind: byKind[k].kind, label: byKind[k].label });
  // tell every agent, at runtime, which sources are actually available — so they DECIDE where to look
  // (files AND web, and escalate to the web when files are empty/off) rather than defaulting to RAG only.
  const filesOn = toolOpts.files !== false;
  const avail = [filesOn ? "the user's files (file-search tools)" : null, web ? "the web (web_search + read_url)" : null].filter(Boolean);
  const webNote = avail.length
    ? "\nACCESS: You may gather evidence from " + avail.join(" AND ") + ". " +
      (filesOn && web ? "Use BOTH — search the files first, and you MUST also use the web for anything the files don't cover, for current/public facts, or whenever a file search returns nothing relevant; never conclude info is unavailable before trying the web. " : "") +
      (!filesOn ? "The user's files are OFF — do NOT attempt to read them (those tools are unavailable). " : "") +
      "Cite file names in [brackets] and web pages by URL."
    : "\nACCESS: Neither the user's files nor the web are available for this task — answer from general knowledge only and say so plainly.";
  let answerText = "", draftedToBubble = false, drafts = 0, lastKind = null, criticApproved = false;

  // the drafter writes (or revises) the user-facing answer
  async function runDrafter() {
    const transcript = turns.map(t => `[${byKind[t.kind].label}]\n${t.text}`).join("\n\n");
    const sys = drafterAgent.role + sysInfoBlock();
    const user = `USER REQUEST:\n${q}\n` + (histText ? `\nCONVERSATION SO FAR:\n${histText}\n` : "") +
      `\nYOUR TEAM'S WORK (plan, evidence, prior draft, critique):\n${transcript}\n\n` +
      (draftedToBubble
        ? "Revise YOUR previous answer to fix every issue the critic raised, keeping everything that was already correct. " +
          "Apply the fixes SILENTLY — re-output the whole clean artifact, and do NOT add comments describing what you " +
          "changed (no '// Fixed…' or '(refined)' notes). "
        : "Produce what the user asked for now. ") +
      "If this is a creation task (code, an app, a document), output the COMPLETE artifact itself — full runnable code in " +
      "fenced ``` blocks, using the REAL API/library (never a mock or simulation unless asked) and concrete values (no " +
      "placeholders) — not an explanation or sketch. If it is a fact question, use ONLY the evidence the team gathered " +
      "and cite [filenames] or URLs after each fact. Output only the answer/artifact.";
    const nump = Math.max(drafterAgent.maxTokens || 2000, 3072);
    const drafterModel = drafterAgent.model || chosen;   // per-agent model override (e.g. a coder model)
    if (!draftedToBubble) {   // first draft → stream live into the bubble
      write({ step: { name: "agent:drafter", args: {}, agent: tagFor("drafter") } });
      const opt = { temperature: drafterAgent.temperature ?? temperature, num_predict: nump, ...(contextWindow ? { num_ctx: contextWindow } : {}) };
      answerText = await streamReport(drafterModel, [{ role: "system", content: sys }, { role: "user", content: user }], opt, write, tagFor("drafter"));
      write({ step_result: { name: "agent:drafter", summary: drafterAgent.summaryLabel, detail: "", agent: tagFor("drafter") } });
      draftedToBubble = true;
    } else {   // subsequent revision → replace the bubble text
      write({ step: { name: "agent:drafter", args: { revision: true }, agent: tagFor("drafter") } });
      const fixed = await routedCompleteText(drafterModel, sys, user, nump, drafterAgent.temperature ?? temperature);
      const changed = fixed && fixed.trim() && fixed.trim() !== answerText.trim();
      if (changed) { answerText = fixed.trim(); write({ revision: { text: answerText } }); }   // replaces the bubble in place
      // be honest: only claim a revision when the text actually changed
      write({ step_result: { name: "agent:drafter", summary: changed ? "revised the answer" : "no changes needed", detail: "", agent: tagFor("drafter") } });
    }
    turns.push({ kind: "drafter", text: answerText });
    drafts++;
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const transcript = turns.map(t => `[${byKind[t.kind].label}]\n${t.text}`).join("\n\n");
    let next = round === 0 ? (byKind.planner ? "planner" : (detOrder[0] || "done"))   // start by planning
      : (await pickNextAgent({ chosen, roster, task: q, transcript, fallback })).next;
    if (next !== "done" && next === lastKind)   // never run the same agent twice in a row — keep the revise cycle alternating
      next = (lastKind === "drafter" && byKind.critic) ? "critic" : (lastKind === "critic" && byKind.drafter) ? "drafter" : fallback();
    if (next === "done" || !byKind[next]) break;
    if (next === "drafter") { await runDrafter(); lastKind = "drafter"; criticApproved = false; if (drafts >= MAX_DRAFTS) break; continue; }

    const agent = byKind[next];
    write({ step: { name: "agent:" + agent.kind, args: {}, agent: tagFor(next) } });
    const taskBlock = `USER REQUEST:\n${q}\n` + (histText ? `\nCONVERSATION SO FAR:\n${histText}\n` : "") +
      (transcript ? `\nTEAM PROGRESS SO FAR:\n${transcript}\n` : "") + webNote + `\n${agent.instruction}`;
    const text = await runAgentTurn({ agent, task: taskBlock, chosen, ctx, write, toolOpts, contextWindow, web, richRender, acc });
    turns.push({ kind: agent.kind, text });
    write({ step_result: { name: "agent:" + agent.kind, summary: agent.summaryLabel, detail: text, agent: tagFor(next) } });
    lastKind = agent.kind;
    if (agent.kind === "critic") {
      // Approved ONLY if ok:true AND it listed no issues. Models often say ok:true while still
      // listing problems — that is NOT approval; the issues must go back to the drafter to be fixed.
      criticApproved = criticIsApproved(text);
      if (criticApproved) break;   // genuinely clean → finish
    }
  }
  // Always publish a drafter answer — and never end on the critic. If we ran out of rounds/drafts right
  // after a critique (or never drafted at all), do one final drafter pass so the latest feedback lands.
  if (!draftedToBubble || (lastKind === "critic" && !criticApproved)) await runDrafter();

  // closing: sources, grounding, self-verification, provenance — same trust layer as /api/agent
  const allText = answerText;
  let used = [...acc.sources.entries()].filter(([p, v]) => acc.forceSources.has(p) || allText.includes(v.name) || (isImageFile(v.name) && v.score >= 0.5));
  let verification = null;
  if (factCheck && acc.evidence.length && allText.trim() && (used.length || acc.searched)) {
    write({ step: { name: "fact_check", args: {} } });
    const evidenceText = acc.evidence.map(e => `[${e.source}]\n${e.text}`).join("\n\n").slice(0, 7000);
    const v = await routedCompleteJSON(chosen, VERIFY_SYS, `EVIDENCE:\n${evidenceText}\n\nANSWER:\n${allText.trim().slice(0, 3500)}`);
    const cleanIssues = arr => Array.isArray(arr) ? arr.map(s => String(s).trim()).filter(s => s && !/^(none|n\/?a|null|no issues?|nothing)$/i.test(s)).slice(0, 3) : [];
    if (v && v.verdict) {
      verification = { verdict: String(v.verdict).toLowerCase(), issues: cleanIssues(v.issues) };
      if (Array.isArray(v.used) && v.used.length) {
        const u = v.used.map(x => String(x).toLowerCase());
        const match = ([p, val]) => u.some(name => val.name.toLowerCase().includes(name) || name.includes(val.name.toLowerCase()));
        const keep = used.filter(match);
        if (keep.length) used = keep; else if (!used.length) used = [...acc.sources.entries()].filter(match);
      }
    }
    const fcIssues = verification && verification.issues.length ? verification.issues : null;
    write({ step_result: { name: "fact_check",
      summary: !verification ? "check inconclusive"
        : fcIssues ? `${fcIssues.length} claim${fcIssues.length === 1 ? "" : "s"} to double-check`
        : verification.verdict === "supported" ? "all claims supported by sources" : verification.verdict,
      detail: fcIssues ? "Flagged claims:\n- " + fcIssues.join("\n- ") : "" } });
  }
  if (used.length) write({ sources: used.map(([p, v]) => ({ name: v.name, path: p, score: v.score })).sort((a, b) => b.score - a.score) });
  write({ grounding: { mode: used.length ? "grounded" : (acc.searched ? "unsupported" : "general"), sources: used.length } });
  if (used.length && acc.evidence.length && allText.trim()) {
    const usedNames = new Set(used.map(([p, v]) => v.name));
    const ev = acc.evidence.filter(e => usedNames.has(e.source));
    const prov = buildProvenance(allText, ev.length ? ev : acc.evidence);
    if (prov.length) write({ provenance: prov });
  }
  if (verification) write({ verification });
}

/* Images visible in a chat, kept as raw refs on ctx until save_note actually embeds one — so
   pasted images don't get written to the KB on every turn, only when a note references them.
   Each entry is { name, path? } (already in the KB) or { name, dataUrl } (pasted/attached). */
function chatImageRefs(convoImages) {
  if (!Array.isArray(convoImages)) return [];
  return convoImages.slice(-12).filter(im => im && (im.path || (typeof im.dataUrl === "string" && /^data:image\//.test(im.dataUrl))));
}

// Resolve an image the user refers to across every source they might mean, in order:
// (1) an image attached/pasted into THIS chat (materialized to disk if it's still a data URL),
// (2) a file in the current KB/scope, (3) any access-checked path the user named ("anywhere").
// Used by image_tool (describe/exif) and create_instagram_post so both see chat attachments.
// ---- DrawThings image-generation helpers ----
// The endpoint/secret/default-model ride in on ctx.drawThings (set from the request body in
// server.js, sourced from the client's saved Settings — same path as the Ollama endpoint).
function dtSettings(ctx) {
  const d = ctx.drawThings || {};
  return { url: d.url || "http://localhost:7860", sharedSecret: d.secret || undefined, defaultModel: d.model || "" };
}
const DT_MODEL_EXT = /\.(ckpt|safetensors|pt|gguf)$/i;
// Resolve a model filename: explicit arg → saved default → discover from the server's file list.
async function dtPickModel(cfg, explicit) {
  if (explicit && String(explicit).trim()) return String(explicit).trim();
  if (cfg.defaultModel) return cfg.defaultModel;
  const echo = await dtEcho({ url: cfg.url, sharedSecret: cfg.sharedSecret });
  if (echo.sharedSecretMissing) throw new Error("Draw Things requires a shared secret — set it in Settings → Image generation.");
  const models = (echo.files || []).filter(f => DT_MODEL_EXT.test(f));
  if (!models.length) throw new Error("Draw Things is reachable but no base model was found. Set a model name in Settings → Image generation. Files the server reports: " + ((echo.files || []).slice(0, 15).join(", ") || "none"));
  return models[0];
}
// Save a generated PNG into <kb>/generated/ (browsable in the gallery); not auto-indexed (vision is slow).
// Shared with the direct /api/image routes via saveGeneratedImage (src/media/image-prompt.js).
const dtSaveImage = (ctx, png, label) => saveGeneratedImage(ctx.kbDir, png, label);
function dtImageRender(paths, title) {
  return [{ type: "images", title, items: paths.map(p => ({
    thumb: "/api/thumb?path=" + encodeURIComponent(p) + "&w=384",
    image: "/api/file?path=" + encodeURIComponent(p),
    url: "/api/file?path=" + encodeURIComponent(p),
    title: path.basename(p),
  })) }];
}

async function resolveImageRef(photoRef, ctx) {
  const ref = String(photoRef || "").trim();
  const refLc = ref.toLowerCase();
  const generic = !ref || /^(this|that|the|it|attached)\b/.test(refLc) || refLc === "photo" || refLc === "image" || refLc === "picture";
  const convo = ctx.convoImages || [];
  // 1) chat-attached/pasted images — by name, else (generic/blank ref) the most recent attachment
  if (convo.length) {
    let m = null;
    if (ref && !generic) m = convo.find(im => (im.name || "").toLowerCase() === refLc)
      || convo.find(im => { const n = (im.name || "").toLowerCase(); return n && (n.includes(refLc) || refLc.includes(n)); });
    if (!m && generic) m = convo[convo.length - 1];
    if (m) { const mat = materializeChatImage(ctx.kbDir, m); if (mat && isImageFile(mat.path)) return mat.path; }
  }
  // 2) the user's library / current scope
  const inScope = (ref && await findFileOnDisk(ctx, ref)) || (ref && (findIndexed(ctx, ref) || {}).path);
  if (inScope && isImageFile(inScope)) return inScope;
  // 3) an explicit path anywhere the user is allowed to read
  if (ref && (path.isAbsolute(ref) || ref.includes(path.sep) || ref.includes("/"))) {
    const p = path.resolve(ref);
    if (canAccessPath(ctx.user, p) && fs.existsSync(p) && isImageFile(p)) return p;
  }
  return null;
}
// materialize one chat image into <kb>/Uploads as a real file (deduped by content hash) for embedding
function materializeChatImage(kb, im) {
  try {
    if (im.path) { const p = path.resolve(String(im.path)); return fs.existsSync(p) ? { name: path.basename(p), path: p } : null; }
    const buf = Buffer.from(im.dataUrl.replace(/^data:[^,]*,/, ""), "base64");
    const hash = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 10);
    let base = safeName(im.name || "image");
    if (!/\.(png|jpe?g|gif|webp|bmp)$/i.test(base)) base += ".jpg";
    const ext = path.extname(base), stem = base.slice(0, base.length - ext.length) || "image";
    const dir = path.join(kb, "Uploads"), dest = path.join(dir, `${stem}-${hash}${ext}`);
    if (!fs.existsSync(dest)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dest, buf); }
    return { name: path.basename(dest), path: dest };
  } catch { return null; }
}


module.exports = {
  ensureIndex, findIndexed, findFileOnDisk, VERIFY_SYS, TOOL_REGISTRY,
  RETRIEVAL_TOOLS, ROSTER_DEFAULTS,
  agentToolDefs, agentToolMechanics, agentSys, execTool,
  makeThinkSplitter, streamReport, deepResearchPipeline, rosterFor,
  runAgentTurn, criticIsApproved, pickNextAgent, multiAgentPipeline,
  chatImageRefs, resolveImageRef, materializeChatImage,
};
