import { Icon } from "./icons.jsx";
// setup.jsx — first-run gate: detect Ollama, guide install, and pull a model.
// Shown by the app only when Ollama is unreachable or no model is installed.
const { useState: useSt0, useEffect: useEf0, useRef: useRf0 } = React;

// curated, right-sized models the setup screen can install
const MODEL_CATALOG = [
  { name: "llama3.2:3b", label: "Llama 3.2 · 3B", size: "~2 GB", note: "Fast, light on memory", minRam: 0 },
  { name: "llama3.1:8b", label: "Llama 3.1 · 8B", size: "~4.7 GB", note: "Balanced all-rounder", minRam: 8 },
  { name: "qwen2.5:7b", label: "Qwen 2.5 · 7B", size: "~4.7 GB", note: "Strong at tools & the agent", minRam: 8 },
  { name: "qwen2.5:14b", label: "Qwen 2.5 · 14B", size: "~9 GB", note: "Highest quality, needs RAM", minRam: 16 },
];
function recommendedModel(ramGB) {
  if (ramGB >= 16) return "qwen2.5:7b";
  if (ramGB >= 8) return "llama3.1:8b";
  return "llama3.2:3b";
}

function OllamaSetup({ onDone, onModel, onSkip }) {
  const [phase, setPhase] = useSt0("loading");   // loading | down | nomodel | ready
  const [info, setInfo] = useSt0({ endpoint: "", ramGB: 0, models: [] });
  const [chosen, setChosen] = useSt0(null);
  const [pull, setPull] = useSt0(null);          // { model, status, pct, error, done }
  const pollRef = useRf0(null);
  const abortRef = useRf0(null);

  async function check() {
    try {
      const s = await fetch("/api/setup/status").then(r => r.json());
      setInfo({ endpoint: s.endpoint, ramGB: s.ramGB, models: s.models || [] });
      if (!s.ollama) { setPhase("down"); return false; }
      if (!s.models || !s.models.length) {
        setChosen(c => c || recommendedModel(s.ramGB));
        setPhase("nomodel"); return false;
      }
      setPhase("ready"); return true;
    } catch { setPhase("down"); return false; }
  }

  useEf0(() => { check(); return () => { clearInterval(pollRef.current); if (abortRef.current) abortRef.current.abort(); }; }, []);

  // while Ollama is down, keep checking so the screen advances the moment it comes up
  useEf0(() => {
    clearInterval(pollRef.current);
    if (phase === "down") pollRef.current = setInterval(check, 4000);
    return () => clearInterval(pollRef.current);
  }, [phase]);

  async function startPull(model) {
    setPull({ model, status: "starting…", pct: 0, error: null, done: false });
    const ctrl = new AbortController(); abortRef.current = ctrl;
    try {
      const resp = await fetch("/api/ollama/pull", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }), signal: ctrl.signal,
      });
      if (!resp.ok) { const e = await resp.json().catch(() => ({})); throw new Error(e.error || `Pull failed (${resp.status})`); }
      const reader = resp.body.getReader(), dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let o; try { o = JSON.parse(line); } catch { continue; }
          if (o.error) throw new Error(o.error);
          const pct = (o.total && o.completed) ? Math.round((o.completed / o.total) * 100) : undefined;
          setPull(p => ({ ...p, status: o.status || p.status, pct: pct != null ? pct : p.pct }));
        }
      }
      // success → remember the model for the app, then re-check to advance to "ready"
      onModel && onModel(model);
      setPull(p => ({ ...(p || {}), done: true, pct: 100, status: "done" }));
      await check();
    } catch (e) {
      if (e.name === "AbortError") return;
      setPull(p => ({ ...(p || { model }), error: e.message }));
    }
  }

  const recommended = recommendedModel(info.ramGB);

  return (
    <div className="setup-screen">
      <div className="setup-card">
        <div className="setup-brand">
          <div className="brand-mark"><Icon name="layers" size={22} sw={2} /></div>
          <span className="x-bold tighter" style={{ fontSize: 20 }}>Cortex</span>
        </div>

        {phase === "loading" && (
          <div className="col center" style={{ gap: 12, padding: "30px 0" }}>
            <span className="spin-mini" /><span className="ink-3 t-sm">Checking your setup…</span>
          </div>
        )}

        {phase === "down" && (
          <>
            <h2 className="setup-title">Connect a local AI engine</h2>
            <p className="setup-sub">Cortex runs entirely on your machine using <b>Ollama</b> — a free, local AI runner. Install it once, then come back here.</p>
            <ol className="setup-steps">
              <li><b>Download &amp; install Ollama</b> for your system.</li>
              <li>Open it (it runs quietly in the background).</li>
              <li>This screen continues automatically once it's running.</li>
            </ol>
            <div className="row gap-2" style={{ marginTop: 18 }}>
              <a className="btn primary" href="https://ollama.com/download" target="_blank" rel="noopener noreferrer"><Icon name="download" size={15} /> Download Ollama</a>
              <button className="btn" onClick={check}><Icon name="refresh" size={14} /> Check again</button>
            </div>
            <div className="row center gap-2" style={{ marginTop: 16, color: "var(--ink-3)" }}>
              <span className="spin-mini" /><span className="t-xs">Watching for Ollama at <span className="mono">{info.endpoint || "localhost:11434"}</span>…</span>
            </div>
            <button className="setup-skip" onClick={onSkip}>Skip for now</button>
          </>
        )}

        {phase === "nomodel" && (
          <>
            <h2 className="setup-title">Download a model</h2>
            <p className="setup-sub">Ollama is running{info.ramGB ? <> · {info.ramGB} GB RAM detected</> : null}. Pick a model to power chat and the agent — you can add more later in Settings.</p>

            {!pull || pull.error ? (
              <>
                <div className="setup-models">
                  {MODEL_CATALOG.filter(m => m.minRam <= Math.max(info.ramGB, 4) + 0.1 || m.name === recommended).map(m => (
                    <button key={m.name} type="button" className={"setup-model" + (chosen === m.name ? " on" : "")} onClick={() => setChosen(m.name)}>
                      <div className="row between">
                        <span className="semi">{m.label}</span>
                        {m.name === recommended && <span className="setup-badge">Recommended</span>}
                      </div>
                      <span className="ink-3 t-xs">{m.note} · {m.size}</span>
                    </button>
                  ))}
                </div>
                {pull && pull.error && <div className="callout warn" style={{ marginTop: 12 }}><Icon name="alert" size={14} /><span>{pull.error}</span></div>}
                <div className="row gap-2" style={{ marginTop: 16 }}>
                  <button className="btn primary" disabled={!chosen} onClick={() => startPull(chosen)}><Icon name="download" size={15} /> Download {chosen ? chosen.split(":")[0] : "model"}</button>
                </div>
                <div className="t-xs ink-3" style={{ marginTop: 10 }}>The download runs once and is cached by Ollama. Size is the disk footprint.</div>
              </>
            ) : (
              <div className="setup-progress">
                <div className="row between" style={{ marginBottom: 8 }}>
                  <span className="semi mono t-sm">{pull.model}</span>
                  <span className="ink-3 t-xs">{pull.pct != null ? pull.pct + "%" : ""}</span>
                </div>
                <div className="setup-bar"><div className="setup-bar-fill" style={{ width: (pull.pct || 0) + "%" }} /></div>
                <div className="row center gap-2" style={{ marginTop: 10, color: "var(--ink-3)" }}>
                  {!pull.done && <span className="spin-mini" />}
                  <span className="t-xs">{pull.status}</span>
                </div>
              </div>
            )}
            <button className="setup-skip" onClick={onSkip}>Skip for now</button>
          </>
        )}

        {phase === "ready" && (
          <>
            <div className="col center" style={{ gap: 14, padding: "20px 0 8px" }}>
              <div className="setup-check"><Icon name="check" size={26} /></div>
              <h2 className="setup-title" style={{ textAlign: "center" }}>You're all set</h2>
              <p className="setup-sub" style={{ textAlign: "center" }}>Ollama is running with {info.models.length} model{info.models.length === 1 ? "" : "s"} installed.</p>
            </div>
            <button className="btn primary" style={{ width: "100%", marginTop: 8 }} onClick={onDone}><Icon name="sparkles" size={15} /> Start using Cortex</button>
          </>
        )}
      </div>
    </div>
  );
}

export { OllamaSetup };
