import { ExtractModal, DuplicatesModal, RenameModal, prettyBytes } from "./modals.jsx";
import { parseRoute, loadRecents, loadSavedSettings, b64url, shortHash, pathCrumbs } from "./app-helpers.jsx";
import { useProjectsAgents, useRecentChats, usePersistentState } from "./app-hooks.jsx";
import { DEFAULT_SETTINGS, SettingsPage } from "./settings.jsx";
import { ChatAPI } from "./chat-data.jsx";
import { ProjectView, ProjectAPI, ProjectEditModal, ProjectsHub } from "./projects.jsx";
import { KIND_META, kindFromName, docMeta, Icon } from "./icons.jsx";
import { OllamaSetup } from "./setup.jsx";
import { Sidebar } from "./sidebar.jsx";
import { ManagePage } from "./manage.jsx";
import { ActivityPage } from "./activity.jsx";
import { ChatsHub } from "./chats.jsx";
import { PhotoMap } from "./map.jsx";
import { GraphPage } from "./graph.jsx";
import { PeopleView, GlobalPeopleView } from "./people.jsx";
import { ChatPanel } from "./chat.jsx";
import { FocusView } from "./focus.jsx";
import { GalleryTopbar } from "./gallery-topbar.jsx";
import { GalleryBody } from "./gallery-body.jsx";
import { FolderPicker } from "./folderpicker.jsx";
import { SourceDrawer } from "./source-drawer.jsx";
import { BatchBar } from "./batch-bar.jsx";
import { CommandPalette } from "./commandpalette.jsx";
import { AgentEditModal, AgentsHub } from "./agents.jsx";
import { QuickAsk } from "./quickask.jsx";
import { AuthScreen } from "./auth.jsx";
// app.jsx — Heap Chat shell: folder picker → real gallery → focus + chat, plus settings
const { useState, useEffect, useRef } = React;

// ExtractModal / DuplicatesModal / RenameModal (+ prettyBytes) live in modals.jsx (loaded first).
// parseRoute / loadRecents / loadSavedSettings / b64url / shortHash / pathCrumbs live in app-helpers.jsx.

const CARD_W = 224;
// the side chat panel (focus/folder/selection) min width — wide enough that the composer
// toolbar (+, agent, model, send) fits on one row without wrapping
const MIN_CHAT_W = 470, MAX_CHAT_W = 760;
const AUTO_INDEX_LIMIT = 200;   // auto-index folders with up to this many text files; bigger → opt-in
const INDEX_EXT = new Set(["txt", "md", "markdown", "csv", "json", "xml", "yml", "yaml", "html", "htm", "css",
  "js", "jsx", "ts", "tsx", "py", "go", "rs", "java", "rb", "php", "sh", "c", "cpp", "h", "log", "rtf", "svg", "pdf", "docx"]);
const RECENTS_KEY = "heapchat.recents";   // suffixed with the user id at runtime
const LASTFOLDER_KEY = "heapchat.lastfolder";   // last browsed folder, so we can return to it after a restart
const SETTINGS_KEY = "heapchat.settings";

function App({ user }) {
  const recentsKey = RECENTS_KEY + "." + user.id;
  const lastFolderKey = LASTFOLDER_KEY + "." + user.id;
  const settingsKey = SETTINGS_KEY + "." + user.id;
  if (!localStorage.getItem(settingsKey) && localStorage.getItem(SETTINGS_KEY))
    localStorage.setItem(settingsKey, localStorage.getItem(SETTINGS_KEY));   // adopt legacy single-tenant settings once
  ["heapchat.last", "heapchat.recents", "heapchat.settings", "heapchat.side", "heapchat.chatw"].forEach(k => localStorage.removeItem(k));
  const [config, setConfig] = useState(null);
  const [online, setOnline] = useState(false);
  const [models, setModels] = useState([]);
  const [bootChecked, setBootChecked] = useState(false);   // health + models have resolved at least once
  const [setupSkipped, setSetupSkipped] = useState(false); // user dismissed/completed the first-run setup gate

  const [pickerOpen, setPickerOpen] = useState(false);
  const [folder, setFolder] = useState(null);        // { path, name }
  const [files, setFiles] = useState([]);
  const [dirs, setDirs] = useState([]);              // subfolders of the current folder
  const [parent, setParent] = useState(null);        // parent path (for "up")
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [recents, setRecents] = useState(() => loadRecents(recentsKey));
  // the last real folder the user browsed (not a single file / not KB/Created-images) — persisted so a
  // "return to folder" entry survives navigating to chat/settings/focus, editing an image, or restarting
  const [lastFolder, setLastFolder] = useState(() => {
    try {
      const lf = JSON.parse(localStorage.getItem(lastFolderKey) || "null");
      return (lf && !lf.kb && !lf.generated) ? lf : null;   // drop any pre-existing KB/Created-images value written before this guard existed
    } catch { return null; }
  });

  const [view, setView] = useState("gallery");        // gallery | settings | chat
  const [focusFile, setFocusFile] = useState(null);
  // where "back" should return to when a file was opened away from a normal folder browse (project
  // artifact, chat citation, graph/map node, recent file, …) — captured at the exact moment we leave
  // that view, so back retraces the real path instead of guessing via lastFolder
  const [returnTo, setReturnTo] = useState(null);
  const [folderChatOpen, setFolderChatOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = React.useRef(null);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [chatControls, setChatControls] = useState(null);   // main-chat controls hoisted to the top bar
  const [chatHistOpen, setChatHistOpen] = useState(false);
  const [pendingSession, setPendingSession] = useState(null);   // session to open when navigating from the Chats hub
  const [chatQuery, setChatQuery] = useState("");               // inline search over chats
  const [profileOpen, setProfileOpen] = useState(false);        // account popover (Manage / Settings)
  const [sourcePreview, setSourcePreview] = useState(null);     // a chat source shown in the right-side drawer
  const [extractTarget, setExtractTarget] = useState(null);     // file or folder for the "Extract to table" modal
  const [dupOpen, setDupOpen] = useState(false);                 // duplicate-photos scan modal
  const [renamePaths, setRenamePaths] = useState(null);          // selection paths for the smart-rename modal
  const [selChat, setSelChat] = useState(null);                  // "Ask AI" chat target scoped to the multi-selection
  const { projects, agents, reloadProjects, reloadAgents } = useProjectsAgents();
  const [currentProject, setCurrentProject] = useState(null);
  const [projectEditModal, setProjectEditModal] = useState(null);  // null | {} (new) | project obj (edit)
  const [pendingProjectSession, setPendingProjectSession] = useState(null);
  const [projectChatControls, setProjectChatControls] = useState(null);
  const { recentChats, setRecentChats, loadRecentChats } = useRecentChats(chatQuery, view, chatControls, projectChatControls);
  const [projectSubView, setProjectSubView] = useState("hub");  // "hub" | "chat"
  const [projectHubTab, setProjectHubTab] = useState("chats");  // "chats" | "files" — lifted so it survives leaving/returning to the project
  const [agentEditModal, setAgentEditModal] = useState(null);   // null | {} (new) | agent obj (edit)
  const [activeAgentId, setActiveAgentId] = useState(null);     // custom agent driving the main chat (null = default)
  const [peopleFolder, setPeopleFolder] = useState(null);      // folder to scan in People (null = global People view)
  const [peopleOrigin, setPeopleOrigin] = useState("gallery"); // where the folder-scoped People view was opened from
  const [pickerMode, setPickerMode] = useState("folder");      // "folder" → loadFolder; "people" → scope the People view
  const [sideCollapsed, setSideCollapsed] = usePersistentState("heapchat.side." + user.id, s => s === "1", v => v ? "1" : "0");
  const [chatWidth, setChatWidth] = usePersistentState("heapchat.chatw." + user.id, s => Math.min(MAX_CHAT_W, Math.max(MIN_CHAT_W, +s || MIN_CHAT_W)), v => String(v));
  function toggleSide() { setSideCollapsed(v => !v); }
  function setChatW(w) { setChatWidth(Math.max(MIN_CHAT_W, Math.min(MAX_CHAT_W, w))); }
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const [sortOpen, setSortOpen] = useState(false);
  const [tagFilter, setTagFilter] = useState(null);
  const [starred, setStarred] = useState(() => new Set());
  const [contentHits, setContentHits] = useState(() => new Set());   // files matching search by content
  const [idx, setIdx] = useState({ state: "idle" });                  // folder index status for content search
  const [selected, setSelected] = useState(() => new Set());          // multi-select for batch actions
  function toggleCheck(file) { setSelected(s => { const n = new Set(s); n.has(file.id) ? n.delete(file.id) : n.add(file.id); return n; }); }
  function clearSel() { setSelected(new Set()); }

  const [draft, setDraft] = useState({ ...DEFAULT_SETTINGS });
  const [saved, setSaved] = useState({ ...DEFAULT_SETTINGS });
  const [toast, setToast] = useState(null);

  // bootstrap: config, health, persisted settings, last opened (folder or file)
  useEffect(() => {
    fetch("/api/config").then(r => r.json()).then(cfg => {
      setConfig(cfg);
      const base = { ...DEFAULT_SETTINGS, model: cfg.model, agentModel: cfg.agentModel, endpoint: cfg.endpoint };
      const s = loadSavedSettings(settingsKey, base);
      // if the user never customised these, keep them tracking .env
      if (!s.model) s.model = cfg.model;
      if (!s.agentModel) s.agentModel = cfg.agentModel;
      if (!s.endpoint) s.endpoint = cfg.endpoint;
      // one-time: adopt the mandated image defaults over stale saved settings (steps 4 / guidance 1.5 / strength 0.99)
      if (s.imageDefaultsV !== DEFAULT_SETTINGS.imageDefaultsV) {
        s.imageSteps = DEFAULT_SETTINGS.imageSteps;
        s.imageGuidance = DEFAULT_SETTINGS.imageGuidance;
        s.imageStrength = DEFAULT_SETTINGS.imageStrength;
        s.imageDefaultsV = DEFAULT_SETTINGS.imageDefaultsV;
        try { localStorage.setItem(settingsKey, JSON.stringify(s)); } catch {}
      }
      setSaved(s); setDraft(s);
      if (wantKb.current) { wantKb.current = false; if (cfg.kb) loadFolder(cfg.kb, false); }   // #/kb deep link waited for config
    }).catch(() => {});
    Promise.all([
      fetch("/api/health").then(r => r.json()).catch(() => ({ ok: false })),
      fetch("/api/models").then(r => r.json()).catch(() => ({ models: [] })),
    ]).then(([h, m]) => { setOnline(!!h.ok); setModels(m.models || []); setBootChecked(true); });
    // route from the URL if present; otherwise restore the last opened folder/file
    const r = parseRoute();
    if (r.name && (r.name !== "folder" && r.name !== "file" ? true : r.path)) {
      applyRoute(r);
    } else {
      // chat-first: a bare "/" always lands on a FRESH chat (old conversations live in the
      // sidebar / ⌘K / deep links — never auto-resumed on a clean landing or fresh sign-in)
      setPendingSession("__new__");
      setView("chat");
      setTimeout(() => setPendingSession(null), 1500);
    }
    const onKey = e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCmdkOpen(o => !o); } };
    const onNav = () => applyRoute(parseRoute());      // browser back/forward
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onNav);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("popstate", onNav); };
  }, []);

  // URL ←→ state. Compute the canonical path for the current view.
  function currentRoute() {
    if (view === "settings") return "/settings";
    if (view === "manage") return "/manage";
    if (view === "activity") return "/activity";
    if (view === "chats") return "/chats";
    if (view === "chat") return "/chat" + (chatControls && chatControls.sessionId ? "?s=" + chatControls.sessionId : "");
    if (focusFile) return "/file?path=" + encodeURIComponent(focusFile.path);
    if (folder && folder.kb) return "/kb";
    if (folder && !folder.single) return "/folder?path=" + encodeURIComponent(folder.path);
    return "/";
  }
  // apply a parsed route to state (used on load, back/forward, and manual hash edits)
  function applyRoute(r) {
    if (r.name === "settings") { setView("settings"); setFocusFile(null); return; }
    if (r.name === "manage") { setView("manage"); setFocusFile(null); return; }
    if (r.name === "activity") { setView("activity"); setFocusFile(null); return; }
    if (r.name === "chats") { setView("chats"); setFocusFile(null); return; }
    if (r.name === "chat") { setFocusFile(null); setPendingSession(r.session || null); setView("chat"); if (r.session) setTimeout(() => setPendingSession(null), 2000); return; }
    if (r.name === "kb") { setView("gallery"); setFocusFile(null); config?.kb ? openKB() : (wantKb.current = true); return; }
    if (r.name === "folder" && r.path) { setFocusFile(null); if (!folder || folder.path !== r.path || folder.single) loadFolder(r.path, false); else setView("gallery"); return; }
    if (r.name === "file" && r.path) { if (!focusFile || focusFile.path !== r.path) openRecentFile(r.path, false); else setView("gallery"); return; }
    setView("gallery"); setFocusFile(null);   // home
  }
  // push state changes into the URL (replaceState for the initial restore so it leaves no dead history entry)
  const firstSync = useRef(true);
  const wantKb = useRef(false);
  useEffect(() => {
    if (firstSync.current) { firstSync.current = false; return; }
    const want = currentRoute();
    const cur = location.pathname + location.search;
    if (cur !== want) {
      const fromHome = cur === "/" || cur === "";
      fromHome ? history.replaceState(null, "", want) : history.pushState(null, "", want);
    }
  }, [view, focusFile && focusFile.path, folder && folder.path, folder && folder.kb, folder && folder.single, chatControls && chatControls.sessionId]);

  // push into the user's recents list (deduped, newest first)
  function remember(item) {
    setRecents(prev => {
      const next = [item, ...prev.filter(x => x.path !== item.path)].slice(0, 8);
      localStorage.setItem(recentsKey, JSON.stringify(next));
      return next;
    });
  }

  async function loadFolder(path, doRemember = true) {
    setLoadingFiles(true); setLoadError(null);
    try {
      const r = await fetch("/api/list?path=" + encodeURIComponent(path));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Cannot read folder");
      const isKb = (config && j.path === config.kb) || /[\/\\]data[\/\\]kb$/.test(j.path);
      const isGenerated = config && j.path === config.generated;
      setFolder({ path: j.path, name: isKb ? "Knowledge base" : isGenerated ? "Created images" : j.name, kb: isKb, generated: isGenerated });
      setFiles(j.files);
      setDirs(isKb ? [] : (j.dirs || []));
      setParent(isKb ? null : (j.parent || null));
      setView("gallery"); setFocusFile(null); setTypeFilter("all"); setQuery(""); setTagFilter(null); setSelected(new Set());
      setSelChat(null); setDupOpen(false);
      checkIndex(j.path, j.files);
      if (doRemember) remember({ type: "folder", path: j.path, name: j.name });
      if (!isKb && !isGenerated) {   // only a real, user-browsed folder counts as "last folder" (see declaration above)
        const lf = { path: j.path, name: j.name };
        setLastFolder(lf); try { localStorage.setItem(lastFolderKey, JSON.stringify(lf)); } catch {}
      }
    } catch (e) {
      setLoadError(e.message); setFolder(null); setFiles([]);
    } finally { setLoadingFiles(false); }
  }

  // snapshot of "where we are right now", so a file opened away from it can return here precisely
  function captureReturnTo() {
    if (view === "project" && currentProject) return { kind: "project", projectId: currentProject.id, subView: projectSubView };
    if (folder && !folder.single) return { kind: "folder", path: folder.path };
    if (view === "map" && folder) return { kind: "map", path: folder.path };
    if (["chat", "chats", "graph", "manage", "agents", "activity", "settings"].includes(view)) return { kind: "view", view };
    return null;
  }

  function openFile(file, doRemember = true) {
    // capture the origin only when actually leaving it — opening a second file while already in a
    // single-file excursion (e.g. a "related file" jump, or the result of an in-place image edit)
    // must not clobber the original origin.
    if (!(folder && folder.single)) setReturnTo(captureReturnTo());
    // open a single file directly into focus + chat (no folder load)
    setFolder({ path: file.path, name: file.name, single: true });
    setFiles([file]); setDirs([]); setParent(null);
    setView("gallery"); setTypeFilter("all"); setQuery(""); setTagFilter(null); setFolderChatOpen(false); setSelected(new Set());
    setSelChat(null); setDupOpen(false);
    setIdx({ state: "idle" });
    setFocusFile(file);
    setLoadError(null);
    if (doRemember) remember({ type: "file", path: file.path, name: file.name });
  }

  // re-stat a remembered file (handles renames/deletes) then open it
  async function openRecentFile(path, doRemember = true) {
    try {
      const r = await fetch("/api/fileinfo?path=" + encodeURIComponent(path));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "File no longer available");
      openFile(j, doRemember);
    } catch (e) { setLoadError(e.message); }
  }

  function openRecent(item) { item.type === "file" ? openRecentFile(item.path) : loadFolder(item.path); }

  // jump back to the last browsed folder from anywhere (chat, settings, focus, after an image edit).
  // if it's already the open folder, just re-show its gallery; otherwise reload it.
  function returnToFolder() {
    if (!lastFolder || lastFolder.kb || lastFolder.generated) return;   // never bounce to KB/Created-images
    if (folder && !folder.single && folder.path === lastFolder.path) { setView("gallery"); setFocusFile(null); }
    else loadFolder(lastFolder.path);
  }

  // precise "back" out of a single-file excursion — retraces exactly where openFile() captured
  // returnTo from (project, folder, map, or any other view), falling back to the last-browsed-folder
  // bookmark only when no origin was captured (e.g. a fresh deep link straight to a file).
  async function goBack(rt) {
    setFocusFile(null);
    if (!rt) { returnToFolder(); return; }
    setReturnTo(null);
    if (rt.kind === "project") {
      const proj = (projects || []).find(p => p.id === rt.projectId);
      if (proj) { setCurrentProject(proj); setProjectSubView(rt.subView || "hub"); setProjectChatControls(null); setView("project"); }
      else setView("gallery");
      return;
    }
    if (rt.kind === "folder") { await loadFolder(rt.path, false); return; }
    if (rt.kind === "map") { await loadFolder(rt.path, false); setView("map"); return; }
    if (rt.kind === "view") { setView(rt.view); return; }
  }

  // size-aware folder indexing for content search (small folders auto-index in the background)
  async function runIndex(p, silent) {
    if (!silent) setIdx({ state: "indexing" });
    try {
      const st = await fetch("/api/index", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: p }) }).then(r => r.json());
      setIdx({ state: "ready", files: st.files, chunks: st.chunks });
    } catch { if (!silent) setIdx({ state: "idle" }); }
  }
  async function checkIndex(p, fileList) {
    const n = fileList.filter(f => INDEX_EXT.has(f.ext)).length;
    if (n === 0) { setIdx({ state: "none" }); return; }
    try {
      const st = await fetch("/api/index?path=" + encodeURIComponent(p)).then(r => r.json());
      if (st.indexed) { setIdx({ state: "ready", files: st.files, chunks: st.chunks }); if (n <= AUTO_INDEX_LIMIT) runIndex(p, true); return; }
    } catch {}
    if (n <= AUTO_INDEX_LIMIT) runIndex(p);
    else setIdx({ state: "manual", count: n });
  }

  // batch actions on selected files
  function flashToast(msg, ms = 2200) { setToast(msg); setTimeout(() => setToast(null), ms); }
  async function batchAddToKB() {
    const paths = files.filter(f => selected.has(f.id)).map(f => f.path);
    const r = await fetch("/api/kb/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) }).then(r => r.json()).catch(() => null);
    flashToast(r && r.added ? `Added ${r.added.length} to knowledge base` : "Add failed"); clearSel();
  }
  async function batchTag() {
    const t = window.prompt("Tags (comma-separated):"); if (t == null) return;
    const tags = t.split(",").map(x => x.trim()).filter(Boolean); if (!tags.length) return;
    const paths = files.filter(f => selected.has(f.id)).map(f => f.path);
    await fetch("/api/tag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths, tags }) }).catch(() => {});
    flashToast(`Tagged ${paths.length} file${paths.length === 1 ? "" : "s"}`); clearSel();
    if (folder) loadFolder(folder.path, false);
  }
  async function batchMakeSearchable() {
    const imgs = files.filter(f => selected.has(f.id) && f.kind === "photo");
    if (!imgs.length) { flashToast("No images selected"); return; }
    flashToast(`Analyzing ${imgs.length} image${imgs.length === 1 ? "" : "s"}…`, 60000);
    for (const f of imgs) { await fetch("/api/image/describe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: f.path, context: "" }) }).catch(() => {}); }
    flashToast(`Made ${imgs.length} image${imgs.length === 1 ? "" : "s"} searchable`); clearSel();
  }
  async function batchDelete() {
    const sel = files.filter(f => selected.has(f.id));
    if (!window.confirm(`Delete ${sel.length} file${sel.length === 1 ? "" : "s"} from the knowledge base?`)) return;
    for (const f of sel) await fetch("/api/kb?path=" + encodeURIComponent(f.path), { method: "DELETE" }).catch(() => {});
    clearSel(); if (config?.kb) loadFolder(config.kb, false);
  }
  // AI batch actions — auto-tag by content, and chat scoped to exactly the selected files
  async function batchAutoTag() {
    const paths = files.filter(f => selected.has(f.id)).map(f => f.path);
    flashToast(`Auto-tagging ${paths.length} file${paths.length === 1 ? "" : "s"}… (vision for photos)`, 120000);
    const r = await fetch("/api/batch/autotag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths }) }).then(r => r.json()).catch(() => null);
    const n = r && r.tagged ? Object.keys(r.tagged).length : 0;
    flashToast(n ? `Tagged ${n} file${n === 1 ? "" : "s"}` : "Auto-tag failed");
    clearSel(); if (folder) loadFolder(folder.path, false);
  }
  function askSelection() {
    const sel = files.filter(f => selected.has(f.id));
    const paths = sel.map(f => f.path).sort();
    setFolderChatOpen(false);
    setSelChat({
      scope: "agent", domain: "selection", paths,
      id: "sel-" + shortHash(paths.join("\n")) + "-" + paths.length,
      name: `${sel.length} selected file${sel.length === 1 ? "" : "s"}`,
    });
  }
  useEffect(() => {
    if (!sourcePreview) return;
    const onEsc = e => { if (e.key === "Escape") setSourcePreview(null); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [sourcePreview]);

  async function delRecentChat(s, e) {
    e.stopPropagation();
    if (!window.confirm(`Delete "${s.title || "this chat"}"?`)) return;
    await ChatAPI.del(s.fileId, s.id);
    setRecentChats(prev => prev.filter(x => !(x.fileId === s.fileId && x.id === s.id)));
  }
  // recentChats + loadRecentChats come from the useRecentChats hook above.

  // projects + agents lists (and their reloaders) come from the useProjectsAgents hook above.

  // desktop tray / native menu / global hotkey → app actions. The subscription is mount-only,
  // but it dispatches through a ref so it always calls the latest handlers (no stale closures).
  const actionRef = useRef(() => {});
  actionRef.current = (name) => {
    if (name === "new-chat") startNewChat();
    else if (name === "open-settings") { setView("settings"); setFocusFile(null); }
  };
  useEffect(() => {
    if (!(window.heapchat && window.heapchat.onAction)) return;
    return window.heapchat.onAction(name => actionRef.current(name));
  }, []);

  // desktop: screenshot capture + Finder/Dock drops → ingest into the knowledge base (with OCR/index)
  const ingestRef = useRef(null);
  ingestRef.current = async ({ files, source } = {}) => {
    if (!files || !files.length) return;
    const fd = new FormData();
    let n = 0;
    for (const f of files) {
      try { const blob = await (await fetch(f.dataUrl)).blob(); fd.append("files", new File([blob], f.name, { type: blob.type })); n++; } catch {}
    }
    if (!n) return;
    flashToast(source === "screenshot" ? "Adding screenshot to knowledge base…" : `Adding ${n} file${n === 1 ? "" : "s"} to knowledge base…`, 4000);
    try {
      const r = await fetch("/api/kb/upload", { method: "POST", body: fd }).then(r => r.json());
      const count = (r.saved || []).length || n;
      flashToast(source === "screenshot" ? "Screenshot saved & made searchable" : `Added ${count} to knowledge base`);
      if (config && config.kb && folder && folder.kb) loadFolder(config.kb, false);   // refresh if viewing the KB
    } catch { flashToast("Couldn't add to the knowledge base"); }
  };
  useEffect(() => {
    if (!(window.heapchat && window.heapchat.onIngestFiles)) return;
    const offFiles = window.heapchat.onIngestFiles(d => ingestRef.current(d));
    const offFolder = window.heapchat.onOpenFolder ? window.heapchat.onOpenFolder(d => d && d.path && loadFolder(d.path)) : null;
    return () => { offFiles && offFiles(); offFolder && offFolder(); };
  }, []);

  // "Continue in Heap Chat" from the Quick Ask panel → open the exchange's session (Quick Ask
  // already saves every answered question as it completes — see quickask.jsx — so normally this
  // just switches to it; the question/answer fallback only matters if a session couldn't be saved).
  const continueRef = useRef(null);
  continueRef.current = async ({ question, answer, sessionId } = {}) => {
    let sid = sessionId;
    if (!sid) {
      if (!question) return;
      sid = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "s" + Date.now() + Math.random().toString(16).slice(2);
      const messages = [{ role: "user", text: question }];
      if (answer) messages.push({ role: "ai", text: answer });
      const source = { scope: "agent", domain: "kb", name: "Heap Chat Agent", id: "agent" };
      try { await ChatAPI.save("agent", sid, question.slice(0, 60), messages, source, false, null, null); } catch {}
    }
    loadRecentChats();   // the seeded chat must appear in the sidebar immediately
    setActiveAgentId(null); setFocusFile(null);
    if (view === "chat" && activeAgentId === null && chatControls && chatControls.switchSession) chatControls.switchSession(sid);   // already on the default chat → switch in place
    else { setPendingSession(sid); setView("chat"); setTimeout(() => setPendingSession(null), 1500); }
  };
  useEffect(() => {
    if (!(window.heapchat && window.heapchat.onContinueChat)) return;
    const off = window.heapchat.onContinueChat(d => continueRef.current(d));
    if (window.heapchat.rendererReady) window.heapchat.rendererReady();   // signal main we're subscribed; flush any buffered continue
    return off;
  }, []);

  // Desktop notifications for finished scheduled jobs (the scheduler's "notify" delivery channel).
  // The server runs in a separate process and can't show a native toast itself, so the renderer polls
  // for pending notifications and fires them via the Electron bridge (or the Web Notifications fallback).
  useEffect(() => {
    let stopped = false;
    async function pump() {
      let pending = [];
      try { pending = (await fetch("/api/notifications").then(r => r.json())).notifications || []; } catch { return; }
      if (!pending.length) return;
      if (!window.heapchat && "Notification" in window && Notification.permission === "default") {
        try { await Notification.requestPermission(); } catch {}
      }
      for (const n of pending) {
        if (window.heapchat && window.heapchat.notify) window.heapchat.notify(n.title || "Heap Chat", n.body || "");
        else if ("Notification" in window && Notification.permission === "granted") { try { new Notification(n.title || "Heap Chat", { body: n.body || "" }); } catch {} }
      }
    }
    pump();
    const id = setInterval(() => { if (!stopped) pump(); }, 45000);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // start a fresh main-agent conversation (chat-first entry point) — always the built-in default agent
  function startNewChat() {
    setActiveAgentId(null);
    if (view === "chat" && activeAgentId === null && chatControls && chatControls.newChat) { chatControls.newChat(); return; }   // already on a default chat → new session in place
    setFocusFile(null); setPendingSession("__new__"); setView("chat");
    setTimeout(() => setPendingSession(null), 1500);
  }

  // open a fresh main chat driven by a specific custom agent (from the sidebar Agents list)
  function openAgentChat(agent) {
    setActiveAgentId(agent.id);
    setFocusFile(null); setPendingSession("__new__"); setView("chat");
    setTimeout(() => setPendingSession(null), 1500);
  }

  // start a fresh chat inside the current project
  function startProjectChat() {
    if (projectSubView === "chat" && projectChatControls && projectChatControls.newChat) { projectChatControls.newChat(); return; }
    setProjectSubView("chat");
    setPendingProjectSession("__new__");
    setTimeout(() => setPendingProjectSession(null), 1500);
  }

  // reopen a saved conversation from the Chats hub / sidebar: jump to its context, then load that session
  function openSession(s, info) {
    if (info.kind === "project" && info.projectId) {
      // project chats live under the project — open the project's chat view (setting the project first),
      // otherwise the session is looked up against the KB store and opens blank
      const proj = (projects || []).find(p => p.id === info.projectId);
      if (!proj) return;   // project was deleted
      setFocusFile(null); setCurrentProject(proj); setProjectChatControls(null);
      setProjectSubView("chat"); setView("project");
      setPendingProjectSession(s.id);
      setTimeout(() => setPendingProjectSession(null), 2000);
      return;
    }
    if (info.kind === "kb") {
      setFocusFile(null);
      if (view === "chat" && chatControls && chatControls.switchSession) { chatControls.switchSession(s.id); return; }   // main chat already open → switch in place
      setPendingSession(s.id); setView("chat"); setTimeout(() => setPendingSession(null), 1500); return;
    }
    setPendingSession(s.id);
    setTimeout(() => setPendingSession(null), 2000);   // one-shot: clear after the panel has consumed it
    if (info.kind === "folder" && info.path) { setFolderChatOpen(true); loadFolder(info.path, false); }
    else if (info.path) { openByPath(info.path); }
  }

  // open a chat that belongs to a project (from ProjectView)
  function openProjectSession(s) {
    setProjectSubView("chat");
    setPendingProjectSession(s.id);
    setTimeout(() => setPendingProjectSession(null), 2000);
  }

  // open a project hub
  function openProject(p) {
    setCurrentProject(p);
    setProjectSubView("hub");
    setProjectChatControls(null);
    setView("project");
    setFocusFile(null);
  }
  // open any file by absolute path (used by chat citations / sources, wherever the file lives)
  async function openByPath(p) {
    if (!p) return;
    try { const r = await fetch("/api/fileinfo?path=" + encodeURIComponent(p)); const j = await r.json(); if (r.ok) openFile(j, false); } catch {}
  }
  // chat source → web URL opens in the browser; a local file peeks in the right-side drawer
  async function openSourcePreview(p) {
    if (!p) return;
    if (/^https?:\/\//i.test(p)) { window.open(p, "_blank", "noopener"); return; }
    try { const r = await fetch("/api/fileinfo?path=" + encodeURIComponent(p)); const j = await r.json(); if (r.ok) setSourcePreview(j); } catch {}
  }

  // content search for the gallery box: match by meaning/exact text, not just filename
  useEffect(() => {
    if (!query.trim() || !folder || folder.single) { setContentHits(new Set()); return; }
    const t = setTimeout(() => {
      fetch("/api/search?path=" + encodeURIComponent(folder.path) + "&q=" + encodeURIComponent(query))
        .then(r => r.json()).then(j => setContentHits(new Set(j.names || []))).catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [query, folder && folder.path]);

  function onPick(path) {
    setPickerOpen(false);
    if (pickerMode === "people") { setPickerMode("folder"); setPeopleOrigin("global"); setPeopleFolder({ path, name: path.split(/[\\/]/).filter(Boolean).pop() || path }); return; }
    loadFolder(path);
  }
  // open the global People destination (sidebar) — no folder needed
  function openPeople() { setFocusFile(null); setPeopleFolder(null); setPeopleOrigin("gallery"); setView("people"); }
  // open the knowledge graph destination (sidebar)
  function openGraph() { setFocusFile(null); setView("graph"); }
  // open the Activity destination (sidebar) — scheduled agents + their digest feed
  function openActivity() { setFocusFile(null); setView("activity"); }
  // jump to the main chat and ask the agent about an entity (from the knowledge graph "Ask about this")
  const [pendingAsk, setPendingAsk] = useState(null);
  function askAbout(text) { setFocusFile(null); setActiveAgentId(null); setView("chat"); setPendingAsk(text); }
  useEffect(() => {
    if (pendingAsk && view === "chat" && chatControls && chatControls.send && !chatControls.busy) {
      chatControls.send(pendingAsk); setPendingAsk(null);
    }
  }, [pendingAsk, view, chatControls]);
  // pick a folder to scan within People (native dialog on desktop, in-app picker in a browser)
  function pickFolderForPeople() {
    if (window.heapchat && window.heapchat.pickFolder) { window.heapchat.pickFolder(pickerStart()).then(p => { if (p) { setPeopleOrigin("global"); setPeopleFolder({ path: p, name: p.split(/[\\/]/).filter(Boolean).pop() || p }); } }); return; }
    setPickerMode("people"); setPickerOpen(true);
  }
  function onPickFile(file) { setPickerOpen(false); openFile(file); }

  // where a picker should start: the current folder, else the user's home
  function pickerStart() { return (folder && !folder.single ? folder.path : null) || (config && config.home) || undefined; }
  // open a folder — native OS dialog in the desktop app, the in-app browser in a plain browser
  function browseFolder() {
    if (window.heapchat && window.heapchat.pickFolder) { window.heapchat.pickFolder(pickerStart()).then(p => { if (p) loadFolder(p); }); return; }
    setPickerOpen(true);
  }
  // open a folder OR a file — native dialog (desktop) routes by type; browser uses the in-app picker
  function browsePath() {
    if (window.heapchat && window.heapchat.pickPath) {
      window.heapchat.pickPath(pickerStart()).then(r => { if (r && r.path) (r.isDirectory ? loadFolder(r.path) : openRecentFile(r.path)); });
      return;
    }
    setPickerOpen(true);
  }

  function openKB() { if (config?.kb) loadFolder(config.kb, false); }
  function openGenerated() { if (config?.generated) loadFolder(config.generated, false); }

  async function uploadToKB(fileList) {
    const list = Array.from(fileList || []);
    if (!list.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      list.forEach(f => fd.append("files", f));
      const r = await fetch("/api/kb/upload", { method: "POST", body: fd });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Upload failed");
      const skipped = list.length - (j.saved ? j.saved.length : 0);
      setToast(`Added ${j.saved.length} file${j.saved.length === 1 ? "" : "s"} to knowledge base${skipped ? ` (${skipped} unsupported)` : ""}`);
      setTimeout(() => setToast(null), 2400);
      if (config?.kb) await loadFolder(config.kb, false);
      if (saved.autoExtract && j.savedPaths && j.savedPaths.length)   // auto-extract the just-uploaded documents
        setExtractTarget({ name: `${j.savedPaths.length} uploaded document${j.savedPaths.length === 1 ? "" : "s"}`, paths: j.savedPaths, auto: true });
    } catch (e) {
      setToast("Upload failed: " + e.message); setTimeout(() => setToast(null), 2600);
    } finally { setUploading(false); }
  }

  async function deleteFromKB(file) {
    if (!window.confirm(`Remove "${file.name}" from the knowledge base?`)) return;
    try {
      await fetch("/api/kb?path=" + encodeURIComponent(file.path), { method: "DELETE" });
      if (focusFile && focusFile.id === file.id) setFocusFile(null);
      if (config?.kb) await loadFolder(config.kb, false);
    } catch {}
  }
  function toggleStar(id) { setStarred(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; }); }

  function saveSettings() {
    localStorage.setItem(settingsKey, JSON.stringify(draft));
    setSaved(draft);
    setToast("Settings saved");
    setTimeout(() => setToast(null), 1800);
  }
  function resetSettings() {
    const base = { ...DEFAULT_SETTINGS, model: config?.model || "", agentModel: config?.agentModel || "", endpoint: config?.endpoint || "" };
    setDraft(base);
  }
  function setDraftPartial(p) { setDraft(d => ({ ...d, ...p })); }

  // first-run setup gate: pin the just-installed model as the app default, then re-check Ollama
  function applySetupModel(name) {
    const next = { ...saved, model: name, agentModel: name };
    localStorage.setItem(settingsKey, JSON.stringify(next));
    setSaved(next); setDraft(d => ({ ...d, model: name, agentModel: name }));
  }
  function finishSetup() {
    Promise.all([
      fetch("/api/health").then(r => r.json()).catch(() => ({ ok: false })),
      fetch("/api/models").then(r => r.json()).catch(() => ({ models: [] })),
    ]).then(([h, m]) => { setOnline(!!h.ok); setModels(m.models || []); });
    setSetupSkipped(true);
  }
  // show the gate once we know Ollama is unreachable or has no model — and the user hasn't dismissed it
  const needsSetup = bootChecked && !setupSkipped && (!online || models.length === 0);

  // filter + sort
  const counts = { all: files.length };
  files.forEach(f => counts[f.kind] = (counts[f.kind] || 0) + 1);
  const folderTags = [...new Set(files.flatMap(f => f.tags || []))].sort();
  let shown = files.filter(f => {
    if (typeFilter !== "all" && f.kind !== typeFilter) return false;
    if (tagFilter && !(f.tags || []).includes(tagFilter)) return false;
    if (query.trim()) return f.name.toLowerCase().includes(query.toLowerCase()) || contentHits.has(f.name);
    return true;
  });
  if (sort === "name") shown = [...shown].sort((a, b) => a.name.localeCompare(b.name));
  else if (sort === "type") shown = [...shown].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  else if (sort === "size") shown = [...shown].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  // "recent" keeps the server's mtime order

  // subfolders show only on the "all" tab; filtered by name when searching
  const shownDirs = (typeFilter === "all")
    ? dirs.filter(d => !query.trim() || d.name.toLowerCase().includes(query.toLowerCase()))
    : [];

  const navItems = [["all", "All files", "layers"], ["photo", "Images", "image"], ["doc", "Documents", "file"], ["video", "Video", "video"], ["audio", "Audio", "music"]];
  const folderOpen = !!folder;
  // members with no folder grants live entirely in their private KB — hide disk browsing
  const canBrowse = !config || config.role === "admin" || (config.folders || []).length > 0;
  const crumbs = folder && !folder.single && !folder.kb ? pathCrumbs(folder.path) : [];

  // command palette (⌘K) entries: actions + recents + current folder's files
  const commands = [
    ...(canBrowse ? [{ label: "Open folder or file…", hint: "browse", icon: "folderOpen", color: "var(--accent)", run: () => browsePath() }] : []),
    { label: "Knowledge base", hint: "open", icon: "layers", run: openKB },
    { label: "Chat", hint: "agent", icon: "sparkles", run: () => { setView("chat"); setFocusFile(null); } },
    { label: "All chats", hint: "history", icon: "clock", run: () => { setView("chats"); setFocusFile(null); } },
    { label: "Manage", hint: "indexes", icon: "sliders", run: () => { setView("manage"); setFocusFile(null); } },
    { label: "Settings", hint: "config", icon: "settings", run: () => { setView("settings"); setFocusFile(null); } },
    ...recents.map(r => ({ label: r.name, hint: "recent", icon: r.type === "file" ? (KIND_META[kindFromName(r.name)] || KIND_META.doc).icon : "folder", run: () => openRecent(r) })),
    ...files.map(f => ({ label: f.name, hint: folder ? folder.name : "file", icon: KIND_META[f.kind].icon, color: (f.kind === "doc" ? docMeta(f.ext) : KIND_META[f.kind]).c, run: () => { setView("gallery"); setFocusFile(f); } })),
  ];

  // first-run gate: before the app shell, when Ollama isn't ready yet
  if (needsSetup) return <OllamaSetup onDone={finishSetup} onModel={applySetupModel} onSkip={() => setSetupSkipped(true)} />;

  return (
    <div className="app">
      <Sidebar
        sideCollapsed={sideCollapsed} toggleSide={toggleSide} startNewChat={startNewChat} openKB={openKB} openGenerated={openGenerated}
        folder={folder} view={view} openPeople={openPeople} openGraph={openGraph} openActivity={openActivity}
        canBrowse={canBrowse} browseFolder={browseFolder} setProjectEditModal={setProjectEditModal}
        projects={projects} currentProject={currentProject} openProject={openProject}
        setAgentEditModal={setAgentEditModal} agents={agents} activeAgentId={activeAgentId} openAgentChat={openAgentChat}
        chatQuery={chatQuery} setChatQuery={setChatQuery} recentChats={recentChats} openSession={openSession}
        delRecentChat={delRecentChat} setView={setView} setFocusFile={setFocusFile}
        lastFolder={lastFolder} returnToFolder={returnToFolder} recents={recents} openRecent={openRecent}
        profileOpen={profileOpen} setProfileOpen={setProfileOpen} config={config} />

      {/* ---------------- MAIN ---------------- */}
      <main className="main">
        {view === "settings" ? (
          <SettingsPage settings={draft} set={setDraftPartial} onSave={saveSettings} onReset={resetSettings} online={online} models={models}
            account={config ? { user: config.user, role: config.role, userId: config.userId } : null}
            providers={config ? (config.providers || []) : []} />
        ) : view === "manage" ? (
          <ManagePage onOpenFolder={f => loadFolder(f)} />
        ) : view === "projects" ? (
          <ProjectsHub projects={projects} onOpen={openProject} onNew={() => setProjectEditModal({})} />
        ) : view === "agents" ? (
          <AgentsHub agents={agents} onChat={openAgentChat} onEdit={setAgentEditModal} onNew={() => setAgentEditModal({})} onImported={reloadAgents} />
        ) : view === "activity" ? (
          <ActivityPage agents={agents} projects={projects} />
        ) : view === "chats" ? (
          <ChatsHub onOpen={(s, info) => openSession(s, info)} />
        ) : view === "map" && folder ? (
          <PhotoMap folder={folder} onOpenPath={openByPath} onClose={() => setView("gallery")} />
        ) : view === "graph" ? (
          <GraphPage onOpenPath={openByPath} onAsk={askAbout} placeLookup={saved.placeLookup === true} />
        ) : view === "people" ? (
          peopleFolder
            ? <PeopleView folder={peopleFolder}
                onClose={() => { if (peopleOrigin === "global") setPeopleFolder(null); else setView("gallery"); }} />
            : <GlobalPeopleView onPickFolder={pickFolderForPeople} onClose={() => setView(folder ? "gallery" : "chat")} />
        ) : view === "project" && currentProject ? (
          projectSubView === "chat" ? (
            <div className="col grow" style={{ minHeight: 0, position: "relative" }}>
              {projectChatControls && projectChatControls.msgCount > 1 && (
                <button className="chat-export-float" title="Export chat to Markdown" onClick={projectChatControls.exportChat}><Icon name="download" size={16} /></button>
              )}
              <div className="topbar" style={{ borderBottom: "1px solid var(--border)" }}>
                <button className="btn sm ghost" onClick={() => setProjectSubView("hub")} style={{ marginRight: 8 }}>
                  <Icon name="arrowL" size={14} />
                </button>
                <span className="proj-dot-sm" style={{ background: currentProject.color }} />
                <Icon name={currentProject.icon} size={15} style={{ color: currentProject.color }} />
                <span className="crumb-name">{currentProject.name}</span>
              </div>
              <div className="content">
                <ChatPanel variant="main"
                  target={{ scope: "agent", domain: "kb", id: "proj-" + currentProject.id, name: currentProject.name, projectId: currentProject.id }}
                  settings={saved} online={online} models={models} initialSessionId={pendingProjectSession}
                  agents={agents} onNewAgent={() => setAgentEditModal({})}
                  onOpenPath={openSourcePreview} onControls={setProjectChatControls} />
              </div>
            </div>
          ) : (
            <ProjectView project={currentProject}
              onNewChat={startProjectChat}
              onOpenSession={openProjectSession}
              onOpenPath={openByPath}
              tab={projectHubTab} setTab={setProjectHubTab}
              onEdit={() => setProjectEditModal(currentProject)}
              onDelete={async () => {
                if (!window.confirm(`Delete project "${currentProject.name}" and all its chats?`)) return;
                await ProjectAPI.remove(currentProject.id);
                reloadProjects();
                setCurrentProject(null);
                setView("gallery");
              }} />
          )
        ) : view === "chat" ? (
          <div className="col grow" style={{ minHeight: 0, position: "relative" }}>
            {chatControls && chatControls.msgCount > 1 && (
              <button className="chat-export-float" title="Export chat to Markdown" onClick={chatControls.exportChat}><Icon name="download" size={16} /></button>
            )}
            <div className="content">
              <ChatPanel variant="main" key={"mainchat-" + (activeAgentId || "default")}
                target={{ scope: "agent", domain: "kb", id: "agent", name: "Heap Chat Agent" }}
                settings={saved} online={online} models={models} initialSessionId={pendingSession}
                agents={agents} initialAgentId={activeAgentId} onNewAgent={() => setAgentEditModal({})}
                onOpenPath={openSourcePreview} onControls={setChatControls} />
            </div>
          </div>
        ) : !folderOpen ? (
          <div className="empty">
            <div className="dropzone">
              <div className="dz-mark"><Icon name="folderOpen" size={30} sw={1.6} /></div>
              <div className="x-bold tighter" style={{ fontSize: 22, marginBottom: 8 }}>Open a folder to begin</div>
              <div className="ink-3 t-md" style={{ marginBottom: 22, maxWidth: 360, marginInline: "auto" }}>
                Heap Chat indexes every file so you can browse them like a board — and ask a local AI questions about any one of them.
              </div>
              {loadError && <div className="callout warn" style={{ marginBottom: 18, textAlign: "left" }}><Icon name="alert" size={16} /><span>{loadError}</span></div>}
              <div className="row center gap-3">
                {canBrowse
                  ? <button className="btn primary" onClick={browsePath}><Icon name="folderOpen" size={16} /> Choose folder or file</button>
                  : <button className="btn primary" onClick={openKB}><Icon name="layers" size={16} /> Open your knowledge base</button>}
              </div>
              {recents.length > 0 && (
                <div className="row center gap-2 wrap" style={{ marginTop: 26 }}>
                  <span className="t-xs up" style={{ width: "100%" }}>Recent</span>
                  {recents.map(r => <button key={r.path} className="chip" title={r.path} onClick={() => openRecent(r)}><Icon name={r.type === "file" ? (KIND_META[kindFromName(r.name)] || KIND_META.doc).icon : "folder"} size={12} /> {r.name}</button>)}
                </div>
              )}
            </div>
          </div>
        ) : focusFile ? (
          <div className="content">
            <FocusView file={focusFile} files={shown.length ? shown : files}
              onClose={() => { if (folder && folder.single) goBack(returnTo); else setFocusFile(null); }}
              onSelect={setFocusFile} starred={starred.has(focusFile.id)} onToggleStar={() => toggleStar(focusFile.id)} onOpenPath={openByPath}
              onExtract={() => setExtractTarget(focusFile)} settings={saved} />
            <ChatPanel target={focusFile.kind === "photo"
              ? { scope: "file", id: focusFile.id, name: focusFile.name, path: focusFile.path, kind: focusFile.kind, file: focusFile }
              : { scope: "agent", domain: "file", id: focusFile.id, name: focusFile.name, path: focusFile.path, kind: focusFile.kind, file: focusFile }}
              settings={saved} online={online} models={models} width={chatWidth} onResize={setChatW} initialSessionId={pendingSession} />
          </div>
        ) : (
          <div className="content">
            <div className="col grow" style={{ minWidth: 0 }}>
            <GalleryTopbar
              parent={parent} loadFolder={loadFolder} crumbs={crumbs} folder={folder} shown={shown} shownDirs={shownDirs}
              query={query} setQuery={setQuery} sort={sort} setSort={setSort} sortOpen={sortOpen} setSortOpen={setSortOpen}
              uploading={uploading} fileInputRef={fileInputRef} idx={idx} runIndex={runIndex} counts={counts} setView={setView}
              setPeopleOrigin={setPeopleOrigin} setPeopleFolder={setPeopleFolder} setDupOpen={setDupOpen}
              setExtractTarget={setExtractTarget} folderChatOpen={folderChatOpen} setFolderChatOpen={setFolderChatOpen} />
            <GalleryBody
              dragOver={dragOver} setDragOver={setDragOver} uploadToKB={uploadToKB} folder={folder}
              fileInputRef={fileInputRef} loadingFiles={loadingFiles} shown={shown} uploading={uploading}
              folderTags={folderTags} tagFilter={tagFilter} setTagFilter={setTagFilter} shownDirs={shownDirs}
              colW={CARD_W} focusFile={focusFile} setFocusFile={setFocusFile} loadFolder={loadFolder}
              deleteFromKB={deleteFromKB} selected={selected} toggleCheck={toggleCheck} />
            </div>
            {folderChatOpen && !selChat && (
              <ChatPanel target={{ scope: "agent", domain: "folder", id: b64url(folder.path), name: folder.name, path: folder.path }}
                settings={saved} online={online} models={models} onClose={() => setFolderChatOpen(false)}
                onOpenPath={openSourcePreview} width={chatWidth} onResize={setChatW} initialSessionId={pendingSession} />
            )}
            {selChat && (
              <ChatPanel target={selChat}
                settings={saved} online={online} models={models} onClose={() => setSelChat(null)}
                onOpenPath={openSourcePreview} width={chatWidth} onResize={setChatW} initialSessionId={pendingSession} />
            )}
          </div>
        )}
      </main>

      {pickerOpen && <FolderPicker startPath={(folder && !folder.single ? folder.path : null) || config?.home} onPick={onPick} onPickFile={onPickFile} onClose={() => setPickerOpen(false)} />}

      {extractTarget && <ExtractModal target={extractTarget} onClose={() => setExtractTarget(null)} />}

      {dupOpen && folder && <DuplicatesModal folder={folder} onClose={() => setDupOpen(false)}
        onDeleted={n => { setDupOpen(false); flashToast(`Deleted ${n} duplicate${n === 1 ? "" : "s"}`); loadFolder(folder.path, false); }} />}

      {renamePaths && <RenameModal paths={renamePaths} onClose={() => setRenamePaths(null)}
        onDone={n => { setRenamePaths(null); flashToast(n ? `Renamed ${n} file${n === 1 ? "" : "s"}` : "No files renamed"); clearSel(); if (folder) loadFolder(folder.path, false); }} />}

      {sourcePreview && <SourceDrawer sourcePreview={sourcePreview} setSourcePreview={setSourcePreview} openFile={openFile} />}

      {selected.size > 0 && view === "gallery" && !focusFile && (
        <BatchBar selected={selected} files={files} folder={folder} askSelection={askSelection}
          batchAutoTag={batchAutoTag} setRenamePaths={setRenamePaths} batchAddToKB={batchAddToKB}
          batchTag={batchTag} batchMakeSearchable={batchMakeSearchable} batchDelete={batchDelete} clearSel={clearSel} />
      )}

      {cmdkOpen && <CommandPalette commands={commands} onClose={() => setCmdkOpen(false)} />}

      {projectEditModal !== null && (
        <ProjectEditModal
          project={Object.keys(projectEditModal).length ? projectEditModal : null}
          onSave={p => {
            setProjectEditModal(null);
            reloadProjects();
            if (currentProject && p.id === currentProject.id) setCurrentProject(p);
          }}
          onClose={() => setProjectEditModal(null)} />
      )}

      {agentEditModal !== null && (
        <AgentEditModal
          agent={Object.keys(agentEditModal).length ? agentEditModal : null}
          models={models}
          providers={config ? (config.providers || []) : []}
          onSave={a => { setAgentEditModal(null); reloadAgents(); }}
          onDelete={a => { setAgentEditModal(null); reloadAgents(); if (activeAgentId === a.id) { setActiveAgentId(null); } }}
          onClose={() => setAgentEditModal(null)} />
      )}

      {toast && <div className="toast"><Icon name="check" size={16} /> {toast}</div>}
    </div>
  );
}

// auth gate: setup screen on first run, sign-in when logged out, the app once authenticated
function Root() {
  const [auth, setAuth] = useState({ state: "loading" });
  useEffect(() => {
    fetch("/api/auth/me").then(async r => {
      const j = await r.json().catch(() => ({}));
      if (j.setup) setAuth({ state: "setup" });
      else if (!r.ok) setAuth({ state: "login" });
      else setAuth({ state: "ready", user: j.user });
    }).catch(() => setAuth({ state: "login" }));
  }, []);
  if (auth.state === "loading") return null;
  // the desktop Quick Ask panel loads the app with ?quick=1 — render the compact panel instead of the full shell
  const isQuick = new URLSearchParams(location.search).get("quick") === "1";
  if (isQuick) {
    if (auth.state !== "ready") return <div className="quick-wrap"><div className="quick-empty" style={{ padding: 40, height: "auto" }}><Icon name="layers" size={22} /><span>Open Heap Chat and sign in first.</span></div></div>;
    return <QuickAsk />;
  }
  if (auth.state !== "ready") return <AuthScreen mode={auth.state} onAuth={() => { location.href = "/"; }} />;
  return <App user={auth.user} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(<Root />);

export { App, CARD_W };
