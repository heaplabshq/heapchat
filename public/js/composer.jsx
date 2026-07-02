import { ChatPanel } from "./chat.jsx";
import { Icon } from "./icons.jsx";
import { AgentPicker } from "./agents.jsx";
/* Chat composer: the bottom input area — attached-image tray, uploaded-file
   chips, the autosizing textarea, the composer bar (+ attach/mode menu, agent
   picker, Think pill, model picker, send/stop), and the hidden file inputs.
   Extracted from the ChatPanel component in chat.jsx. Global-scope module
   (indirect-eval): Composer leaks to global for chat.jsx; Icon (icons.jsx) and
   AgentPicker (agents.jsx) resolve as globals at render time.

   The long prop list is deliberate: ChatPanel still owns all the composer state
   (val/attachments/mode toggles/model choice) because send() reads them, so they
   are threaded down as props. A later step could move that state into Composer
   and expose a single onSend callback. */

// context-fill meter: a small donut showing how full the model's context window is. Turns amber near
// the limit; past 100% the server auto-summarizes older turns. Click it for a used/available/total
// breakdown. `real` = the numbers are actual prompt tokens from the server (vs a pre-first-turn estimate).
function CtxRow({ label, val }) {
  return <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "3px 0" }}>
    <span className="ink-3">{label}</span><span className="mono">{val}</span>
  </div>;
}
function ContextMeter({ used = 0, max = 8192, real = false }) {
  if (!max) return null;
  const [open, setOpen] = React.useState(false);
  const pct = Math.max(0, Math.min(1, used / max));
  const over = used >= max, near = pct >= 0.8;
  const color = over || near ? "var(--warn)" : "var(--good)";
  const R = 7, C = 2 * Math.PI * R;
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(Math.round(n));
  const avail = Math.max(0, max - used);
  return (
    <span className="dropdown" style={{ position: "relative", display: "inline-flex" }}>
      <button className="ctx-meter" title={`Context ${Math.round(pct * 100)}% full — click for details`}
        onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", background: "none", border: "none", padding: 2, cursor: "pointer", lineHeight: 0 }}>
        <svg width="18" height="18" viewBox="0 0 20 20" style={{ display: "block" }}>
          <circle cx="10" cy="10" r={R} fill="none" stroke="var(--line)" strokeWidth="2.5" />
          <circle cx="10" cy="10" r={R} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round"
            strokeDasharray={C} strokeDashoffset={C * (1 - pct)} transform="rotate(-90 10 10)" />
        </svg>
      </button>
      {open && <>
        <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
        <div className="dd-menu" style={{ bottom: "calc(100% + 8px)", top: "auto", right: 0, left: "auto", width: 232, zIndex: 41 }}>
          <div className="dd-label">Context window{real ? "" : " (estimated)"}</div>
          <div style={{ padding: "2px 12px 10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 7 }}>
              <span className="semi" style={{ color }}>{Math.round(pct * 100)}% full</span>
              <span className="mono ink-3">{fmt(used)} / {fmt(max)}</span>
            </div>
            <div style={{ height: 6, borderRadius: 4, background: "var(--line)", overflow: "hidden", marginBottom: 9 }}>
              <div style={{ height: "100%", width: (pct * 100) + "%", background: color, borderRadius: 4 }} />
            </div>
            <CtxRow label="Used" val={fmt(used) + " tok"} />
            <CtxRow label="Available" val={fmt(avail) + " tok"} />
            <CtxRow label="Total window" val={fmt(max) + " tok"} />
            <div className="t-xs ink-4" style={{ marginTop: 8, lineHeight: 1.45 }}>
              {real ? "Actual tokens the model read last turn." : "Estimated from the conversation so far."}
              {over ? " Older turns are summarized to fit." : ""}
            </div>
          </div>
        </div>
      </>}
    </span>
  );
}

function Composer({
  attachImgs, setAttachImgs, files, setFiles, val, setVal, taRef, maxAttach,
  isAgent, isFolder, isAssistant, isGeneral, target, send, stop, busy, addAttachImages, addFiles,
  plusOpen, setPlusOpen, imgInRef, filesInRef, dirInRef,
  webOn, setWebOn, researchOn, setResearchOn, deepOn, setDeepOn, deepWorkOn, setDeepWorkOn,
  factCheckOn, setFactCheckOn, useFilesOn, setUseFilesOn, useMemoryOn, setUseMemoryOn,
  agents, agentId, applyAgent, onNewAgent, thinkOn, setThinkOn, ctxUsed, ctxMax, ctxReal,
  online, modelOpen, setModelOpen, effectiveModel, modelOverride, setModelOverride, defaultModel, models, imageGenOn,
}) {
  // slash-command hints — shown while typing the command (before the first space)
  const SLASH_CMDS = [
    { cmd: "/read", icon: "globe", desc: "Scrape & summarize a pasted link (no web search)" },
    ...(imageGenOn ? [
      { cmd: "/image-create", icon: "image", desc: "Generate an image from a text prompt" },
      { cmd: "/image-edit", icon: "sparkles", desc: "Transform the attached / most recent image" },
    ] : []),
  ];
  const typingCmd = val.startsWith("/") && !val.includes(" ");
  const slashMatches = typingCmd ? SLASH_CMDS.filter(c => c.cmd.startsWith(val.toLowerCase())) : [];
  return (
    <div className="chat-foot">
      <div className="composer">
        {slashMatches.length > 0 && (
          <div className="dd-menu" style={{ bottom: "calc(100% + 4px)", top: "auto", left: 0, width: 320, position: "absolute" }}>
            <div className="dd-label">Commands</div>
            {slashMatches.map(c => (
              <div key={c.cmd} className="dd-item" onClick={() => { setVal(c.cmd + " "); if (taRef.current) taRef.current.focus(); }}>
                <Icon name={c.icon} size={15} style={{ color: "var(--accent)" }} />
                <div className="col" style={{ gap: 1 }}>
                  <span className="mono" style={{ fontSize: 13 }}>{c.cmd}</span>
                  <span className="t-xs ink-3">{c.desc}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {attachImgs.length > 0 && (
          <div className="attach-imgs">
            {attachImgs.map((im, k) => (
              <div className="attach-thumb" key={k} title={im.name}>
                <img src={im.url} alt={im.name} />
                <button className="attach-thumb-x" title="Remove" onClick={() => setAttachImgs(prev => prev.filter((_, j) => j !== k))}><Icon name="x" size={11} /></button>
              </div>
            ))}
            <span className="t-xs ink-3 attach-imgs-note">{attachImgs.length}/{maxAttach} {isAgent ? "image" + (attachImgs.length > 1 ? "s" : "") : "· vision Q&A"}</span>
          </div>
        )}
        {files.length > 0 && (
          <div className="att-chips">
            {files.map((f, k) => (
              <span key={k} className={"att-chip" + (f.uploading ? " uploading" : "")}>
                {f.uploading ? <span className="spin-mini" /> : <Icon name="file" size={12} sw={1.8} />}
                <span className="truncate">{f.name}</span>
                {!f.uploading && <button className="att-x" title="Remove" onClick={() => setFiles(prev => prev.filter(x => x !== f))}><Icon name="x" size={11} /></button>}
              </span>
            ))}
          </div>
        )}
        <textarea ref={taRef} rows={1} value={val} placeholder={`Ask about ${isFolder ? "this folder" : target.name}…`}
          onChange={e => { setVal(e.target.value); const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 130) + "px"; }}
          onPaste={e => {
            // paste image(s) straight into the composer (clipboard screenshot / copied photos) → attach;
            // plain text falls through to the textarea's normal paste
            const pics = [...(e.clipboardData?.items || [])].filter(it => it.type.startsWith("image/")).map(it => it.getAsFile()).filter(Boolean);
            if (!pics.length) return;
            e.preventDefault();
            addAttachImages(pics);
          }}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <div className="composer-bar">
          <div className="dropdown" style={{ position: "relative" }}>
            <button className="comp-btn" title="Attach / modes" onClick={() => setPlusOpen(o => !o)} style={{ position: "relative" }}>
              <Icon name="plus" size={17} />
              {(thinkOn || webOn || researchOn || deepOn || deepWorkOn || !factCheckOn || !useFilesOn || !useMemoryOn) && (
                <span style={{ position: "absolute", top: 3, right: 3, width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", pointerEvents: "none" }} />
              )}
            </button>
            {plusOpen && <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setPlusOpen(false)} />
              <div className="dd-menu" style={{ bottom: "calc(100% + 8px)", top: "auto", left: 0, width: 240 }}>
                <div className="dd-label">Attach</div>
                <div className="dd-item" onClick={() => { imgInRef.current.click(); setPlusOpen(false); }}>
                  <Icon name="image" size={15} style={{ color: "var(--ink-3)" }} />
                  <span style={{ fontSize: 13 }}>Photo — ask with vision</span>
                </div>
                {isAgent && <>
                  <div className="dd-item" onClick={() => { filesInRef.current.click(); setPlusOpen(false); }}>
                    <Icon name="upload" size={15} style={{ color: "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Files…</span>
                  </div>
                  <div className="dd-item" onClick={() => { dirInRef.current.click(); setPlusOpen(false); }}>
                    <Icon name="folder" size={15} style={{ color: "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Folder…</span>
                  </div>
                  <div className="dd-label" style={{ borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 8 }}>Mode</div>
                  <div className={"dd-item" + (webOn ? " on" : "")} onClick={() => setWebOn(o => !o)}>
                    <Icon name="globe" size={15} style={{ color: webOn ? "var(--accent)" : "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Search the web</span>
                    {webOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                  </div>
                  <div className={"dd-item" + (researchOn ? " on" : "")} onClick={() => setResearchOn(o => { const next = !o; if (next) setDeepOn(false); return next; })}>
                    <Icon name="compass" size={15} style={{ color: researchOn ? "var(--accent)" : "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Research</span>
                    {researchOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                  </div>
                  <div className={"dd-item" + (deepOn ? " on" : "")} onClick={() => setDeepOn(o => { const next = !o; if (next) { setResearchOn(false); setDeepWorkOn(false); } return next; })}>
                    <Icon name="flask" size={15} style={{ color: deepOn ? "var(--accent)" : "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Deep research</span>
                    {deepOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                  </div>
                  <div className={"dd-item" + (deepWorkOn ? " on" : "")} onClick={() => setDeepWorkOn(o => { const next = !o; if (next) { setResearchOn(false); setDeepOn(false); } return next; })}>
                    <Icon name="layers" size={15} style={{ color: deepWorkOn ? "var(--accent)" : "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Deep work — agent team</span>
                    {deepWorkOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                  </div>
                  <div className={"dd-item" + (factCheckOn ? " on" : "")} onClick={() => setFactCheckOn(o => !o)}>
                    <Icon name="check" size={15} style={{ color: factCheckOn ? "var(--accent)" : "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Fact-check answers</span>
                    {factCheckOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                  </div>
                </>}
                {/* Context controls — also available in the normal (assistant/general) chat, which uses RAG + memory */}
                {(isAgent || isAssistant || isGeneral) && <>
                  <div className="dd-label" style={{ borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 8 }}>Context</div>
                  {(isAgent || isAssistant) && (
                    <div className={"dd-item" + (useFilesOn ? " on" : "")} title="When off, the assistant won't search or pull context from your documents/knowledge base" onClick={() => setUseFilesOn(o => !o)}>
                      <Icon name="layers" size={15} style={{ color: useFilesOn ? "var(--accent)" : "var(--ink-3)" }} />
                      <span style={{ fontSize: 13 }}>Use my documents</span>
                      {useFilesOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                    </div>
                  )}
                  <div className={"dd-item" + (useMemoryOn ? " on" : "")} title="When off, the assistant ignores your long-term memory for this chat" onClick={() => setUseMemoryOn(o => !o)}>
                    <Icon name="brain" size={15} style={{ color: useMemoryOn ? "var(--accent)" : "var(--ink-3)" }} />
                    <span style={{ fontSize: 13 }}>Use memory</span>
                    {useMemoryOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                  </div>
                </>}
                {/* Think — applies to any model chat, so it lives outside the agent-only sections */}
                <div className="dd-label" style={{ borderTop: "1px solid var(--line)", marginTop: 4, paddingTop: 8 }}>Response</div>
                <div className={"dd-item" + (thinkOn ? " on" : "")} title="Let the model think step-by-step before answering" onClick={() => setThinkOn(o => !o)}>
                  <Icon name="brain" size={15} style={{ color: thinkOn ? "var(--accent)" : "var(--ink-3)" }} />
                  <span style={{ fontSize: 13 }}>Think step-by-step</span>
                  {thinkOn && <Icon name="check" size={13} style={{ marginLeft: "auto", color: "var(--accent)" }} />}
                </div>
              </div>
            </>}
          </div>
          {isAgent && (
            <AgentPicker agents={agents} value={agentId} onChange={applyAgent} onManage={onNewAgent} />
          )}
          <div className="comp-right">
          <ContextMeter used={ctxUsed} max={ctxMax} real={ctxReal} />
          <div className="dropdown" style={{ position: "relative" }}>
            <button className="model-pick" onClick={() => setModelOpen(o => !o)} title="Switch model for this chat">
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: online ? "var(--good)" : "var(--ink-4)", flexShrink: 0 }} />
              <span className="mono semi truncate model-pick-name">{effectiveModel}</span>
              {modelOverride && <span className="model-pick-badge">custom</span>}
              <Icon name="chevD" size={12} style={{ color: "var(--ink-3)" }} />
            </button>
            {modelOpen && <>
              <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setModelOpen(false)} />
              <div className="dd-menu" style={{ bottom: "calc(100% + 8px)", top: "auto", left: "auto", right: 0, width: 280, maxHeight: 300, overflow: "auto" }}>
                <div className="dd-label">Model for this chat</div>
                {modelOverride && (
                  <div className="dd-item" onClick={() => { setModelOverride(null); setModelOpen(false); }}>
                    <Icon name="refresh" size={14} style={{ color: "var(--ink-3)" }} />
                    <span style={{ fontSize: 12.5 }}>Use default (<span className="mono">{defaultModel}</span>)</span>
                  </div>
                )}
                {(models.length ? models : [effectiveModel]).map(m => (
                  <div key={m} className={"dd-item" + (m === effectiveModel ? " on" : "")} onClick={() => { setModelOverride(m); setModelOpen(false); }}>
                    <Icon name="bolt" size={14} style={{ color: m === effectiveModel ? "var(--accent)" : "var(--ink-3)" }} />
                    <span className="mono" style={{ fontSize: 12.5 }}>{m}</span>
                    {m === effectiveModel && <Icon name="check" size={14} style={{ marginLeft: "auto" }} />}
                  </div>
                ))}
              </div>
            </>}
          </div>
          {busy
            ? <button className="send-btn" onClick={stop} title="Stop" style={{ background: "var(--ink-3)" }}><Icon name="x" size={16} /></button>
            : <button className="send-btn" disabled={!val.trim() && !attachImgs.length && !files.some(f => f.path)} onClick={() => send()}><Icon name="send" size={15} /></button>}
          </div>
        </div>
        <input ref={imgInRef} type="file" accept="image/*" multiple style={{ display: "none" }}
          onChange={e => { addAttachImages(e.target.files); e.target.value = ""; setPlusOpen(false); }} />
        <input ref={filesInRef} type="file" multiple style={{ display: "none" }}
          onChange={e => { addFiles(e.target.files); e.target.value = ""; setPlusOpen(false); }} />
        <input ref={dirInRef} type="file" multiple webkitdirectory="" style={{ display: "none" }}
          onChange={e => { addFiles(e.target.files); e.target.value = ""; setPlusOpen(false); }} />
      </div>
    </div>
  );
}

export { Composer };
