import { relTime } from "./chats.jsx";
/* Chat data layer: id/serialization helpers + the ChatAPI fetch wrapper for the
   server-side chat store (data/chats.json). Extracted from chat.jsx. Global-scope
   module (indirect-eval): the helper functions leak to global automatically;
   ChatAPI is a const, so it's pinned onto window explicitly — app.jsx / chats.jsx
   / projects.jsx (all loaded after chat) reference it by bare name. */

function newId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "s" + Date.now() + Math.random().toString(16).slice(2);
}
// cap attached images (longest side / JPEG) so persisted chats and vision payloads stay small
function shrinkImage(dataUrl, cb, maxDim = 1568) {
  const im = new Image();
  im.onload = () => {
    const scale = Math.min(1, maxDim / Math.max(im.width, im.height));
    if (scale >= 1) return cb(dataUrl);
    const c = document.createElement("canvas");
    c.width = Math.round(im.width * scale); c.height = Math.round(im.height * scale);
    c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
    cb(c.toDataURL("image/jpeg", 0.85));
  };
  im.onerror = () => cb(dataUrl);
  im.src = dataUrl;
}
function serialize(msgs) {
  return msgs.filter(m => !m.streaming).map(m => m.role === "user"
    ? { role: "user", text: m.text, images: (m.images && m.images.length) ? m.images : undefined, image: m.image || undefined, imageName: m.imageName || undefined, attachments: (m.attachments && m.attachments.length) ? m.attachments : undefined, attachFiles: (m.attachFiles && m.attachFiles.length) ? m.attachFiles : undefined }
    : { role: "ai", text: m.text || "", thinking: m.thinking || undefined, secs: m.secs, sources: m.sources || undefined, steps: m.steps || undefined, timeline: m.timeline || undefined, renders: m.renders || undefined, grounding: m.grounding || undefined, provenance: m.provenance || undefined, verification: m.verification || undefined, pendingAction: m.pendingAction || undefined, error: m.error || undefined, errMsg: m.errMsg })
    .slice(-200);
}
function titleFrom(msgs) {
  const u = msgs.find(m => m.role === "user" && m.text);
  return u ? u.text.slice(0, 60) : "New chat";
}
// NOTE: named relTimeAgo, not relTime — chats.jsx defines its own global `relTime`; in these
// shared-scope scripts a duplicate name lets whichever loads last silently win.
function relTimeAgo(ms) {
  const d = Date.now() - ms, m = 60000, h = 3600000, day = 86400000;
  if (d < m) return "just now";
  if (d < h) return Math.floor(d / m) + "m ago";
  if (d < day) return Math.floor(d / h) + "h ago";
  if (d < 7 * day) return Math.floor(d / day) + "d ago";
  return new Date(ms).toLocaleDateString();
}
const ChatAPI = {
  all:  q => fetch("/api/chats" + (q ? "?q=" + encodeURIComponent(q) : "")).then(r => r.json()).then(j => j.sessions || []).catch(() => []),
  list: fid => fetch(`/api/chats/${fid}`).then(r => r.json()).then(j => j.sessions || []).catch(() => []),
  get:  (fid, sid) => fetch(`/api/chats/${fid}/${sid}`).then(r => r.ok ? r.json() : null).catch(() => null),
  save: (fid, sid, title, messages, source, autoMemory, projectId, agentId) => fetch(`/api/chats/${fid}/${sid}`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, messages, source, autoMemory, projectId: projectId || undefined, agentId: agentId || null }),
  }).then(r => r.ok ? r.json() : null).catch(() => null),
  patch: (fid, sid, body) => fetch(`/api/chats/${fid}/${sid}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then(r => r.ok ? r.json() : null).catch(() => null),
  del:  (fid, sid) => fetch(`/api/chats/${fid}/${sid}`, { method: "DELETE" }).catch(() => {}),
};
export { serialize, ChatAPI, newId, titleFrom, shrinkImage, relTimeAgo };
