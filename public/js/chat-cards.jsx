import { Icon } from "./icons.jsx";
import { fmt } from "./markdown.jsx";
/* Message sub-components for chat answers: the legacy collapsible Reasoning
   block, the grounding/trust badge, and the destructive-action approval card.
   Extracted from chat.jsx. Global-scope module (indirect-eval): all three leak
   to global for chat.jsx; Icon (icons.jsx) and fmt (markdown.jsx) resolve as
   globals at render time. */
const { useState } = React;

function Reasoning({ text, live, secs }) {
  const [open, setOpen] = useState(false);
  const label = live ? "Thinking…" : (secs ? `Thought for ${secs}s` : "Reasoning");
  return (
    <div className="reason">
      <div className="reason-head" onClick={() => setOpen(o => !o)}>
        <Icon name="brain" size={15} style={{ color: "var(--accent)" }} />
        {label}
        <Icon name="chevD" size={14} style={{ marginLeft: "auto", transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s", color: "var(--ink-3)" }} />
      </div>
      {open && <div className="reason-body">{fmt(text || "…")}</div>}
    </div>
  );
}

// trust badge — only shown for answers actually grounded in the user's files.
// If the verifier flagged specific claims, it becomes an expandable "double-check these" list.
function GroundingBadge({ g, v }) {
  const [open, setOpen] = useState(false);
  if (!g || g.mode !== "grounded") return null;   // general/own-knowledge answers get no badge (it was just noise)
  const n = `${g.sources} source${g.sources === 1 ? "" : "s"}`;
  const issues = v && (v.verdict === "partial" || v.verdict === "unsupported") && v.issues && v.issues.length ? v.issues : null;
  if (issues) {
    return (
      <div className="ground-wrap">
        <button className="ground-badge ground-warn" onClick={() => setOpen(o => !o)}>
          <Icon name="alert" size={12} sw={1.9} />
          <span>Double-check {issues.length} {issues.length === 1 ? "claim" : "claims"}</span>
          <Icon name="chevD" size={12} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />
        </button>
        {open && (
          <div className="ground-issues">
            <div className="ground-issues-note">The auto-check couldn't confirm these against your sources — worth verifying:</div>
            <ul>{issues.map((it, i) => <li key={i}>{it}</li>)}</ul>
          </div>
        )}
      </div>
    );
  }
  const verified = v && v.verdict === "supported";
  const revised = v && v.revised;
  return (
    <div className="ground-badge ground-ok" title={(revised ? "The fact-check flagged issues and the answer was automatically corrected. " : "") + (verified ? "A second pass confirmed the answer matches your sources" : "Backed by the cited sources")}>
      <Icon name="check" size={12} sw={1.9} /> <span>Grounded · {n}{verified ? " · verified" : ""}{revised ? " · self-corrected" : ""}</span>
    </div>
  );
}

// Approve/Cancel card for destructive file actions the agent proposed (delete / overwrite / rename).
// Nothing touches disk until the user clicks Approve.
function ApprovalCard({ pa, onDecide }) {
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);
  const title = pa.action === "delete" ? <>Delete <b>{pa.name}</b>?</>
    : pa.action === "rename" ? <>Rename <b>{pa.name}</b> to <b>{pa.new_name}</b>?</>
    : <>Overwrite <b>{pa.name}</b> with new content?</>;
  if (pa.status === "done") return (
    <div className="approve-card done"><div className="approve-head"><Icon name="check" size={15} style={{ color: "var(--good)" }} /> {pa.resultText || "Done."}</div></div>
  );
  if (pa.status === "declined") return (
    <div className="approve-card declined"><div className="approve-head"><Icon name="x" size={15} /> Cancelled — nothing was changed.</div></div>
  );
  return (
    <div className="approve-card">
      <div className="approve-head"><Icon name="alert" size={16} style={{ color: "#d97706", flex: "none" }} /> <span>{title}</span></div>
      {pa.action === "overwrite" && pa.text != null && (
        <>
          <button className="approve-peek" onClick={() => setShowText(o => !o)}>{showText ? "Hide" : "Show"} new content ({pa.text.length.toLocaleString()} chars)</button>
          {showText && <pre className="approve-pre">{pa.text.slice(0, 2000)}{pa.text.length > 2000 ? "\n…" : ""}</pre>}
        </>
      )}
      <div className="approve-note">The agent asked to do this. It changes your files and can't be undone.</div>
      {pa.error && <div className="approve-note" style={{ color: "#b91c1c" }}>Failed: {pa.error} — you can try again.</div>}
      <div className="approve-btns">
        <button className="approve-btn" disabled={busy} onClick={() => onDecide(false)}>Cancel</button>
        <button className="approve-btn danger" disabled={busy} onClick={async () => { setBusy(true); await onDecide(true); setBusy(false); }}>
          {busy ? "Working…" : pa.action === "delete" ? "Delete" : pa.action === "rename" ? "Rename" : "Overwrite"}
        </button>
      </div>
    </div>
  );
}

export { Reasoning, ApprovalCard, GroundingBadge };
