import { Icon } from "./icons.jsx";
import { fmt } from "./markdown.jsx";
import { Reasoning } from "./chat-cards.jsx";
/* Agent step + reasoning trace UI (the live tool/thinking timeline shown under an
   agent answer). Extracted from chat.jsx. Global-scope module (indirect-eval):
   components are visible to chat.jsx; Icon and fmt resolve as globals at render time. */
const { useState } = React;

// pretty labels for the agent's tool steps
const TOOL_META = {
  search_docs:   { icon: "search",     run: "Searching documents", done: "Searched documents" },
  search_kb:     { icon: "search",     run: "Searching documents", done: "Searched documents" },
  find_text:     { icon: "text",       run: "Finding exact text", done: "Found exact text" },
  list_files:    { icon: "layers",     run: "Listing files", done: "Listed files" },
  read_file:     { icon: "file",       run: "Reading", done: "Read" },
  query_csv:     { icon: "grid",       run: "Analyzing table", done: "Analyzed table" },
  compare_files: { icon: "layers",     run: "Comparing", done: "Compared" },
  save_note:     { icon: "download",   run: "Saving note", done: "Saved note" },
  manage_file:   { icon: "sliders",    run: "Updating file", done: "Updated file" },
  image_tool:    { icon: "image",      run: "Analyzing image", done: "Analyzed image" },
  find_related:  { icon: "layers",     run: "Finding related", done: "Found related" },
  find_photos_of:{ icon: "image",      run: "Finding photos of person", done: "Found photos" },
  create_instagram_post: { icon: "image", run: "Composing Instagram post", done: "Composed Instagram post" },
  remember:      { icon: "brain",      run: "Saving to memory", done: "Saved to memory" },
  ask_user:      { icon: "info",       run: "Asking you", done: "Asked for clarification" },
  list_connectors: { icon: "layers",   run: "Checking connectors", done: "Checked connectors" },
  use_connector:   { icon: "bolt",     run: "Using connector", done: "Used connector" },
  recall_memory:   { icon: "brain",    run: "Recalling memories", done: "Recalled memories" },
  fact_check:      { icon: "check",    run: "Fact-checking answer", done: "Fact-checked answer" },
  plan:            { icon: "compass",  run: "Planning research", done: "Planned research" },
  "agent:planner":    { icon: "compass", run: "Planner is planning", done: "Planner made a plan" },
  "agent:researcher": { icon: "search",  run: "Researcher is gathering evidence", done: "Researcher gathered evidence" },
  "agent:drafter":    { icon: "file",    run: "Drafter is writing", done: "Drafter wrote the answer" },
  "agent:critic":     { icon: "info",    run: "Critic is reviewing", done: "Critic reviewed the draft" },
};
const MANAGE_VERB = {
  open: ["Opening", "Opened"], rename: ["Renaming", "Renamed"], delete: ["Deleting", "Deleted"], tag: ["Tagging", "Tagged"],
  append: ["Editing", "Edited"], overwrite: ["Rewriting", "Rewrote"], replace: ["Editing", "Edited"],
};
const IMAGE_VERB = { describe: ["Looking at image", "Described image"], exif: ["Reading photo info", "Read photo info"] };
function AgentStep({ s }) {
  const [open, setOpen] = useState(false);
  const mt = TOOL_META[s.name] || { icon: "bolt", run: s.name, done: s.name };
  const run = s.status === "run";
  const a = s.args || {};
  let label = run ? mt.run : mt.done;
  if (s.name === "manage_file" && a.action && MANAGE_VERB[a.action]) label = MANAGE_VERB[a.action][run ? 0 : 1];
  if (s.name === "image_tool" && a.action && IMAGE_VERB[a.action]) label = IMAGE_VERB[a.action][run ? 0 : 1];
  const detail = (a.server && a.tool) ? `${a.server} · ${a.tool}` : a.query ? `"${a.query}"` : a.text ? `"${a.text}"` : (a.a && a.b) ? `${a.a} vs ${a.b}` : a.new_name ? `${a.name} → ${a.new_name}` : a.title || a.name || "";
  if (detail) label += ` · ${detail.length > 44 ? detail.slice(0, 44) + "…" : detail}`;
  const hasMore = !run && (s.detail || Object.keys(a).length > 0);
  return (
    <div className="agent-step-wrap">
      <div className={"agent-step" + (hasMore ? " clickable" : "")} onClick={() => hasMore && setOpen(o => !o)}>
        <span className="agent-step-ico">{run ? <span className="spin-mini" /> : <Icon name="check" size={12} />}</span>
        <Icon name={mt.icon} size={13} style={{ color: "var(--ink-3)", flex: "none" }} />
        {s.agent && s.agent.label && <span className="agent-tag" style={{ flex: "none", fontSize: 10.5, fontWeight: 600, padding: "1px 6px", borderRadius: 5, background: "var(--accent-dim, rgba(99,102,241,.14))", color: "var(--accent)" }}>{s.agent.label}</span>}
        <span className="truncate grow">{label}</span>
        {!run && s.summary && <span className="t-xs ink-3 truncate" style={{ maxWidth: "38%" }}>{s.summary}</span>}
        {hasMore && <Icon name="chevD" size={12} style={{ flex: "none", color: "var(--ink-4)", transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s" }} />}
      </div>
      {open && hasMore && (
        <div className="agent-step-detail">
          {Object.keys(a).length > 0 && <div className="agent-step-args">{Object.entries(a).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("   ·   ")}</div>}
          {s.detail && <pre className="agent-step-out">{s.detail}</pre>}
        </div>
      )}
    </div>
  );
}
function AgentSteps({ steps }) {
  const [open, setOpen] = useState(true);
  const running = steps.some(s => s.status === "run");
  return (
    <div className="agent-steps">
      <div className="agent-steps-head" onClick={() => setOpen(o => !o)}>
        <Icon name={running ? "bolt" : "check"} size={13} style={{ color: running ? "var(--accent)" : "var(--good)" }} />
        <span>{running ? "Working…" : `Used ${steps.length} step${steps.length === 1 ? "" : "s"}`}</span>
        <Icon name="chevD" size={13} style={{ marginLeft: "auto", transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s", color: "var(--ink-3)" }} />
      </div>
      {open && <div className="agent-steps-body">
        {steps.map((s, i) => <AgentStep key={i} s={s} />)}
      </div>}
    </div>
  );
}
// one reasoning segment in the interleaved timeline (collapsed by default, compact like Claude web)
function ThinkSegment({ text, live, agent }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="think-seg">
      <button className="trace-head" onClick={() => setOpen(o => !o)}>
        <Icon name="brain" size={13} style={{ color: "var(--accent)" }} />
        <span>{agent && agent.label ? `${agent.label} · ` : ""}{live ? "Thinking…" : "Reasoning"}</span>
        <Icon name="chevD" size={12} style={{ transform: open ? "none" : "rotate(-90deg)", transition: "transform .15s", color: "var(--ink-4)" }} />
      </button>
      {open && <div className="trace-body">{fmt(text || "…")}</div>}
    </div>
  );
}
// interleaved reasoning + tool steps, in the exact order the agent produced them
function Timeline({ items, live }) {
  return (
    <div className="agent-timeline">
      {items.map((it, i) => it.t === "think"
        ? <ThinkSegment key={i} text={it.text} agent={it.agent} live={live && i === items.length - 1} />
        : <AgentStep key={i} s={it} />)}
    </div>
  );
}

export { Timeline, AgentSteps };
