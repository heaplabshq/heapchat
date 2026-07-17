// icons.jsx — refined line-icon set, palettes, and shared helpers (from the Heap Chat design)

function Icon({ name, size = 18, sw = 1.7, style }) {
  const p = { fill: "none", stroke: "currentColor", strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round" };
  const P = {
    folder: <path {...p} d="M3 6.5C3 5.7 3.6 5 4.5 5h4l1.8 2H19.5c.8 0 1.5.7 1.5 1.5V17.5c0 .8-.7 1.5-1.5 1.5h-15C3.7 19 3 18.3 3 17.5z"/>,
    folderOpen: <><path {...p} d="M3 6.5C3 5.7 3.6 5 4.5 5h4l1.8 2H19c.8 0 1.5.7 1.5 1.5V10"/><path {...p} d="M3 10h17.2c1 0 1.7.9 1.5 1.9l-1.2 6c-.15.7-.8 1.1-1.5 1.1H4.5C3.7 19 3 18.3 3 17.5z"/></>,
    image: <><rect {...p} x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle {...p} cx="9" cy="9.5" r="1.7"/><path {...p} d="M4.5 17.5 9.5 12l3.5 3 3-2.5 4 4"/></>,
    file: <><path {...p} d="M6.5 3.5h7l5 5v12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z"/><path {...p} d="M13.5 3.5v5h5M9 13.5h6M9 16.5h4"/></>,
    video: <><rect {...p} x="3" y="5.5" width="14" height="13" rx="2.5"/><path {...p} d="M17 10 21 7.5v9L17 14"/></>,
    music: <><path {...p} d="M9 17.5V6.5l9-2v9"/><circle {...p} cx="6.5" cy="17.5" r="2.5"/><circle {...p} cx="15.5" cy="13.5" r="2.5"/></>,
    search: <><circle {...p} cx="11" cy="11" r="6.5"/><path {...p} d="m20.5 20.5-4.2-4.2"/></>,
    globe: <><circle {...p} cx="12" cy="12" r="8.5"/><path {...p} d="M3.5 12h17"/><path {...p} d="M12 3.5c2.6 2.4 2.6 14.6 0 17.1M12 3.5c-2.6 2.4-2.6 14.6 0 17.1"/></>,
    compass: <><circle {...p} cx="12" cy="12" r="8.5"/><path {...p} d="m15.6 8.4-2.1 5.1-5.1 2.1 2.1-5.1z"/></>,
    flask: <><path {...p} d="M9.5 3.5h5M10.5 3.5v5.5L6 17.5a1.6 1.6 0 0 0 1.4 2.4h9.2a1.6 1.6 0 0 0 1.4-2.4L13.5 9V3.5"/><path {...p} d="M7.7 14.5h8.6"/></>,
    settings: <><circle {...p} cx="12" cy="12" r="3"/><path {...p} d="M12 2.5v2.5M12 19v2.5M21.5 12H19M5 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1 5.3 5.3"/></>,
    send: <><path {...p} d="M5 12 19.5 5.5 14 20l-2.7-6.3L5 12z"/></>,
    sparkles: <><path {...p} d="M12 3.5 13.6 9 19 10.6 13.6 12.2 12 17.5 10.4 12.2 5 10.6 10.4 9z"/><path {...p} d="M18.5 4v3M20 5.5h-3"/></>,
    chevR: <path {...p} d="m9.5 6 6 6-6 6"/>,
    chevD: <path {...p} d="m6 9.5 6 6 6-6"/>,
    chevL: <path {...p} d="m14.5 6-6 6 6 6"/>,
    arrowL: <><path {...p} d="M19 12H5M11 18l-6-6 6-6"/></>,
    grid: <><rect {...p} x="4" y="4" width="7" height="7" rx="1.8"/><rect {...p} x="13" y="4" width="7" height="7" rx="1.8"/><rect {...p} x="4" y="13" width="7" height="7" rx="1.8"/><rect {...p} x="13" y="13" width="7" height="7" rx="1.8"/></>,
    plus: <path {...p} d="M12 5v14M5 12h14"/>,
    x: <path {...p} d="M6 6l12 12M18 6 6 18"/>,
    star: <path {...p} d="m12 4 2.4 5.2 5.6.5-4.2 3.8 1.2 5.5L12 16.7 6.9 19.5l1.2-5.5L4 10.7l5.6-.5z"/>,
    more: <><circle {...p} cx="5" cy="12" r="1.4"/><circle {...p} cx="12" cy="12" r="1.4"/><circle {...p} cx="19" cy="12" r="1.4"/></>,
    upload: <><path {...p} d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 20h15"/></>,
    bolt: <path {...p} d="M13 3 5.5 13H11l-.8 8 7.8-10.5H12z"/>,
    info: <><circle {...p} cx="12" cy="12" r="9"/><path {...p} d="M12 11v5.5M12 7.6h.01"/></>,
    check: <path {...p} d="m5 12.5 4.5 4.5L19 7"/>,
    sliders: <><path {...p} d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle {...p} cx="16" cy="7" r="2.2" fill="var(--surface)"/><circle {...p} cx="8" cy="17" r="2.2" fill="var(--surface)"/></>,
    brain: <><path {...p} d="M9 6a2.5 2.5 0 0 0-2.5 2.5c-1.3.3-2 1.4-2 2.6 0 .9.4 1.6 1 2.1-.3.5-.5 1-.5 1.6A2.7 2.7 0 0 0 8 17.5c.3 1 1.2 1.7 2.3 1.7.7 0 .9-.3.9-.9V6.4C11.2 5.6 10.6 5 9.8 5 9.5 5 9.2 5.4 9 6z"/><path {...p} d="M15 6a2.5 2.5 0 0 1 2.5 2.5c1.3.3 2 1.4 2 2.6 0 .9-.4 1.6-1 2.1.3.5.5 1 .5 1.6a2.7 2.7 0 0 1-3 2.7c-.3 1-1.2 1.7-2.3 1.7-.7 0-.9-.3-.9-.9V6.4C12.8 5.6 13.4 5 14.2 5c.3 0 .6.4.8 1z"/></>,
    clock: <><circle {...p} cx="12" cy="12" r="8.5"/><path {...p} d="M12 7.5V12l3 2"/></>,
    ruler: <><rect {...p} x="3" y="8" width="18" height="8" rx="1.5"/><path {...p} d="M7 8v3M11 8v4M15 8v3M19 8v4"/></>,
    calendar: <><rect {...p} x="3.5" y="5" width="17" height="15" rx="2.5"/><path {...p} d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/></>,
    play: <path d="M8 5.5v13l11-6.5z" fill="currentColor"/>,
    layers: <><path {...p} d="M12 3 3 8l9 5 9-5z"/><path {...p} d="M3 13l9 5 9-5"/></>,
    download: <><path {...p} d="M12 4v11m0 0 4-4m-4 4-4-4M5 19.5h14"/></>,
    text: <><path {...p} d="M5 6.5h14M5 12h14M5 17.5h9"/></>,
    type: <><path {...p} d="M6 7V5.5h12V7M12 5.5v13M9.5 18.5h5"/></>,
    tag: <><path {...p} d="M3.5 11.5 11 4h6.5v6.5L10 18z"/><circle {...p} cx="14.5" cy="7.5" r="1"/></>,
    home: <><path {...p} d="M4 10.5 12 4l8 6.5"/><path {...p} d="M6 9.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5"/></>,
    refresh: <><path {...p} d="M20 11a8 8 0 0 0-14-4.5L4 8"/><path {...p} d="M4 4v4h4"/><path {...p} d="M4 13a8 8 0 0 0 14 4.5L20 16"/><path {...p} d="M20 20v-4h-4"/></>,
    alert: <><path {...p} d="M12 4 2.5 20h19z"/><path {...p} d="M12 10v4.5M12 17.5h.01"/></>,
    copy: <><rect {...p} x="9" y="9" width="11" height="11" rx="2"/><path {...p} d="M5 15V5.5A1.5 1.5 0 0 1 6.5 4H15"/></>,
    edit: <><path {...p} d="M4 20h4L18.5 9.5a2 2 0 0 0-2.83-2.83L5 17z"/><path {...p} d="M13.5 7.5l3 3"/></>,
  };
  return <span className="gi" style={{ width: size, height: size, ...style }}><svg width={size} height={size} viewBox="0 0 24 24">{P[name] || P.file}</svg></span>;
}

/* ---------------- mesh gradient palettes (used for non-image thumbs) ---------------- */
const PAL = {
  sunset:  { bg: `radial-gradient(at 18% 22%, #ffd166 0, transparent 50%), radial-gradient(at 82% 12%, #ff7aa2 0, transparent 50%), radial-gradient(at 72% 84%, #7b4bd6 0, transparent 52%), radial-gradient(at 8% 88%, #ff5e62 0, transparent 50%), #ff8a5c` },
  ocean:   { bg: `radial-gradient(at 20% 20%, #5ee7df 0, transparent 50%), radial-gradient(at 80% 18%, #2b86c5 0, transparent 52%), radial-gradient(at 75% 85%, #0b3d91 0, transparent 55%), radial-gradient(at 12% 80%, #36d1dc 0, transparent 50%), #176a8a` },
  forest:  { bg: `radial-gradient(at 22% 18%, #a8e063 0, transparent 50%), radial-gradient(at 80% 22%, #2bb673 0, transparent 52%), radial-gradient(at 70% 82%, #0b6e4f 0, transparent 55%), radial-gradient(at 14% 86%, #56ab2f 0, transparent 50%), #1f8f5f` },
  dusk:    { bg: `radial-gradient(at 18% 20%, #c471f5 0, transparent 50%), radial-gradient(at 82% 16%, #6a5af9 0, transparent 52%), radial-gradient(at 74% 84%, #2b1b6b 0, transparent 55%), radial-gradient(at 10% 86%, #fa71cd 0, transparent 50%), #5b3aa6` },
  desert:  { bg: `radial-gradient(at 20% 22%, #ffe29a 0, transparent 50%), radial-gradient(at 80% 16%, #f6a667 0, transparent 52%), radial-gradient(at 72% 84%, #a64b2a 0, transparent 55%), radial-gradient(at 12% 84%, #e9a33b 0, transparent 50%), #cf7e3f` },
  mono:    { bg: `radial-gradient(at 22% 20%, #eef1f5 0, transparent 50%), radial-gradient(at 80% 18%, #aab3c0 0, transparent 52%), radial-gradient(at 72% 84%, #3a434f 0, transparent 55%), radial-gradient(at 12% 86%, #cbd2db 0, transparent 50%), #6b7480` },
  rose:    { bg: `radial-gradient(at 20% 22%, #ffd3e0 0, transparent 50%), radial-gradient(at 80% 16%, #ff7eb3 0, transparent 52%), radial-gradient(at 72% 84%, #b5179e 0, transparent 55%), radial-gradient(at 12% 86%, #ff9a8b 0, transparent 50%), #e4578f` },
  arctic:  { bg: `radial-gradient(at 22% 20%, #ffffff 0, transparent 50%), radial-gradient(at 80% 18%, #8ed6ff 0, transparent 52%), radial-gradient(at 72% 84%, #3a7bd5 0, transparent 55%), radial-gradient(at 12% 86%, #d7f0ff 0, transparent 50%), #6cb8e8` },
  ember:   { bg: `radial-gradient(at 22% 20%, #ffb347 0, transparent 50%), radial-gradient(at 80% 16%, #ff5e3a 0, transparent 52%), radial-gradient(at 72% 84%, #2b0a0a 0, transparent 58%), radial-gradient(at 12% 86%, #ff3c00 0, transparent 50%), #a32b16` },
  meadow:  { bg: `radial-gradient(at 22% 20%, #f9f871 0, transparent 50%), radial-gradient(at 80% 18%, #4dd0a0 0, transparent 52%), radial-gradient(at 72% 84%, #167d7f 0, transparent 55%), radial-gradient(at 12% 86%, #b6e388 0, transparent 50%), #3aa17e` },
};
const PAL_KEYS = Object.keys(PAL);
function hashStr(s) { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; }
function palFor(seed) { return PAL_KEYS[hashStr(seed || "x") % PAL_KEYS.length]; }
function photoStyle(pal) { return { background: PAL[pal]?.bg || PAL.ocean.bg }; }

/* ---------------- doc type colors ---------------- */
const DOC = {
  pdf:  { c: "#d8412f", soft: "#fdecea" },
  doc:  { c: "#2b6cd9", soft: "#e9f0fd" }, docx: { c: "#2b6cd9", soft: "#e9f0fd" },
  xls:  { c: "#1e8a5b", soft: "#e4f3ec" }, xlsx: { c: "#1e8a5b", soft: "#e4f3ec" }, csv: { c: "#1e8a5b", soft: "#e4f3ec" },
  ppt:  { c: "#d97a1e", soft: "#fbeede" }, pptx: { c: "#d97a1e", soft: "#fbeede" },
  txt:  { c: "#58626f", soft: "#eef0f5" }, md: { c: "#58626f", soft: "#eef0f5" },
  json: { c: "#b4541b", soft: "#fbeee4" },
};
function docMeta(ext) { return DOC[ext] || { c: "#7a4bd6", soft: "#efe9fc" }; }

const KIND_META = {
  photo: { label: "Images", icon: "image", c: "#2b6cd9", soft: "#e9f0fd" },
  doc:   { label: "Documents", icon: "file", c: "#7a4bd6", soft: "#efe9fc" },
  video: { label: "Video", icon: "video", c: "#d8412f", soft: "#fdecea" },
  audio: { label: "Audio", icon: "music", c: "#1e8a5b", soft: "#e4f3ec" },
};

/* deterministic pseudo-random bar heights for audio waveforms */
function waveHeights(seed, n = 34) {
  let x = 0; for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) % 9973;
  const out = [];
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) % 2147483648; out.push(22 + (x % 78)); }
  return out;
}

/* starter follow-up suggestions per kind */
function suggestionsFor(kind) {
  const base = {
    photo: ["What's in this image?", "Suggest a caption", "Describe the lighting", "What stands out?"],
    doc: ["Summarize this", "Pull key points", "List action items", "Draft an email about it"],
    video: ["What is this video about?", "Suggest a description", "Key moments?", "Draft a caption"],
    audio: ["What is this recording?", "Summarize it", "Suggest a title", "Who might be speaking?"],
  };
  return base[kind] || base.doc;
}

function fileUrl(p) { return "/api/file?path=" + encodeURIComponent(p); }
function thumbUrl(p, w = 480) { return "/api/thumb?path=" + encodeURIComponent(p) + "&w=" + w; }

// download any JSON-serializable object as a .json file (agent/chat export, etc.)
function downloadJSON(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const safe = (filename || "export").replace(/[^\w.\- ]+/g, "_");
  const a = document.createElement("a"); a.href = url; a.download = safe.endsWith(".json") ? safe : safe + ".json"; a.click();
  URL.revokeObjectURL(url);
}

// derive a file kind from just a name (used where we only have the filename, e.g. recents)
const KIND_EXT = {
  photo: ["jpg","jpeg","png","gif","webp","bmp","svg","avif","ico","tif","tiff"],
  video: ["mp4","mov","webm","mkv","avi","m4v","mpg","mpeg","wmv"],
  audio: ["mp3","wav","m4a","flac","aac","ogg","opus","aiff"],
};
function kindFromName(name) {
  const e = (name.split(".").pop() || "").toLowerCase();
  for (const k of ["photo", "video", "audio"]) if (KIND_EXT[k].includes(e)) return k;
  return "doc";
}

export {
  Icon, PAL, palFor, photoStyle, DOC, docMeta, KIND_META, waveHeights, suggestionsFor, hashStr, fileUrl, kindFromName, thumbUrl, downloadJSON,
};
