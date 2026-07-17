import { Icon } from "./icons.jsx";
import { sessionSource } from "./chats.jsx";

const { useState, useEffect } = React;

const ACCENT_OPTS = [
  { val: "#4F46E5", label: "Indigo" },
  { val: "#D2542E", label: "Ember" },
  { val: "#2E7D6B", label: "Teal" },
  { val: "#7A3E8E", label: "Purple" },
  { val: "#2A2622", label: "Ink" },
];

function applyAccent(hex) {
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n>>16)&255,(n>>8)&255,n&255]; }
  function mixW(h, a) { const [r,g,b] = hexRgb(h); return `rgb(${Math.round(r+(255-r)*a)},${Math.round(g+(255-g)*a)},${Math.round(b+(255-b)*a)})`; }
  function dark(h, a) { const [r,g,b] = hexRgb(h); return `rgb(${Math.round(r*(1-a))},${Math.round(g*(1-a))},${Math.round(b*(1-a))})`; }
  const s = document.documentElement.style;
  s.setProperty("--accent", hex);
  s.setProperty("--accent-hover", dark(hex, 0.22));
  s.setProperty("--accent-deep", dark(hex, 0.22));
  s.setProperty("--accent-soft", mixW(hex, 0.86));
  s.setProperty("--accent-soft-2", mixW(hex, 0.74));
}

function Sidebar({
  sideCollapsed, toggleSide, startNewChat, openKB, folder, view,
  openPeople, openGraph, openActivity, canBrowse, browseFolder,
  setProjectEditModal, projects, currentProject, openProject,
  setAgentEditModal, agents, activeAgentId, openAgentChat,
  chatQuery, setChatQuery, recentChats, openSession, delRecentChat,
  setView, setFocusFile, profileOpen, setProfileOpen, config, openGenerated,
  lastFolder, returnToFolder,
}) {
  const kbActive = folder && folder.kb && view === "gallery";
  const generatedActive = folder && folder.generated && view === "gallery";
  const folderActive = folder && !folder.kb && !folder.generated && !folder.single && view === "gallery";

  const [accent, setAccentState] = useState(() => localStorage.getItem("heapchat.accent") || "#4F46E5");
  useEffect(() => { applyAccent(accent); }, []);

  function setAccent(hex) {
    localStorage.setItem("heapchat.accent", hex);
    setAccentState(hex);
    applyAccent(hex);
  }

  function go(v) { setView(v); setFocusFile(null); }

  return (
    <aside className={"sidebar" + (sideCollapsed ? " collapsed" : "")}>

      {/* ── brand ── */}
      <div className="rail-top">
        <div className="brand-mark">
          <Icon name="layers" size={18} sw={2} />
        </div>
        <span className="brand-name">Heap Chat</span>
        <button className="side-collapse" onClick={toggleSide}
          title={sideCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
          <Icon name={sideCollapsed ? "chevR" : "chevL"} size={16} />
        </button>
      </div>

      {/* ── new chat ── */}
      <button className="rail-new" onClick={startNewChat}>
        <Icon name="plus" size={17} />
        <span className="rail-label">New chat</span>
        <span className="rail-tip">New chat</span>
      </button>

      {/* ── Workspace ── */}
      <div className="rail-group-label">Workspace</div>

      <button className={"nav-item" + (kbActive ? " on" : "")} onClick={openKB}>
        <Icon name="grid" size={17} />
        <span className="rail-label">Knowledge base</span>
        <span className="rail-tip">Knowledge base</span>
      </button>

      <button className={"nav-item" + (generatedActive ? " on" : "")} onClick={openGenerated}>
        <Icon name="image" size={17} />
        <span className="rail-label">Created images</span>
        <span className="rail-tip">Created images</span>
      </button>

      {/* Projects — single nav link + inline new button */}
      <div className="nav-row">
        <button className={"nav-item" + (view === "projects" || (view === "project" && currentProject) ? " on" : "")}
          style={{ flex: 1 }} onClick={() => go("projects")}>
          <Icon name="layers" size={17} />
          <span className="rail-label">Projects</span>
          <span className="rail-tip">Projects</span>
        </button>
        <button className="nav-row-add" title="New project" onClick={() => setProjectEditModal({})}>
          <Icon name="plus" size={13} />
        </button>
      </div>

      {/* Agents — single nav link + inline new button */}
      <div className="nav-row">
        <button className={"nav-item" + (view === "agents" ? " on" : "")}
          style={{ flex: 1 }} onClick={() => go("agents")}>
          <Icon name="bolt" size={17} />
          <span className="rail-label">Agents</span>
          <span className="rail-tip">Agents</span>
        </button>
        <button className="nav-row-add" title="New agent" onClick={() => setAgentEditModal({})}>
          <Icon name="plus" size={13} />
        </button>
      </div>

      {/* ── separator (shows as thin rule when collapsed) ── */}
      <div className="rail-sep" />

      {/* ── Explore ── */}
      <div className="rail-group-label">Explore</div>

      {canBrowse && (() => {
        const showReturn = lastFolder && !lastFolder.kb && !lastFolder.generated;
        return (
        <>
          {/* return to the last browsed folder from anywhere (its context is kept across views/restarts) */}
          {showReturn && (
            <button className={"nav-item" + (folderActive ? " on" : "")} onClick={returnToFolder} title={lastFolder.path}>
              <Icon name="folder" size={17} />
              <span className="rail-label">{lastFolder.name}</span>
              <span className="rail-tip">{lastFolder.name}</span>
            </button>
          )}
          <button className={"nav-item" + (!showReturn && folderActive ? " on" : "")} onClick={browseFolder}>
            <Icon name="folderOpen" size={17} />
            <span className="rail-label">{showReturn ? "Open another folder" : "Open folder"}</span>
            <span className="rail-tip">Open folder</span>
          </button>
        </>
        );
      })()}

      <button className={"nav-item" + (view === "people" ? " on" : "")} onClick={openPeople}>
        <Icon name="brain" size={17} />
        <span className="rail-label">People</span>
        <span className="rail-tip">People</span>
      </button>

      <button className={"nav-item" + (view === "graph" ? " on" : "")} onClick={openGraph}>
        <Icon name="compass" size={17} />
        <span className="rail-label">Knowledge graph</span>
        <span className="rail-tip">Knowledge graph</span>
      </button>

      <button className={"nav-item" + (view === "activity" ? " on" : "")} onClick={openActivity}>
        <Icon name="calendar" size={17} />
        <span className="rail-label">Activity</span>
        <span className="rail-tip">Activity</span>
      </button>

      {/* ── chat search (expanded only) ── */}
      <div className="side-chats-search">
        <Icon name="search" size={13} style={{ color: "var(--ink-4)", flex: "none" }} />
        <input placeholder="Search chats" value={chatQuery} onChange={e => setChatQuery(e.target.value)} />
        {chatQuery && (
          <button className="side-chats-clear" onClick={() => setChatQuery("")}>
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      {/* ── recent chats (scrollable) ── */}
      <div className="side-scroll scroll side-chats">
        {recentChats.length === 0 ? (
          <div className="side-chats-empty">{chatQuery ? "No chats match." : "No chats yet"}</div>
        ) : (
          <>
            {recentChats.map(s => {
              const info = sessionSource(s);
              return (
                <button key={s.fileId + s.id} className="side-chat"
                  title={(s.title || "New chat") + " · " + info.label}
                  onClick={() => openSession(s, info)}>
                  <Icon name={info.icon} size={13} style={{ flex: "none", color: "var(--ink-3)" }} />
                  <span className="truncate grow">{s.title || "New chat"}</span>
                  <span className="side-chat-del" title="Delete chat" onClick={e => delRecentChat(s, e)}>
                    <Icon name="x" size={11} />
                  </span>
                </button>
              );
            })}
            <button className="side-chat side-chat-all" onClick={() => go("chats")}>
              <Icon name="clock" size={12} style={{ flex: "none" }} /> All chats…
            </button>
          </>
        )}
      </div>

      {/* ── spacer: fills height when scroll is hidden (collapsed state) ── */}
      <div className="rail-spacer" />

      {/* ── footer ── */}
      <div className="side-footer">

        <button className={"nav-item" + (view === "manage" ? " on" : "")} onClick={() => go("manage")}>
          <Icon name="sliders" size={17} />
          <span className="rail-label">Manage</span>
          <span className="rail-tip">Manage</span>
        </button>

        <button className={"nav-item" + (view === "settings" ? " on" : "")} onClick={() => go("settings")}>
          <Icon name="settings" size={17} />
          <span className="rail-label">Settings</span>
          <span className="rail-tip">Settings</span>
        </button>

        {/* theme colour swatches */}
        <div className="theme-swatches">
          {ACCENT_OPTS.map(o => (
            <button key={o.val} className={"theme-swatch" + (accent === o.val ? " on" : "")}
              style={{ background: o.val }} title={o.label} onClick={() => setAccent(o.val)} />
          ))}
        </div>

        {/* profile */}
        <div className="profile-wrap">
          {profileOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setProfileOpen(false)} />
              <div className="profile-menu">
                <button className="profile-menu-item"
                  onClick={async () => { await fetch("/api/auth/logout", { method: "POST" }).catch(() => {}); location.href = "/"; }}>
                  <Icon name="arrowL" size={15} /> Sign out
                </button>
              </div>
            </>
          )}
          <button className="rail-user" onClick={() => setProfileOpen(o => !o)} title={config?.user || "User"}>
            <span className="rail-ava">{(config?.user || "U").slice(0, 1).toUpperCase()}</span>
            <span className="rail-user-meta">
              <span className="nm">{config?.user || "User"}</span>
              <span className="rl">{config?.role || "local"}</span>
            </span>
          </button>
        </div>

      </div>
    </aside>
  );
}

export { Sidebar, applyAccent };
