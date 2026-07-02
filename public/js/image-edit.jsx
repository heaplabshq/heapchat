import { Icon } from "./icons.jsx";
/* ImageEditModal — "Edit with AI" dialog used from chat image results and the
   gallery full-screen viewer. POSTs the source image (a server `path` or a
   `dataUrl`) + an edit instruction to /api/image/edit (Draw Things img2img),
   shows the result, and reports it back via onDone. Depends only on Icon so it
   can be imported by both focus.jsx (early) and chat.jsx without an app cycle. */
const { useState } = React;

// pull the Draw Things settings + chat model + generation defaults into the request body
function dtBody(settings) {
  return {
    drawThingsUrl: settings.drawThingsUrl || undefined,
    drawThingsModel: settings.drawThingsModel || undefined,
    drawThingsSecret: settings.drawThingsSecret || undefined,
    model: settings.agentModel || settings.model || undefined,
    steps: settings.imageSteps || 4, guidanceScale: settings.imageGuidance ?? 7.5,
  };
}

function ImageEditModal({ src, path, dataUrl, settings = {}, onClose, onDone }) {
  const [prompt, setPrompt] = useState("");
  const [enhance, setEnhance] = useState(settings.imageEnhance !== false);
  const [strength, setStrength] = useState(settings.imageStrength ?? 0.7);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [result, setResult] = useState(null);   // the produced item { url, thumb, path, title }

  async function run() {
    const p = prompt.trim();
    if (!p || busy) return;
    setBusy(true); setErr(null); setResult(null);
    try {
      const body = { prompt: p, enhance, strength, maxDim: settings.imageEditFullRes ? 0 : 1024, ...dtBody(settings) };
      if (path) body.path = path; else if (dataUrl) body.dataUrl = dataUrl;
      const r = await fetch("/api/image/edit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Edit failed");
      const item = (j.items || [])[0];
      setResult({ ...item, prompt: j.prompt, enhanced: j.enhanced });
      if (onDone) onDone(item, j);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  // big square preview area: the source while composing, a spinner while working, the result when done
  const previewSize = 360;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="ex-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 860, width: "92vw" }}>
        <div className="row between" style={{ marginBottom: 12 }}>
          <span className="x-bold tighter" style={{ fontSize: 19 }}><Icon name="sparkles" size={18} style={{ color: "var(--accent)" }} /> Edit with AI</span>
          <button className="btn icon sm ghost" onClick={onClose}><Icon name="x" size={16} /></button>
        </div>

        <div className="row gap-3" style={{ alignItems: "stretch", flexWrap: "wrap" }}>
          <div style={{ position: "relative", width: previewSize, height: previewSize, flex: "none", maxWidth: "100%" }}>
            <img src={result ? (result.url || result.image) : src} alt=""
              style={{ width: "100%", height: "100%", objectFit: "contain", borderRadius: 12, border: "1px solid var(--line)", background: "var(--surface-3)", opacity: busy ? 0.25 : 1, transition: "opacity .2s" }} />
            {busy && (
              <div className="col center" style={{ position: "absolute", inset: 0, gap: 10, color: "var(--ink-2)" }}>
                <span className="dots"><span /><span /><span /></span>
                <span className="t-xs">Generating a fresh image…</span>
              </div>
            )}
          </div>

          <div className="col grow" style={{ gap: 10, minWidth: 260 }}>
            {!result ? (
              <>
                <textarea className="ex-input" rows={5} placeholder="Describe the change — e.g. “make it a watercolor painting at sunset”"
                  value={prompt} onChange={e => setPrompt(e.target.value)} autoFocus disabled={busy}
                  onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
                  style={{ fontSize: 13.5, resize: "vertical", flex: 1, minHeight: 100 }} />
                <label className="col" style={{ gap: 3 }}>
                  <span className="t-xs ink-3">Strength — how much to change ({Math.round(strength * 100)}%)</span>
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <span className="t-xs ink-4" style={{ flex: "none" }}>Keep original</span>
                    <input type="range" min={0.05} max={1} step={0.01} value={strength} disabled={busy}
                      onChange={e => setStrength(+e.target.value)} style={{ flex: 1 }} />
                    <span className="t-xs ink-4" style={{ flex: "none" }}>Reimagine</span>
                  </div>
                </label>
                <label className="row gap-1 t-xs" style={{ alignItems: "center", cursor: "pointer" }} onClick={() => !busy && setEnhance(v => !v)}>
                  <span className={"toggle sm" + (enhance ? " on" : "")} />
                  <span className="ink-3">Enhance my prompt automatically</span>
                </label>
                <div className="t-xs ink-4">Your image is loaded as the base and re-rendered with your change. Lower strength stays closer to the original.</div>
              </>
            ) : (
              <div className="col" style={{ gap: 8 }}>
                {result.enhanced && <div className="t-xs ink-3"><b>Prompt used:</b> {result.prompt}</div>}
                <div className="t-xs" style={{ color: "var(--good)" }}><Icon name="check" size={12} /> Saved to your library under <span className="mono">Created images</span>.</div>
              </div>
            )}
          </div>
        </div>

        {err && <div className="callout warn" style={{ textAlign: "left", marginTop: 12 }}><Icon name="alert" size={15} /><span>{err}</span></div>}

        <div className="row" style={{ justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          {!result ? (
            <>
              <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn primary" onClick={run} disabled={busy || !prompt.trim()}>
                {busy ? <><span className="spin-mini" /> Editing…</> : <><Icon name="sparkles" size={14} /> Generate</>}
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => { setResult(null); setErr(null); }}>Edit again</button>
              <button className="btn primary" onClick={onClose}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export { ImageEditModal };
