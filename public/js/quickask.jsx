import { Icon } from "./icons.jsx";
import { fmt } from "./markdown.jsx";
import { ChatAPI, newId } from "./chat-data.jsx";
import { applyAccent } from "./sidebar.jsx";
// quickask.jsx — the compact, Claude-style floating quick-entry panel (loaded in the ?quick window).
// A single-turn ask against the agent over the knowledge base. Each answered question is saved as
// its own session under the same "agent" bucket as the main default chat (see app.jsx), so it shows
// up in Recent Chats immediately — "Continue in Heap Chat" just switches to that already-saved
// session rather than creating a new one.
const { useState: useQA, useRef: useQR, useEffect: useQE } = React;
const QUICK_SOURCE = { scope: "agent", domain: "kb", name: "Heap Chat Agent", id: "agent" };

function QuickAsk() {
  const [q, setQ] = useQA("");
  const [asked, setAsked] = useQA("");        // the question that produced the current answer
  const [busy, setBusy] = useQA(false);
  const [answer, setAnswer] = useQA("");
  const [status, setStatus] = useQA("");      // transient "Searching…" while tools run
  const [error, setError] = useQA(null);
  const [menuOpen, setMenuOpen] = useQA(false);
  const [shareDismissed, setShareDismissed] = useQA(() => localStorage.getItem("heapchat.quickShareDismissed") === "1");
  const [screenOn, setScreenOn] = useQA(() => localStorage.getItem("heapchat.quickScreenShare") === "1");
  const [filesOn, setFilesOn] = useQA(() => localStorage.getItem("heapchat.quickFileShare") === "1");
  const taRef = useQR(null);
  const abortRef = useQR(null);
  const bodyRef = useQR(null);
  const wrapRef = useQR(null);
  const menuRef = useQR(null);
  const sidRef = useQR(null);   // the saved-session id for the current question, once it has one

  // Quick Ask is a separate window/document from the main app shell, so the accent color the
  // user picked in Settings (applied there by sidebar.jsx, which never mounts here) has to be
  // re-applied independently from the same saved preference. And since the Electron window is
  // created once and then just shown/hidden (never reloaded — see toggleQuickAsk in main.js),
  // this can't be a mount-only effect either, or a color changed after the window was first
  // created would never be picked up: re-apply on every focus (covers "changed it while Quick
  // Ask was hidden, then reopened") and on the storage event (covers "changed it in the main
  // window while Quick Ask is open side by side" — storage only fires in *other* documents).
  useQE(() => {
    const apply = () => applyAccent(localStorage.getItem("heapchat.accent") || "#4F46E5");
    apply();
    const onStorage = e => { if (!e.key || e.key === "heapchat.accent") apply(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", apply);
    return () => { window.removeEventListener("storage", onStorage); window.removeEventListener("focus", apply); };
  }, []);

  useQE(() => { if (taRef.current) taRef.current.focus(); }, []);
  useQE(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [answer, status]);

  // the window itself starts small and grows to fit content (like a native popover)
  useQE(() => {
    if (!wrapRef.current || !(window.heapchat && window.heapchat.quickResize)) return;
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => window.heapchat.quickResize(el.scrollHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useQE(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function hide() { if (window.heapchat && window.heapchat.quickHide) window.heapchat.quickHide(); }
  function openMain() { setMenuOpen(false); if (window.heapchat && window.heapchat.openMain) window.heapchat.openMain(); }
  // switch straight to the already-saved session in the main window (see ask() below — every
  // answered question is saved as it completes, so there's nothing left to create here)
  function continueInApp() {
    if (window.heapchat && window.heapchat.openMain) window.heapchat.openMain({ sessionId: sidRef.current, question: asked, answer });
  }
  function resetAsk() {
    if (abortRef.current) abortRef.current.abort();
    setQ(""); setAsked(""); setAnswer(""); setError(null); setStatus(""); setBusy(false);
    setMenuOpen(false);
    sidRef.current = null;
    if (taRef.current) taRef.current.focus();
  }

  function dismissShare() { localStorage.setItem("heapchat.quickShareDismissed", "1"); setShareDismissed(true); }
  async function turnOnScreenshots() {
    if (!(window.heapchat && window.heapchat.requestScreenPermission)) return;
    const ok = await window.heapchat.requestScreenPermission();
    if (ok) { localStorage.setItem("heapchat.quickScreenShare", "1"); setScreenOn(true); }
  }
  function turnOnFileSharing() {
    localStorage.setItem("heapchat.quickFileShare", "1");
    setFilesOn(true);
  }

  async function ask() {
    const text = q.trim();
    if (!text || busy) return;
    setAsked(text);
    sidRef.current = newId();   // this question gets its own session, saved once it has an answer
    setBusy(true); setAnswer(""); setError(null); setStatus("Thinking…");
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const resp = await fetch("/api/agent", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({ scope: "kb", messages: [{ role: "user", content: text }], autoMemory: false, factCheck: false }),
      });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || `Request failed (${resp.status})`); }
      const reader = resp.body.getReader(), dec = new TextDecoder();
      let buf = "", got = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.error) throw new Error(o.error);
          if (o.step) { setStatus("Searching your knowledge base…"); continue; }
          const c = o.message && o.message.content;
          if (c) { got += c; setStatus(""); setAnswer(got); }
        }
      }
      if (!got.trim()) { setAnswer("_(no answer)_"); }
      else {
        const messages = [{ role: "user", text }, { role: "ai", text: got }];
        ChatAPI.save("agent", sidRef.current, text.slice(0, 60), messages, QUICK_SOURCE, false, null, null).catch(() => {});
      }
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally { setBusy(false); setStatus(""); abortRef.current = null; }
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); if (busy && abortRef.current) abortRef.current.abort(); else hide(); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
  }

  const showShare = !shareDismissed && !(screenOn && filesOn);
  const showBody = !!(asked || busy || error);

  return (
    <div className="quick-wrap" ref={wrapRef} onKeyDown={onKey}>
      <div className="quick-bar quick-head">
        <div className="quick-badge"><Icon name="sparkles" size={16} sw={2} /></div>
        <textarea ref={taRef} rows={1} className="quick-nodrag" placeholder="What can I help you with today?"
          value={q} onChange={e => setQ(e.target.value)} disabled={busy} />
        <div className="dropdown quick-nodrag" ref={menuRef}>
          <button className="quick-newchat" onClick={() => setMenuOpen(v => !v)}>
            New Chat <Icon name="chevD" size={13} />
          </button>
          {menuOpen && (
            <div className="dd-menu quick-dd">
              <button className="dd-item" onClick={resetAsk}><Icon name="plus" size={14} /> New Chat</button>
              <button className="dd-item" onClick={openMain}><Icon name="layers" size={14} /> Open in Heap Chat</button>
            </div>
          )}
        </div>
        {busy
          ? <button className="quick-submit quick-nodrag" title="Stop" onClick={() => abortRef.current && abortRef.current.abort()}><Icon name="x" size={15} /></button>
          : <button className="quick-submit quick-nodrag" title="Ask (Enter)" disabled={!q.trim()} onClick={ask}><Icon name="send" size={15} /></button>}
      </div>

      {showShare && (
        <div className="quick-share quick-nodrag">
          <div className="quick-share-text">
            <span className="quick-share-title">Quickly share content with Heap Chat</span>
            <span className="quick-share-sub">Needs additional permission</span>
          </div>
          <div className="quick-share-actions">
            {!screenOn && <button className="quick-pill" onClick={turnOnScreenshots}>Turn on screenshots</button>}
            {!filesOn && <button className="quick-pill" onClick={turnOnFileSharing}>Turn on file sharing</button>}
            <button className="quick-pill" onClick={dismissShare}>Not now</button>
          </div>
        </div>
      )}

      {showBody && (
        <div className="quick-body quick-nodrag" ref={bodyRef}>
          {error ? (
            <div className="callout warn"><Icon name="alert" size={14} /><span>{error}</span></div>
          ) : status ? (
            <div className="row gap-2 ink-3" style={{ padding: "6px 2px" }}><span className="spin-mini" /><span className="t-sm">{status}</span></div>
          ) : answer ? (
            <>
              {fmt(answer)}
              <button className="quick-continue quick-nodrag" onClick={continueInApp}><Icon name="chevR" size={13} /> Continue in Heap Chat</button>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

export { QuickAsk };
