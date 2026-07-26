import { serialize, ChatAPI, newId, titleFrom, shrinkImage, relTimeAgo } from "./chat-data.jsx";
import { relTime } from "./chats.jsx";
import { fmt, linkifyCites, wrapProvenance, enhanceRich, ProvText } from "./markdown.jsx";
import { Reasoning, GroundingBadge, ApprovalCard } from "./chat-cards.jsx";
import { useChatModes, useAutoScroll } from "./chat-hooks.jsx";
import { suggestionsFor, Icon } from "./icons.jsx";
import { scopeLabel } from "./activity.jsx";
import { Thumb } from "./gallery.jsx";
import { ChatMessage } from "./chat-message.jsx";
import { Composer } from "./composer.jsx";
import { ImageEditModal } from "./image-edit.jsx";
import { ChatLightbox } from "./renders.jsx";
// chat.jsx — chat panel scoped to a single file OR a whole folder (RAG).
// Multiple chat sessions per target, persisted server-side (data/chats.json).
const { useState, useEffect, useRef } = React;
// id/serialize/relTime helpers + ChatAPI live in chat-data.jsx (loaded first).

const MAX_ATTACH_IMGS = 5;   // how many images can ride on one message
const FOLDER_SUGGESTIONS = ["Summarize this folder", "What are the key topics?", "Which files mention the budget?", "List any action items"];
const GENERAL_SUGGESTIONS = ["Explain a concept", "Draft an email", "Brainstorm ideas", "Write some code"];
const AGENT_SUGGESTIONS = ["What's in my knowledge base?", "Summarize all my documents", "Compare two of my files", "Find anything about budgets"];

// markdown / math / mermaid rendering (fmt, linkifyCites, wrapProvenance,
// enhanceRich, ProvText, …) lives in markdown.jsx — used here as globals.
// Reasoning / GroundingBadge / ApprovalCard message sub-components live in chat-cards.jsx (loaded first).

// target: { scope:"file"|"folder"|"general", id, name, path?, kind?, file? }
function ChatPanel({ target, settings, online, onClose, onOpenPath, variant, models = [], width, onResize, onControls, initialSessionId, agents = [], initialAgentId = null, onNewAgent }) {
  function startResize(e) {
    e.preventDefault();
    const move = ev => onResize && onResize(window.innerWidth - ev.clientX);
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); document.body.style.userSelect = ""; };
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  }
  const isFolder = target.scope === "folder";
  const isGeneral = target.scope === "general";
  const isAssistant = target.scope === "assistant";
  const isAgent = target.scope === "agent";
  const isPlain = isGeneral || isAssistant || isAgent;   // no thumb, sparkles icon
  const {
    thinkOn, setThinkOn, webOn, setWebOn, researchOn, setResearchOn, deepOn, setDeepOn,
    deepWorkOn, setDeepWorkOn, factCheckOn, setFactCheckOn, useFilesOn, setUseFilesOn, useMemoryOn, setUseMemoryOn,
  } = useChatModes(settings);
  const [msgs, setMsgs] = useState([]);
  const [ctxInfo, setCtxInfo] = useState(null);   // real context usage from the server: { used, max } tokens
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [histOpen, setHistOpen] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [modelOverride, setModelOverride] = useState(null);   // per-chat model choice
  const [attachImgs, setAttachImgs] = useState([]);           // attached images (data URLs) for vision / agent, up to MAX_ATTACH_IMGS
  const [files, setFiles] = useState([]);                     // uploaded file attachments [{name, path, uploading}]
  const [plusOpen, setPlusOpen] = useState(false);            // "+" attach + mode menu
  const [modelOpen, setModelOpen] = useState(false);
  const imgInRef = useRef(null), filesInRef = useRef(null), dirInRef = useRef(null);
  const [dragActive, setDragActive] = useState(false);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const [imgEdit, setImgEdit] = useState(null);   // { src, path?, dataUrl? } open in the Edit-with-AI modal
  const [chatZoom, setChatZoom] = useState(null);   // { items, index } open in the in-app image zoom viewer (renders + attached prompt images)
  const taRef = useRef(null);
  const abortRef = useRef(null);
  const targetIdRef = useRef(target.id);
  const sessionIdRef = useRef(null);
  // which custom agent drives this conversation (null = built-in default agent). Only meaningful for the main agent chat.
  const [agentId, setAgentId] = useState(initialAgentId);
  const agentIdRef = useRef(initialAgentId);
  function applyAgent(id) { agentIdRef.current = id || null; setAgentId(id || null); }

  function greeting() {
    const agentDomain = target.domain === "file" ? `**${target.name}**`
      : target.domain === "folder" ? `the folder **${target.name}**`
      : target.domain === "selection" ? `the **${target.name}**`
      : "your knowledge base";
    const text = isAgent
      ? (target.domain === "kb"
        ? `Hi — I'm the Heap Chat **agent**. Ask me anything: I'll answer directly, and search your **knowledge base** when it helps — showing each step.`
        : `Hi — I'm the Heap Chat **agent**. I can search, list, and read ${agentDomain} step by step to answer, and you'll see each step as I work.`)
      : isAssistant
      ? `Hi — I'm Heap Chat. Ask me anything. I'll draw on your **knowledge base** when it's relevant and cite the sources.`
      : isGeneral
      ? `Hi — I'm Heap Chat. Ask me anything.`
      : isFolder
      ? `Hi — ask me anything about everything in **${target.name}**. I search it and answer with citations to the source files.`
      : `Hi — ask me anything about **${target.name}**. I can summarize it, pull out details, or suggest what to do next.`;
    const chips = isAgent ? AGENT_SUGGESTIONS : isPlain ? GENERAL_SUGGESTIONS : isFolder ? FOLDER_SUGGESTIONS : suggestionsFor(target.kind);
    return [{ role: "ai", text, chips }];
  }
  function startFresh(sid) {
    sid = sid || newId();
    sessionIdRef.current = sid; setSessionId(sid);
    applyAgent(initialAgentId);   // a fresh chat starts from this panel's default agent
    setMsgs(greeting());
  }

  useEffect(() => {
    let alive = true;
    targetIdRef.current = target.id;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setVal(""); setBusy(false); setHistOpen(false); setMsgs(greeting());
    (async () => {
      const list = await ChatAPI.list(target.id);
      if (!alive || targetIdRef.current !== target.id) return;
      setSessions(list);
      if (initialSessionId === "__new__") { startFresh(); return; }   // "New chat" → blank session
      // a specific session was requested (URL / hub): open it, or start a blank chat under that id if it isn't saved yet
      if (initialSessionId) {
        const full = await ChatAPI.get(target.id, initialSessionId);
        if (!alive || targetIdRef.current !== target.id) return;
        if (full && full.messages && full.messages.length) { sessionIdRef.current = full.id; setSessionId(full.id); applyAgent(full.agentId || initialAgentId); setMsgs(full.messages); return; }
        startFresh(initialSessionId);   // requested id not persisted (new chat) → keep the id so it survives reload
        return;
      }
      // no session requested → resume the most recent, else a fresh chat
      const want = list[0] && list[0].id;
      if (want) {
        const full = await ChatAPI.get(target.id, want);
        if (!alive || targetIdRef.current !== target.id) return;
        if (full && full.messages && full.messages.length) {
          sessionIdRef.current = full.id; setSessionId(full.id);
          applyAgent(full.agentId || initialAgentId);
          setMsgs(full.messages);
          return;
        }
      }
      startFresh();
    })();
    return () => { alive = false; };
  }, [target.id]);   // initialSessionId read at mount only (clearing it must not reload)

  // auto-scroll: pin to bottom as content streams, unless the user scrolled up to read.
  const { scrollRef, atBottomRef, showJump, onChatScroll, jumpToLatest } = useAutoScroll(msgs, busy);

  // expose controls so the parent can host them (main chat puts them in the top bar)
  useEffect(() => {
    if (onControls) onControls({ sessions, sessionId, busy, msgCount: msgs.length, newChat, exportChat, switchSession, deleteSession, send });
  }, [onControls, sessions, sessionId, busy, msgs.length]);

  function persist(curMsgs) {
    const fid = targetIdRef.current, sid = sessionIdRef.current;
    const ser = serialize(curMsgs);
    if (!sid || !ser.some(m => m.role === "user")) return;
    const source = { scope: target.scope, domain: target.domain || null, name: target.name || null, path: target.path || null, id: target.id };
    ChatAPI.save(fid, sid, titleFrom(ser), ser, source, settings.autoMemory !== false, target.projectId || null, agentIdRef.current || null).then(sum => {
      if (sum && targetIdRef.current === fid) setSessions(prev => [sum, ...prev.filter(s => s.id !== sum.id)]);
    });
  }

  function newChat() {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setVal(""); setBusy(false); setHistOpen(false);
    startFresh();
  }

  async function switchSession(sid) {
    setHistOpen(false);
    if (sid === sessionIdRef.current) return;
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setBusy(false);
    const full = await ChatAPI.get(target.id, sid);
    if (targetIdRef.current !== target.id) return;
    sessionIdRef.current = sid; setSessionId(sid);
    applyAgent((full && full.agentId) || initialAgentId);
    setMsgs(full && full.messages && full.messages.length ? full.messages : greeting());
  }

  async function deleteSession(sid, e) {
    e.stopPropagation();
    await ChatAPI.del(target.id, sid);
    setSessions(prev => prev.filter(s => s.id !== sid));
    if (sid === sessionIdRef.current) newChat();
  }

  async function reindex() {
    if (reindexing) return;
    setReindexing(true);
    try { await fetch("/api/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: target.path }) }); }
    catch {}
    setReindexing(false);
  }

  // copy / regenerate / edit / export ergonomics
  function copyMsg(text) { try { navigator.clipboard.writeText(text || ""); } catch {} }
  function regenerate() {
    if (busy) return;
    let i = msgs.length - 1; while (i >= 0 && msgs[i].role !== "user") i--;
    if (i < 0) return;
    const q = msgs[i].text;
    send(q, { base: msgs.slice(0, i) });   // drop the old answer, re-ask from the same point
  }
  function editMsg(i) {
    if (busy || msgs[i].role !== "user") return;
    setVal(msgs[i].text);
    if (msgs[i].images && msgs[i].images.length) setAttachImgs(msgs[i].images.map(im => ({ url: im.url, name: im.name || "image" })));   // keep attached photos on edit
    else if (msgs[i].image) setAttachImgs([{ url: msgs[i].image, name: msgs[i].imageName || "image" }]);
    if (msgs[i].attachFiles && msgs[i].attachFiles.length)   // keep uploaded file attachments on edit
      setFiles(msgs[i].attachFiles.map(a => ({ name: a.name, path: a.path })));
    setMsgs(msgs.slice(0, i));   // truncate; next send re-asks from here
    if (taRef.current) { taRef.current.focus(); taRef.current.style.height = "auto"; }
  }
  function exportChat() {
    const md = `# Chat · ${target.name}\n\n` + msgs.filter(m => m.text)
      .map(m => (m.role === "user" ? "**You:**\n\n" : "**Heap Chat:**\n\n") + m.text).join("\n\n---\n\n");
    const blob = new Blob([md], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = (target.name || "chat").replace(/[^\w.\- ]+/g, "_") + ".md"; a.click();
    URL.revokeObjectURL(url);
  }

  // download a single answer (e.g. a research report) as a .md file, named from its first heading/line
  function downloadMsg(text) {
    const t = text || "";
    const first = ((t.match(/^#+\s*(.+)$/m) || t.match(/^(.{3,80})/m) || [, "document"])[1] || "document");
    const name = first.replace(/[*_`#\[\]]/g, "").trim().slice(0, 60).replace(/[^\w.\- ]+/g, "_") || "document";
    const blob = new Blob([t], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = name + ".md"; a.click();
    URL.revokeObjectURL(url);
  }

  // read image files, shrink, and append to the attachment tray (capped at MAX_ATTACH_IMGS)
  function addAttachImages(fileList) {
    const imgs = [...(fileList || [])].filter(f => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(f.name || ""));
    imgs.slice(0, MAX_ATTACH_IMGS).forEach(f => {
      const r = new FileReader();
      r.onload = () => shrinkImage(r.result, url =>
        setAttachImgs(prev => prev.length >= MAX_ATTACH_IMGS ? prev : [...prev, { url, name: f.name || "pasted-image.png" }]));
      r.readAsDataURL(f);
    });
  }

  function onDrop(e) {
    if (![...(e.dataTransfer.files || [])].some(x => x.type.startsWith("image/"))) return;
    e.preventDefault(); setDragActive(false);
    addAttachImages(e.dataTransfer.files);
  }

  // upload picked files into the KB (Uploads/) and attach them to the next message
  function addFiles(fileList) {
    const arr = [...fileList].filter(f => f.size <= 25 * 1024 * 1024).slice(0, 10 - files.length);
    for (const f of arr) {
      const tmp = { name: f.name, path: null, uploading: true };
      setFiles(prev => [...prev, tmp]);
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await fetch("/api/upload", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name, data: reader.result }) });
          const j = await r.json();
          if (r.ok && j.path) setFiles(prev => prev.map(x => x === tmp ? { name: j.name, path: j.path } : x));
          else setFiles(prev => prev.filter(x => x !== tmp));
        } catch { setFiles(prev => prev.filter(x => x !== tmp)); }
      };
      reader.readAsDataURL(f);
    }
  }

  function updateMsg(i, patch) {
    setMsgs(m => { const c = m.slice(); c[i] = { ...c[i], ...patch }; persist(c); return c; });
  }
  // the user clicked Approve/Cancel on a destructive-action card
  async function decideAction(i, pa, approve) {
    if (!pa || (pa.status !== "pending")) return;
    if (!approve) { updateMsg(i, { pendingAction: { ...pa, status: "declined" } }); return; }
    try {
      const r = await fetch("/api/agent/approve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: target.domain || "kb", path: target.path, paths: target.paths || undefined,
          action: { action: pa.action, name: pa.name, new_name: pa.new_name, text: pa.text } }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error || j.ok === false) throw new Error(j.error || j.result || "action failed");
      updateMsg(i, { pendingAction: { ...pa, status: "done", resultText: j.result, error: undefined } });
    } catch (e) {
      updateMsg(i, { pendingAction: { ...pa, status: "pending", error: e.message } });
    }
  }

  async function send(text, opts = {}) {
    const q = (text ?? val).trim();
    // /image-create … and /image-edit … run a fast direct image call instead of a chat turn
    const slash = q.match(/^\/image-(create|edit)\s+([\s\S]+)/i);
    if (slash && !busy) {
      setVal(""); if (taRef.current) taRef.current.style.height = "auto";
      runImageCommand(slash[1].toLowerCase(), slash[2].trim(), { base: opts.base || msgs });
      return;
    }
    // /read <url> [question] — scrape the pasted link(s) and answer from them (no web search). Rewrites
    // into a normal agent turn; the server auto-fetches any URL in the message.
    const readCmd = q.match(/^\/read\b\s*([\s\S]*)/i);
    if (readCmd && !busy) {
      const rest = (readCmd[1] || "").trim();
      const urls = (rest.match(/\bhttps?:\/\/\S+/gi) || []).map(u => u.replace(/[.,;:!?)\]}'"]+$/, ""));
      if (urls.length) {
        const question = rest.replace(/\bhttps?:\/\/\S+/gi, "").trim();
        setVal(""); if (taRef.current) taRef.current.style.height = "auto";
        return send((question || "Read this page and give me a clear, structured summary of it.") + "\n" + urls.join("\n"), opts);
      }
      // no URL provided → fall through and send as-is (the composer hint explains the usage)
    }
    const imgs = opts.images !== undefined ? opts.images : attachImgs;   // attached images for this turn (0..MAX_ATTACH_IMGS)
    const atts = files.filter(f => f.path);   // uploaded chat attachments (agent scope)
    if ((!q && !imgs.length && !atts.length) || busy) return;
    setVal(""); if (taRef.current) taRef.current.style.height = "auto";
    if (imgs.length) setAttachImgs([]);
    if (atts.length) setFiles([]);

    const base = opts.base || msgs;
    const history = base
      .filter(m => m.text && !m.error)
      .map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));
    const userText = q || (imgs.length ? (imgs.length > 1 ? "What's in these images?" : "What's in this image?") : atts.length ? "Look at the attached file" + (atts.length > 1 ? "s" : "") : "");
    history.push({ role: "user", content: userText });

    // images visible in this conversation — so the agent can see/use/embed them (vision tools, note embeds)
    const isImgName = n => /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(n || "");
    // browsers give every clipboard-pasted image the same generic name (usually "image.png"), so two
    // separate pastes in one conversation collide — the agent can only refer to images by name, and a
    // name lookup would silently resolve to the FIRST match (the old image). Disambiguate here: keep
    // the first occurrence of a name as-is, suffix later duplicates " (2)", " (3)", ... so each image
    // the agent is shown has a name that actually identifies it.
    function dedupeImageNames(list) {
      const seen = new Map();
      return list.map(im => {
        const n = im.name || "image.jpg";
        const count = (seen.get(n) || 0) + 1;
        seen.set(n, count);
        if (count === 1) return im;
        const ext = n.match(/\.[a-z0-9]+$/i);
        const stem = ext ? n.slice(0, -ext[0].length) : n;
        return { ...im, name: `${stem} (${count})${ext ? ext[0] : ""}` };
      });
    }
    const convoImages = dedupeImageNames([
      ...base.filter(m => m.image).map(m => ({ name: m.imageName || "image.jpg", dataUrl: m.image })),
      ...base.flatMap(m => (m.images || []).map(im => ({ name: im.name || "image.jpg", dataUrl: im.url }))),
      ...base.flatMap(m => (m.attachFiles || []).filter(a => isImgName(a.name)).map(a => ({ name: a.name, path: a.path }))),
      ...atts.filter(a => isImgName(a.name)).map(a => ({ name: a.name, path: a.path })),
      ...imgs.map(im => ({ name: im.name || "image.jpg", dataUrl: im.url })),   // images attached on THIS turn
    ]);

    atBottomRef.current = true;   // a fresh send always jumps to the latest
    setMsgs([...base, { role: "user", text: userText, images: imgs.length ? imgs.map(im => ({ url: im.url, name: im.name })) : undefined, attachments: atts.length ? atts.map(a => a.name) : undefined, attachFiles: atts.length ? atts.map(a => ({ name: a.name, path: a.path })) : undefined }, { role: "ai", text: "", thinking: "", streaming: true }]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const started = Date.now();

    function patchLast(patch) {
      setMsgs(m => {
        const copy = m.slice();
        copy[copy.length - 1] = { ...copy[copy.length - 1], ...(typeof patch === "function" ? patch(copy[copy.length - 1]) : patch) };
        return copy;
      });
    }

    try {
      // agent chats always go to the agent (images ride along as convoImages so its tools can use them);
      // elsewhere an attached image routes to the single-shot vision endpoint
      const url = isAgent ? "/api/agent" : imgs.length ? "/api/vision" : "/api/chat";
      const scopeBody = isAssistant ? { scope: "assistant" }
        : isGeneral ? { scope: "general" }
        : isFolder ? { scope: "folder", folderPath: target.path }
        : { scope: "file", filePath: target.path };
      const cw = settings.contextWindow;
      const payload = (!isAgent && imgs.length)
        ? { image: imgs[0].url, images: imgs.map(im => im.url), messages: history, temperature: settings.temperature, maxTokens: settings.maxTokens, contextWindow: cw }
        : isAgent
        ? { scope: target.domain || "kb", path: target.path, paths: target.paths || undefined, sessionId: sessionIdRef.current || undefined, attachments: atts.length ? atts.map(a => a.path) : undefined, messages: history, model: effectiveModel, embedModel: settings.embedModel || undefined, rerankModel: settings.rerankModel || "", thinking: thinkOn, autoMemory: settings.autoMemory !== false, richRender: settings.richRender !== false, webSearch: webOn, research: researchOn, deepResearch: deepOn, deepWork: deepWorkOn, factCheck: factCheckOn, useFiles: useFilesOn, useMemory: useMemoryOn, placeLookup: settings.placeLookup === true, imageGen: settings.imageGen === true, imageBackend: settings.imageBackend || "comfyui", comfyUrl: settings.comfyUrl || undefined, comfyModel: settings.comfyModel || undefined, imageQuality: settings.imageQuality || "fast", drawThingsUrl: settings.drawThingsUrl || undefined, drawThingsModel: settings.drawThingsModel || undefined, drawThingsSecret: settings.drawThingsSecret || undefined, imageSteps: settings.imageSteps, imageGuidance: settings.imageGuidance, imageStrength: settings.imageStrength, imageWidth: settings.imageWidth, imageHeight: settings.imageHeight, imageMaxDim: settings.imageEditFullRes ? 0 : 1024, temperature: settings.temperature, maxTokens: settings.maxTokens, topP: settings.topP, contextWindow: cw, projectId: target.projectId || undefined, agentId: agentIdRef.current || undefined, describePhotos: settings.facePhotoCount || 5, convoImages: convoImages.length ? convoImages : undefined }
        : { ...scopeBody, messages: history, sessionId: sessionIdRef.current || undefined, attachments: atts.length ? atts.map(a => a.path) : undefined, thinking: thinkOn, systemPrompt: settings.systemPrompt, model: modelOverride || undefined, embedModel: settings.embedModel || undefined, rerankModel: settings.rerankModel || "", useFiles: useFilesOn, useMemory: useMemoryOn, temperature: settings.temperature, maxTokens: settings.maxTokens, topP: settings.topP, contextWindow: cw };
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${resp.status})`);
      }

      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let obj; try { obj = JSON.parse(line); } catch { continue; }
          if (obj.error) throw new Error(obj.error);
          if (obj.action) { if (obj.action.type === "open_file" && onOpenPath) onOpenPath(obj.action.path); continue; }
          if (obj.pending_action) { patchLast({ pendingAction: { ...obj.pending_action, status: "pending" } }); continue; }
          if (obj.revision && obj.revision.text) {
            // a revision replaces the whole answer — update BOTH m.text and the timeline's text segment,
            // otherwise the bubble keeps showing the stale first draft (the timeline is what gets rendered)
            patchLast(p => {
              const tl = (p.timeline || []).slice();
              let found = false;
              for (let i = tl.length - 1; i >= 0; i--) { if (tl[i].t === "text") { tl[i] = { ...tl[i], text: obj.revision.text }; found = true; break; } }
              if (!found) tl.push({ t: "text", text: obj.revision.text });
              return { text: obj.revision.text, content: obj.revision.text, revised: true, timeline: tl };
            });
            continue;
          }
          if (obj.sources) { patchLast({ sources: obj.sources }); continue; }
          if (obj.context) { setCtxInfo(obj.context); continue; }
          if (obj.grounding) { patchLast({ grounding: obj.grounding }); continue; }
          if (obj.provenance) { patchLast({ provenance: obj.provenance }); continue; }
          if (obj.verification) { patchLast({ verification: obj.verification }); continue; }
          if (obj.render) { patchLast(p => ({ renders: [...(p.renders || []), obj.render] })); continue; }
          if (obj.step) {
            patchLast(p => {
              // steps arriving after the answer started (e.g. fact-check) render BELOW the bubble, keeping real order
              const step = { t: "step", name: obj.step.name, args: obj.step.args, status: "run", after: !!(p.text && p.text.trim()), agent: obj.step.agent };
              return {
                timeline: [...(p.timeline || []), step],
                steps: [...(p.steps || []), { name: obj.step.name, args: obj.step.args, status: "run", agent: obj.step.agent }],
              };
            });
            continue;
          }
          if (obj.step_result) {
            patchLast(p => {
              const mark = arr => { const a = arr.slice(); for (let i = a.length - 1; i >= 0; i--) if ((a[i].t === "step" || a[i].name) && a[i].status === "run") { a[i] = { ...a[i], status: "done", summary: obj.step_result.summary, detail: obj.step_result.detail }; break; } return a; };
              return { timeline: mark(p.timeline || []), steps: mark(p.steps || []) };
            });
            continue;
          }
          const part = obj.message || {};
          if (part.thinking) patchLast(p => {
            const tl = (p.timeline || []).slice();
            if (tl.length && tl[tl.length - 1].t === "think") tl[tl.length - 1] = { ...tl[tl.length - 1], text: tl[tl.length - 1].text + part.thinking };
            else tl.push({ t: "think", text: part.thinking, after: !!(p.text && p.text.trim()), agent: part.agent });
            return { timeline: tl, thinking: (p.thinking || "") + part.thinking };
          });
          if (part.content) {
            patchLast(p => {
              const next = { content: (p.content || "") + part.content };
              if (!p.text && !p.secs && p.thinking) next.secs = ((Date.now() - started) / 1000).toFixed(1);
              next.text = (p.text || "") + part.content;
              // mirror text into the timeline so thinking → text → thinking renders in stream order
              const tl = (p.timeline || []).slice();
              if (tl.length && tl[tl.length - 1].t === "text") tl[tl.length - 1] = { ...tl[tl.length - 1], text: tl[tl.length - 1].text + part.content };
              else tl.push({ t: "text", text: part.content });
              next.timeline = tl;
              return next;
            });
          }
        }
      }
      patchLast(p => {
        const patch = { streaming: false };
        // Model embedded its answer in the think block without closing </think>
        // (common with Qwen3-MLX and similar models). Surface it as the answer —
        // but not when the agent intentionally stopped to await an approval decision.
        if (!p.pendingAction && !p.text?.trim() && p.thinking?.trim()) {
          patch.text = p.thinking;
          if (p.secs == null) patch.secs = ((Date.now() - started) / 1000).toFixed(1);
        }
        return patch;
      });
    } catch (e) {
      if (e.name === "AbortError") patchLast({ streaming: false });
      else patchLast({ streaming: false, error: true, text: "", errMsg: e.message });
    } finally {
      setBusy(false);
      abortRef.current = null;
      setMsgs(cur => { persist(cur); return cur; });
    }
  }

  function stop() { if (abortRef.current) abortRef.current.abort(); }

  // active image backend + chat model, shared by the image commands and the edit modal
  function dtBody() {
    return {
      imageBackend: settings.imageBackend || "comfyui",
      comfyUrl: settings.comfyUrl || undefined,
      comfyModel: settings.comfyModel || undefined,
      quality: settings.imageQuality || "fast",
      drawThingsUrl: settings.drawThingsUrl || undefined,
      drawThingsModel: settings.drawThingsModel || undefined,
      drawThingsSecret: settings.drawThingsSecret || undefined,
      model: effectiveModel, projectId: target.projectId || undefined,
      steps: settings.imageSteps || 4, guidanceScale: settings.imageGuidance ?? 7.5,
    };
  }
  // a /api/file?path=… url → the absolute server path (so /image-edit can pass `path`, not re-upload)
  function pathFromFileUrl(u) { const m = String(u || "").match(/[?&]path=([^&]+)/); return m ? decodeURIComponent(m[1]) : null; }
  // newest image visible in the conversation (generated render, attached/pasted, or vision image)
  function lastConvoImage(base) {
    const found = [];
    for (const m of base) {
      if (m.image) found.push({ dataUrl: m.image, name: m.imageName || "image" });
      (m.images || []).forEach(im => found.push({ url: im.url, name: im.name }));
      (m.renders || []).forEach(sp => { if (sp.type === "images") (sp.items || []).forEach(it => found.push({ url: it.image || it.url, name: it.title })); });
    }
    return found[found.length - 1] || null;
  }

  // Run /image-create or /image-edit against the direct /api/image endpoints (no agent turn).
  // forced: re-run params from a Regenerate/Use-exact action (skips target discovery for edits).
  async function runImageCommand(kind, prompt, { base, exact = false, forced } = {}) {
    const baseMsgs = base || msgs;
    if (!settings.imageGen) {
      setMsgs([...baseMsgs,
        { role: "user", text: `/image-${kind} ${prompt}` },
        { role: "ai", text: "Image generation is off. Turn it on in **Settings → Image generation** and point it at your ComfyUI or Draw Things server.", error: false }]);
      setMsgs(cur => { persist(cur); return cur; });
      return;
    }
    // resolve the edit target up front so we can fail fast with a clear message
    let editTgt = forced || null;
    if (kind === "edit" && !editTgt) {
      if (attachImgs.length) { const a = attachImgs[attachImgs.length - 1]; editTgt = { dataUrl: a.url, name: a.name }; }
      else editTgt = lastConvoImage(baseMsgs);
    }
    if (kind === "edit") setAttachImgs([]);

    atBottomRef.current = true;
    setMsgs([...baseMsgs, { role: "user", text: `/image-${kind} ${prompt}` }, { role: "ai", text: "", streaming: true }]);
    setBusy(true);
    function patchLast(patch) {
      setMsgs(m => { const c = m.slice(); c[c.length - 1] = { ...c[c.length - 1], ...(typeof patch === "function" ? patch(c[c.length - 1]) : patch) }; return c; });
    }
    try {
      const body = { prompt, enhance: exact ? false : (settings.imageEnhance !== false), ...dtBody() };
      let url = "/api/image/create";
      if (kind === "create") { body.width = settings.imageWidth || 512; body.height = settings.imageHeight || 512; }
      if (kind === "edit") { body.strength = settings.imageStrength ?? 0.7; body.maxDim = settings.imageEditFullRes ? 0 : 1024; }
      if (kind === "edit") {
        if (!editTgt) { patchLast({ streaming: false, error: true, errMsg: "Attach an image (or generate one first), then /image-edit <change>." }); return; }
        url = "/api/image/edit";
        if (editTgt.path) body.path = editTgt.path;
        else if (editTgt.dataUrl) body.dataUrl = editTgt.dataUrl;
        else if (editTgt.url) { const p = pathFromFileUrl(editTgt.url); if (p) body.path = p; else body.dataUrl = editTgt.url; }
      }
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Image generation failed");
      const note = j.enhanced ? `**Enhanced prompt:** ${j.prompt}` : `**Prompt:** ${j.prompt}`;
      patchLast({
        streaming: false, text: note,
        renders: [{ type: "images", title: kind === "create" ? "Generated image" : "Edited image", items: j.items }],
        imageCmd: { kind, prompt, targetPath: body.path, targetDataUrl: body.dataUrl },
      });
    } catch (e) {
      patchLast({ streaming: false, error: true, text: "", errMsg: e.message });
    } finally {
      setBusy(false);
      setMsgs(cur => { persist(cur); return cur; });
    }
  }
  // Regenerate / Use-my-exact-prompt actions under an image result
  function imageAction(i, mode) {
    const m = msgs[i]; if (!m || !m.imageCmd || busy) return;
    const c = m.imageCmd;
    const forced = c.kind === "edit" ? { path: c.targetPath, dataUrl: c.targetDataUrl } : null;
    runImageCommand(c.kind, c.prompt, { base: msgs, exact: mode === "exact", forced });
  }
  // open the Edit-with-AI modal for a chat image (server path if we have one, else its url)
  function editChatImage(item) {
    const url = item.image || item.url;
    const p = pathFromFileUrl(url);
    setImgEdit({ src: item.thumb || url, path: p || undefined, dataUrl: p ? undefined : url });
  }

  const lastAi = [...msgs].reverse().find(m => m.role === "ai" && !m.streaming && !m.error);
  const chips = (lastAi && lastAi.chips) || (isFolder ? FOLDER_SUGGESTIONS : suggestionsFor(target.kind));
  const defaultModel = isAgent ? (settings.agentModel || settings.model) : settings.model;
  const effectiveModel = modelOverride || defaultModel;
  // context-fill gauge for the composer meter. Prefer the REAL prompt-token count the server reports
  // after each turn (ctxInfo); before the first turn, fall back to a ~4 chars/token estimate of the
  // conversation + draft so the meter isn't blank. The server auto-summarizes older turns once full.
  const ctxEstimate = React.useMemo(() => {
    let chars = (val || "").length;
    for (const m of msgs) chars += ((m.text || "").length + (m.thinking || "").length);
    return Math.ceil(chars / 4);
  }, [msgs, val]);
  const ctxMax = (ctxInfo && ctxInfo.max) || settings.contextWindow || 8192;
  const ctxUsed = ctxInfo ? ctxInfo.used : ctxEstimate;
  const ctxReal = !!ctxInfo;

  const scopeLabel = isAgent
    ? (target.domain === "kb" ? "agent · general + knowledge base" : target.domain === "folder" ? "agent · this folder" : target.domain === "selection" ? "agent · selected files" : "agent · this file")
    : isAssistant ? "assistant · knowledge-base aware" : isGeneral ? "general assistant" : isFolder ? "scoped to this folder" : "scoped to this file";
  return (
    <div className={"chat" + (variant === "main" ? " chat-main" : "") + (dragActive ? " chat-drag" : "")}
      style={variant === "main" ? undefined : (width ? { width } : undefined)}
      onDragOver={e => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragActive(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragActive(false); }}
      onDrop={onDrop}>
      {variant !== "main" && onResize && <div className="chat-resize" onMouseDown={startResize} title="Drag to resize" />}
      {dragActive && <div className="chat-dropzone"><div><Icon name="image" size={28} /><div style={{ marginTop: 8 }}>Drop an image to ask about it</div></div></div>}
      {variant !== "main" && (
      <div className="chat-head">
        {isPlain
          ? <div className="chat-thumb" style={{ display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent)" }}><Icon name="sparkles" size={20} /></div>
          : isFolder
          ? <div className="chat-thumb" style={{ display: "grid", placeItems: "center", background: "var(--accent-soft)", color: "var(--accent)" }}><Icon name="folderOpen" size={20} /></div>
          : <div className="chat-thumb"><Thumb file={target.file} small /></div>}
        <div className="col grow" style={{ gap: 1 }}>
          <span className="semi truncate" style={{ fontSize: 13.5 }}>{target.name}</span>
          <span className="t-xs ink-3 row gap-1"><Icon name="sparkles" size={11} style={{ color: "var(--accent)" }} /> Chat · {scopeLabel}</span>
        </div>

        {isFolder && (
          <button className="btn icon sm ghost none" title="Re-index folder" onClick={reindex} disabled={reindexing} style={{ color: "var(--ink-3)" }}>
            <Icon name="refresh" size={15} style={reindexing ? { animation: "spin 1s linear infinite" } : undefined} />
          </button>
        )}
        <div className="dropdown none">
          <button className="btn icon sm ghost" title="Chat history" disabled={!sessions.length}
            onClick={() => setHistOpen(o => !o)} style={{ color: "var(--ink-3)" }}>
            <Icon name="clock" size={16} />
          </button>
          {histOpen && <>
            <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setHistOpen(false)} />
            <div className="dd-menu" style={{ width: 290, left: "auto", right: 0, maxHeight: 380, overflow: "auto" }}>
              <div className="dd-label">{sessions.length} chat{sessions.length === 1 ? "" : "s"} on this {isFolder ? "folder" : "file"}</div>
              {sessions.map(s => (
                <div key={s.id} className={"sess-row" + (s.id === sessionId ? " on" : "")} onClick={() => switchSession(s.id)}>
                  <div className="col grow" style={{ minWidth: 0, gap: 1 }}>
                    <span className="truncate semi" style={{ fontSize: 13 }}>{s.title || "New chat"}</span>
                    <span className="t-xs ink-3">{relTimeAgo(s.updatedAt)} · {s.count} msg{s.count === 1 ? "" : "s"}</span>
                  </div>
                  <button className="btn icon sm ghost sess-del" title="Delete chat" onClick={e => deleteSession(s.id, e)}><Icon name="x" size={13} /></button>
                </div>
              ))}
            </div>
          </>}
        </div>
        <button className="btn icon sm ghost none" title="Export chat to Markdown" onClick={exportChat} disabled={msgs.length <= 1} style={{ color: "var(--ink-3)" }}>
          <Icon name="download" size={16} />
        </button>
        <button className="btn icon sm ghost none" title="New chat" onClick={newChat} disabled={busy} style={{ color: "var(--ink-3)" }}>
          <Icon name="plus" size={16} />
        </button>
        {onClose && (
          <button className="btn icon sm ghost none" title="Close" onClick={onClose} style={{ color: "var(--ink-3)" }}>
            <Icon name="x" size={16} />
          </button>
        )}
      </div>
      )}

      <div className="chat-scroll scroll" ref={scrollRef} onScroll={onChatScroll}>
        <div className="chat-inner">
        {msgs.map((m, i) => (
          <ChatMessage key={i} m={m} i={i} isLast={i === msgs.length - 1} busy={busy} onOpenPath={onOpenPath}
            editMsg={editMsg} decideAction={decideAction} copyMsg={copyMsg} downloadMsg={downloadMsg} regenerate={regenerate}
            onEditImage={editChatImage} onImageAction={imageAction} onZoomImage={(items, index) => setChatZoom({ items, index })} />
        ))}
        </div>
      </div>

      {showJump && (
        <button className="jump-latest" onClick={jumpToLatest} title="Jump to latest"><Icon name="chevD" size={18} /></button>
      )}

      <Composer
        attachImgs={attachImgs} setAttachImgs={setAttachImgs} files={files} setFiles={setFiles}
        val={val} setVal={setVal} taRef={taRef} maxAttach={MAX_ATTACH_IMGS}
        isAgent={isAgent} isFolder={isFolder} isAssistant={isAssistant} isGeneral={isGeneral} target={target}
        send={send} stop={stop} busy={busy} addAttachImages={addAttachImages} addFiles={addFiles}
        plusOpen={plusOpen} setPlusOpen={setPlusOpen} imgInRef={imgInRef} filesInRef={filesInRef} dirInRef={dirInRef}
        webOn={webOn} setWebOn={setWebOn} researchOn={researchOn} setResearchOn={setResearchOn}
        deepOn={deepOn} setDeepOn={setDeepOn} deepWorkOn={deepWorkOn} setDeepWorkOn={setDeepWorkOn}
        factCheckOn={factCheckOn} setFactCheckOn={setFactCheckOn} useFilesOn={useFilesOn} setUseFilesOn={setUseFilesOn}
        useMemoryOn={useMemoryOn} setUseMemoryOn={setUseMemoryOn}
        agents={agents} agentId={agentId} applyAgent={applyAgent} onNewAgent={onNewAgent}
        ctxUsed={ctxUsed} ctxMax={ctxMax} ctxReal={ctxReal}
        thinkOn={thinkOn} setThinkOn={setThinkOn} online={online} imageGenOn={settings.imageGen === true}
        modelOpen={modelOpen} setModelOpen={setModelOpen} effectiveModel={effectiveModel}
        modelOverride={modelOverride} setModelOverride={setModelOverride} defaultModel={defaultModel} models={models} />

      {imgEdit && <ImageEditModal {...imgEdit} settings={settings} onClose={() => setImgEdit(null)}
        onDone={(item) => setMsgs(m => { const next = [...m, { role: "ai", text: "Edited image", renders: [{ type: "images", title: "Edited image", items: [item] }] }]; persist(next); return next; })} />}
      {chatZoom && <ChatLightbox items={chatZoom.items} index={chatZoom.index}
        onIndex={index => setChatZoom(z => ({ ...z, index }))} onClose={() => setChatZoom(null)} />}
    </div>
  );
}
// fmt + ProvText from markdown.jsx; ChatAPI from chat-data.jsx; Reasoning/GroundingBadge/
// ApprovalCard from chat-cards.jsx — all loaded before this file.

export { ChatPanel };
