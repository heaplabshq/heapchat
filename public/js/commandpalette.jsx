import { Icon } from "./icons.jsx";
// commandpalette.jsx — ⌘K / Ctrl+K quick switcher
function CommandPalette({ commands, onClose }) {
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef(null);
  const listRef = React.useRef(null);

  React.useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);
  const ql = q.trim().toLowerCase();
  const items = (ql
    ? commands.filter(c => c.label.toLowerCase().includes(ql) || (c.hint || "").toLowerCase().includes(ql))
    : commands).slice(0, 60);
  React.useEffect(() => { setActive(0); }, [q]);

  function run(i) { const c = items[i]; if (c) { onClose(); c.run(); } }
  function onKey(e) {
    if (e.key === "Escape") { onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(a + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); run(active); }
  }
  React.useEffect(() => {
    const el = listRef.current && listRef.current.querySelector(".cmd-item.on");
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ alignItems: "flex-start", paddingTop: "12vh" }}>
      <div className="cmd" onClick={e => e.stopPropagation()}>
        <div className="cmd-input">
          <Icon name="search" size={17} style={{ color: "var(--ink-3)" }} />
          <input ref={inputRef} value={q} onChange={e => setQ(e.target.value)} onKeyDown={onKey}
            placeholder="Search files & actions…" />
          <span className="t-xs ink-4">esc</span>
        </div>
        <div className="cmd-list scroll" ref={listRef}>
          {items.length === 0 ? <div className="cmd-empty">No matches</div> : items.map((c, i) => (
            <div key={i} className={"cmd-item" + (i === active ? " on" : "")}
              onMouseEnter={() => setActive(i)} onClick={() => run(i)}>
              <span className="cmd-ico" style={c.color ? { color: c.color } : null}><Icon name={c.icon || "file"} size={16} /></span>
              <span className="truncate grow">{c.label}</span>
              {c.hint && <span className="t-xs ink-4 truncate none" style={{ maxWidth: "40%" }}>{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { CommandPalette };
