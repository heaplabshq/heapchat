/* Web search (DuckDuckGo, keyless — opt-in, the only outbound calls besides connectors).
   Self-contained: uses global fetch/AbortSignal, no shared app state. */

const DDG_HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36", "Accept-Language": "en-US,en;q=0.9" };
function decodeEntities(s) { return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " "); }
function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()); }
function ddgRealUrl(href) { const m = String(href).match(/[?&]uddg=([^&]+)/); if (m) { try { return decodeURIComponent(m[1]); } catch {} } return href.startsWith("//") ? "https:" + href : href; }
// fetch with a timeout that turns failures into clear, distinguishable errors (rate-limit, blocked,
// timeout, network) instead of silently yielding an empty/garbage body.
async function ddgFetch(url, { timeout = 12000, headers } = {}) {
  let r;
  try { r = await fetch(url, { headers: headers || DDG_HEADERS, signal: AbortSignal.timeout(timeout) }); }
  catch (e) { throw new Error(e.name === "TimeoutError" ? "the web search timed out" : "couldn't reach DuckDuckGo (network error)"); }
  if (r.status === 429 || r.status === 202) throw new Error("DuckDuckGo is rate-limiting requests right now — wait a moment and try again");
  if (!r.ok) throw new Error(`DuckDuckGo returned HTTP ${r.status}`);
  return r;
}
// retry once or twice on transient failures (rate-limit / timeout / network), with backoff
async function withRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i === tries - 1 || !/rate-limit|timed out|network/i.test(e.message)) throw e;
      await new Promise(res => setTimeout(res, 1200 * (i + 1)));
    }
  }
  throw last;
}
async function ddgText(query) {
  return withRetry(async () => {
    const r = await ddgFetch("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query));
    const html = await r.text();
    const snippets = []; const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g; let sm;
    while ((sm = snipRe.exec(html))) snippets.push(stripTags(sm[1]));
    const out = []; const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m, j = 0;
    while ((m = re.exec(html)) && out.length < 8) {
      const url = ddgRealUrl(m[1]); const snip = snippets[j] || ""; j++;
      if (/duckduckgo\.com\/y\.js|[?&]ad_domain=/.test(url)) continue;   // skip sponsored results
      out.push({ title: stripTags(m[2]), url, snippet: snip });
    }
    // a 200 with no results + bot-challenge markers = blocked, not "no results found"
    if (!out.length && /anomaly|unusual traffic|challenge-form|are you a robot|blocked/i.test(html)) throw new Error("DuckDuckGo blocked the request (bot detection) — try again shortly");
    return out;
  });
}
// strip a web page down to readable text (no deps — good enough for the agent to read)
function mainContentHtml(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(nav|header|footer|aside|svg|form|noscript)\b[\s\S]*?<\/\1>/gi, "");
  const main = html.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i);
  return main ? main[2] : html;
}
function htmlToText(html) {
  html = mainContentHtml(html).replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, "\n");
  const text = decodeEntities(html.replace(/<[^>]+>/g, " "));
  return text.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
// fetch a page and return its readable text (used by read_url and deep research)
async function fetchPageText(url) {
  try {
    const r = await fetch(url, { headers: DDG_HEADERS, redirect: "follow", signal: AbortSignal.timeout(15000) });
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !/text\/html|text\/plain|xhtml/i.test(ct)) return "";
    return htmlToText(await r.text());
  } catch { return ""; }
}
// pull the meaningful images out of a page's HTML, resolved to absolute URLs.
// used by read_url so a scraped page surfaces its pictures, not just its text.
function extractImages(rawHtml, baseUrl) {
  const html = mainContentHtml(rawHtml);
  let base = baseUrl;
  const bm = html.match(/<base\b[^>]*\bhref=["']([^"']+)["']/i);
  if (bm) { try { base = new URL(bm[1], baseUrl).href; } catch {} }
  const abs = (u) => { try { return new URL(decodeEntities(u.trim()), base).href; } catch { return null; } };
  // srcset -> pick the highest-resolution candidate
  const fromSrcset = (ss) => {
    const cands = ss.split(",").map(s => s.trim().split(/\s+/)).filter(a => a[0]);
    if (!cands.length) return null;
    cands.sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0));
    return cands[0][0];
  };
  const skip = (u) => !u || /^data:/i.test(u) || /\.svg(\?|#|$)/i.test(u)
    || /sprite|spacer|pixel|1x1|blank\.gif|tracking|beacon|logo|icon|avatar|badge|thumb|banner|advert|\bad[-_]/i.test(u);
  // "related articles" / "you might also like" widgets are near-universally marked with one of
  // these words on a wrapping element — sniff the HTML just before the <img> for them.
  const widgetNearby = (beforeCtx) => /class=["'][^"']*\b(related|recommend|trending|popular|widget|promo|sponsor|share|social|comment|carousel|slider|outbrain|taboola|also-read|read-more|more-from|newsletter|sidebar|teaser|module|feature[d]?|subscribe|cta|gallery-nav|thumb)/i.test(beforeCtx);
  // classic IAB ad-unit pixel dimensions — if an image matches one exactly, it's an ad, not content.
  const AD_SIZES = new Set(["728x90", "300x250", "320x50", "160x600", "300x600", "970x250", "320x100", "300x50", "336x280", "970x90", "250x250", "200x200", "468x60", "234x60", "120x600", "580x400"]);
  const out = []; const seen = new Set();
  const add = (u, title) => { const a = abs(u); if (!a || skip(a) || seen.has(a)) return; seen.add(a); out.push({ image: a, thumb: a, url: a, title: title || "", source: (() => { try { return new URL(base).hostname; } catch { return ""; } })() }); };
  // prefer the social preview image first
  const og = html.match(/<meta\b[^>]*(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*\bcontent=["']([^"']+)["']/i)
    || html.match(/<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  if (og) add(og[1], "Preview image");
  // first pass: collect candidates (skip lazy-load placeholders by preferring data-src / srcset when present)
  const candidates = [];
  const imgRe = /<img\b([^>]*)>/gi; let im;
  while ((im = imgRe.exec(html)) && candidates.length < 60) {
    const attrs = im[1];
    const alt = (attrs.match(/\balt=["']([^"']*)["']/i) || [])[1] || "";
    const w = parseInt((attrs.match(/\bwidth=["']?(\d+)/i) || [])[1] || "0", 10);
    const h = parseInt((attrs.match(/\bheight=["']?(\d+)/i) || [])[1] || "0", 10);
    if ((w && w < 200) || (h && h < 200)) continue;   // drop icons/thumbnails/spacers
    if (w && h && AD_SIZES.has(`${w}x${h}`)) continue;   // drop standard ad-unit dimensions
    if (widgetNearby(html.slice(Math.max(0, im.index - 500), im.index))) continue;   // drop related/promo widgets
    const ss = (attrs.match(/\bsrcset=["']([^"']+)["']/i) || [])[1];
    const src = (attrs.match(/\bdata-src=["']([^"']+)["']/i) || [])[1]
      || (ss && fromSrcset(ss))
      || (attrs.match(/\bsrc=["']([^"']+)["']/i) || [])[1];
    if (src) candidates.push({ src, alt, w, h });
  }
  // second pass: a (width,height) pair repeated 2+ times is almost always a thumbnail
  // grid/carousel (related posts, product tiles) rather than distinct editorial images — drop the group.
  const sizeCounts = new Map();
  for (const c of candidates) if (c.w && c.h) { const k = `${c.w}x${c.h}`; sizeCounts.set(k, (sizeCounts.get(k) || 0) + 1); }
  for (const c of candidates) {
    if (c.w && c.h && sizeCounts.get(`${c.w}x${c.h}`) >= 2) continue;
    if (!c.alt.trim()) continue;   // no alt text is a strong signal of decorative/ad content, not an editorial photo
    add(c.src, c.alt);
    if (out.length >= 5) break;
  }
  return out;
}
async function ddgImages(query) {
  return withRetry(async () => {
    const tok = await ddgFetch("https://duckduckgo.com/?q=" + encodeURIComponent(query) + "&iax=images&ia=images");
    const html = await tok.text();
    const m = html.match(/vqd=["']?([0-9-]+)["']?/); const vqd = m && m[1];
    if (!vqd) throw new Error("DuckDuckGo blocked the image search — try again shortly");
    const r = await ddgFetch(`https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,&p=1`, { headers: { ...DDG_HEADERS, "Referer": "https://duckduckgo.com/" } });
    const j = await r.json().catch(() => ({}));
    return (j.results || []).map(x => ({ title: x.title, image: x.image, thumbnail: x.thumbnail, url: x.url, source: x.source }));
  });
}

module.exports = { DDG_HEADERS, decodeEntities, stripTags, ddgRealUrl, ddgFetch, withRetry, ddgText, htmlToText, extractImages, fetchPageText, ddgImages };
