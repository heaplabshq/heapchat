import { Icon } from "./icons.jsx";
import { fmt } from "./markdown.jsx";
// quickask.jsx — the compact Spotlight-style panel (loaded in the ?quick window).
// A single-turn ask against the agent over the knowledge base; ephemeral, not saved.
const { useState: useQA, useRef: useQR, useEffect: useQE } = React;

function QuickAsk() {
  const [q, setQ] = useQA("");
  const [asked, setAsked] = useQA("");        // the question that produced the current answer
  const [busy, setBusy] = useQA(false);
  const [answer, setAnswer] = useQA("");
  const [status, setStatus] = useQA("");      // transient "Searching…" while tools run
  const [error, setError] = useQA(null);
  const taRef = useQR(null);
  const abortRef = useQR(null);
  const bodyRef = useQR(null);

  useQE(() => { if (taRef.current) taRef.current.focus(); }, []);
  useQE(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [answer, status]);

  function hide() { if (window.cortex && window.cortex.quickHide) window.cortex.quickHide(); }
  function openMain() { if (window.cortex && window.cortex.openMain) window.cortex.openMain(); }
  // carry this exchange into a real chat in the main app so the user can keep going with context
  function continueInApp() {
    if (window.cortex && window.cortex.openMain) window.cortex.openMain({ question: asked, answer });
  }

  async function ask() {
    const text = q.trim();
    if (!text || busy) return;
    setAsked(text);
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
      if (!got.trim()) setAnswer("_(no answer)_");
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally { setBusy(false); setStatus(""); abortRef.current = null; }
  }

  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); if (busy && abortRef.current) abortRef.current.abort(); else hide(); }
    else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
  }

  return (
    <div className="quick-wrap" onKeyDown={onKey}>
      <div className="quick-head">
        <div className="brand-mark sm"><Icon name="sparkles" size={15} sw={2} /></div>
        <span className="quick-title">Quick Ask</span>
        <span className="quick-hint">your knowledge base</span>
        <button className="btn icon sm ghost quick-nodrag" title="Open in Cortex" onClick={openMain}><Icon name="layers" size={14} /></button>
        <button className="btn icon sm ghost quick-nodrag" title="Close (Esc)" onClick={hide}><Icon name="x" size={14} /></button>
      </div>

      <div className="quick-input quick-nodrag">
        <Icon name="search" size={16} style={{ color: "var(--ink-3)", flex: "none" }} />
        <textarea ref={taRef} rows={1} placeholder="Ask anything about your files…" value={q}
          onChange={e => setQ(e.target.value)} disabled={busy} />
        {busy
          ? <button className="btn icon sm" title="Stop" onClick={() => abortRef.current && abortRef.current.abort()}><Icon name="x" size={14} /></button>
          : <button className="btn icon sm primary" title="Ask (Enter)" disabled={!q.trim()} onClick={ask}><Icon name="send" size={14} /></button>}
      </div>

      <div className="quick-body quick-nodrag" ref={bodyRef}>
        {error ? (
          <div className="callout warn"><Icon name="alert" size={14} /><span>{error}</span></div>
        ) : status ? (
          <div className="row gap-2 ink-3" style={{ padding: "6px 2px" }}><span className="spin-mini" /><span className="t-sm">{status}</span></div>
        ) : answer ? (
          <>
            {fmt(answer)}
            <button className="quick-continue quick-nodrag" onClick={continueInApp}><Icon name="chevR" size={13} /> Continue in Cortex</button>
          </>
        ) : (
          <div className="quick-empty">
            <Icon name="sparkles" size={22} style={{ color: "var(--accent)", opacity: .5 }} />
            <span>Ask a question and I'll search your knowledge base. Press <kbd>Esc</kbd> to dismiss.</span>
          </div>
        )}
      </div>
    </div>
  );
}

export { QuickAsk };
