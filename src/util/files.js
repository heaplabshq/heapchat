/* File-kind helpers — extension → category/mime, plus size/date formatting and
   a filename sanitizer. Pure: no I/O, no shared state. */
const path = require("path");
const EXT = {
  photo: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "ico", "tif", "tiff"],
  video: ["mp4", "mov", "webm", "mkv", "avi", "m4v", "mpg", "mpeg", "wmv"],
  audio: ["mp3", "wav", "m4a", "flac", "aac", "ogg", "opus", "aiff"],
  doc: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "markdown",
        "csv", "rtf", "json", "xml", "yml", "yaml", "html", "htm", "css", "js", "jsx",
        "ts", "tsx", "py", "go", "rs", "java", "rb", "php", "sh", "c", "cpp", "h", "log"],
};
const TEXTLIKE = new Set([
  "txt", "md", "markdown", "csv", "json", "xml", "yml", "yaml", "html", "htm",
  "css", "js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "rb", "php", "sh",
  "c", "cpp", "h", "log", "rtf", "svg",
]);
const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml", avif: "image/avif",
  ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  m4v: "video/mp4", avi: "video/x-msvideo",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", flac: "audio/flac",
  aac: "audio/aac", ogg: "audio/ogg", opus: "audio/opus",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json",
  csv: "text/csv", html: "text/html", htm: "text/html", css: "text/css",
};

// image formats we can describe with the vision model (and treat as searchable)
const DESCRIBABLE_IMG = new Set(["jpg", "jpeg", "png", "gif", "webp", "bmp", "avif", "heic"]);

function extOf(name) { return (name.split(".").pop() || "").toLowerCase(); }
// accepts a filename, full path, or bare extension
function isImageFile(name) { return DESCRIBABLE_IMG.has(extOf(name)); }
function kindOf(name) {
  const e = extOf(name);
  for (const k of ["photo", "video", "audio", "doc"]) if (EXT[k].includes(e)) return k;
  return "doc";
}
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  const u = ["KB", "MB", "GB", "TB"];
  let n = bytes / 1024, i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + " " + u[i];
}
function fmtDate(ms) {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
// sanitize a user-supplied filename to a safe basename
function safeName(name) { return path.basename(name).replace(/[^\w.\-() ]+/g, "_").trim() || "file"; }

module.exports = { EXT, TEXTLIKE, MIME, DESCRIBABLE_IMG, extOf, kindOf, fmtSize, fmtDate, isImageFile, safeName };
