import { hashStr, palFor } from "./icons.jsx";
/* Leaf helpers for the app shell: clean-URL router, localStorage load helpers,
   path id/breadcrumb utilities. Extracted from app.jsx. Global-scope module
   (indirect-eval): all are top-level functions, so they leak to global for
   app.jsx (loaded last). No deps beyond browser globals. */

// ---- router (clean URLs): /, /chat, /settings, /manage, /kb, /folder?path=…, /file?path=… ----
function parseRoute() {
  const name = (location.pathname.replace(/^\/+/, "").split("/")[0]) || "";
  const params = new URLSearchParams(location.search);
  return { name, path: params.get("path") || "", session: params.get("s") || "" };
}

function loadRecents(key) {
  // items: { type: "folder" | "file", path, name }  (older entries had no type → folder)
  try {
    const arr = JSON.parse(localStorage.getItem(key)) || [];
    return arr.map(x => ({ type: x.type || "folder", path: x.path, name: x.name }));
  } catch { return []; }
}
function loadSavedSettings(key, base) {
  try { const s = JSON.parse(localStorage.getItem(key)); if (s) return { ...base, ...s }; } catch {}
  return { ...base };
}
// URL-safe base64 of a path (stable id for folder chat sessions)
function b64url(s) {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// short stable hash (djb2) — chat-session id for a multi-file selection
// base36 short hash for building ids. NOT named hashStr — icons.jsx defines a global `hashStr`
// (returns a number, used by palFor); a shared name across these global-scope scripts collides.
function shortHash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
// turn an absolute path into clickable breadcrumb segments
function pathCrumbs(p) {
  if (!p) return [];
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(sep).filter(Boolean);
  const out = [];
  let acc = sep === "/" ? "" : "";
  for (const part of parts) {
    acc = sep === "/" ? acc + "/" + part : (acc ? acc + sep + part : part);
    out.push({ name: part, path: acc });
  }
  return out;
}

export { parseRoute, loadRecents, loadSavedSettings, b64url, shortHash, pathCrumbs };
