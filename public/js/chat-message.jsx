import { ChatPanel } from "./chat.jsx";
import { ProvText } from "./markdown.jsx";
import { Timeline, AgentSteps } from "./agent-trace.jsx";
import { Reasoning, ApprovalCard, GroundingBadge } from "./chat-cards.jsx";
import { RenderBlock } from "./renders.jsx";
import { Icon, kindFromName, thumbUrl, fileUrl } from "./icons.jsx";
/* One chat message bubble (user or AI), including the AI answer's interleaved
   reasoning/step timeline, legacy steps+reasoning shape, error/streaming states,
   tool-result renders, source thumbs/chips, grounding badge, and the per-message
   action row (copy/download/regenerate, edit for user msgs). Extracted from the
   ChatPanel message list in chat.jsx. Global-scope module (indirect-eval):
   ChatMessage leaks to global for chat.jsx; the sub-components (ProvText,
   Timeline, AgentSteps, Reasoning, ApprovalCard, GroundingBadge, RenderBlock)
   and helpers (Icon, kindFromName, thumbUrl) resolve as globals at render time.
   The message index `i` is still needed (editMsg/decideAction take it). */

function ChatMessage({ m, i, isLast, busy, onOpenPath, editMsg, decideAction, copyMsg, downloadMsg, regenerate, onEditImage, onImageAction, onZoomImage }) {
  if (m.role === "user") {
    const promptImgs = m.images && m.images.length > 0 ? m.images.map(im => ({ image: im.url, title: im.name }))
      : m.image ? [{ image: m.image, title: "attachment" }] : null;
    return (
      <div className="msg user">
        {promptImgs && (
          <div className="msg-attach-grid">
            {promptImgs.map((im, k) => (
              <img key={k} src={im.image} alt={im.title || "attachment"} className="msg-attach"
                style={{ cursor: onZoomImage ? "zoom-in" : undefined }}
                onClick={() => onZoomImage && onZoomImage(promptImgs, k)} />
            ))}
          </div>
        )}
        {m.attachments && m.attachments.length > 0 && (
          <div className="att-chips">
            {m.attachments.map((n, k) => <span key={k} className="att-chip"><Icon name="file" size={12} sw={1.8} /> <span className="truncate">{n}</span></span>)}
          </div>
        )}
        <div className="bubble user">{m.text}</div>
        {!busy && <div className="msg-actions"><button className="msg-act" title="Edit & resend" onClick={() => editMsg(i)}><Icon name="edit" size={12} /> Edit</button></div>}
      </div>
    );
  }
  return (
    <div className="msg">
      <div className="msg-by"><Icon name="sparkles" size={13} /> Heap Chat</div>
      {(() => {
        const onCite = onOpenPath ? (e => {
          const a = e.target.closest("a.cite");
          if (a) { e.preventDefault(); const src = (m.sources || []).find(x => x.name === a.getAttribute("data-cite")); if (src && src.path) onOpenPath(src.path); }
        }) : undefined;
        const bubble = (text, key) => (
          <div key={key} className="bubble ai" style={{ display: "flex", flexDirection: "column", gap: 4 }} onClick={onCite}>
            <ProvText text={text} cites={(m.sources || []).map(s => s.name)} provenance={m.provenance} live={m.streaming} />
          </div>
        );
        const approval = m.pendingAction ? <ApprovalCard key="pa" pa={m.pendingAction} onDecide={ok => decideAction(i, m.pendingAction, ok)} /> : null;
        const tl = m.timeline || [];
        if (!m.error && tl.some(it => it.t === "text")) {
          // text segments live in the timeline: render everything in the exact order it streamed
          const groups = [];
          for (const it of tl) {
            const g = groups[groups.length - 1];
            if (it.t === "text") groups.push({ text: it.text });
            else if (g && g.items) g.items.push(it);
            else groups.push({ items: [it] });
          }
          return <>
            {groups.map((g, k) => g.items
              ? <Timeline key={k} items={g.items} live={m.streaming && k === groups.length - 1} />
              : bubble(g.text, k))}
            {approval}
          </>;
        }
        // legacy shape (older sessions): reasoning/steps block above a single answer bubble
        const steps = tl.filter(it => it.t !== "text");
        return <>
          {steps.length ? (
            steps.some(it => !it.after)
              ? <Timeline items={steps.filter(it => !it.after)} live={m.streaming && !m.text} />
              : null
          ) : (
            <>
              {m.steps && m.steps.length > 0 ? <AgentSteps steps={m.steps} /> : null}
              {m.thinking ? <Reasoning text={m.thinking} live={m.streaming && !m.text} secs={m.secs} /> : null}
            </>
          )}
          {m.error ? (
            <div className="bubble ai" style={{ background: "var(--warn-soft)", color: "#80451f" }}>
              <div className="row gap-2" style={{ alignItems: "flex-start" }}>
                <Icon name="alert" size={15} /> <span>{m.errMsg}</span>
              </div>
            </div>
          ) : m.streaming && !m.text ? (
            <div className="bubble ai"><span className="dots"><span /><span /><span /></span></div>
          ) : (!m.text || !m.text.trim()) && m.pendingAction ? null : bubble(m.text, "b")}
          {approval}
          {steps.some(it => it.after) && (
            <Timeline items={steps.filter(it => it.after)} live={m.streaming} />
          )}
        </>;
      })()}
      {m.renders && m.renders.map((spec, k) => <RenderBlock key={k} spec={spec} onEditImage={onEditImage} onZoomImage={onZoomImage} />)}
      {m.imageCmd && onImageAction && !m.streaming && (
        <div className="row gap-2" style={{ marginTop: 6 }}>
          <button className="btn xs ghost" onClick={() => onImageAction(i, "regen")} disabled={busy}><Icon name="refresh" size={12} /> Regenerate</button>
          <button className="btn xs ghost" onClick={() => onImageAction(i, "exact")} disabled={busy}><Icon name="sparkles" size={12} /> Use my exact prompt</button>
        </div>
      )}
      {m.sources && m.sources.length > 0 && (() => {
        const imgs = m.sources.filter(s => kindFromName(s.name) === "photo");
        const docs = m.sources.filter(s => kindFromName(s.name) !== "photo");
        return (
          <div className="col" style={{ gap: 8, marginTop: 2 }}>
            {imgs.length > 0 && (
              <div className="src-thumbs">
                {imgs.slice(0, 6).map((s, j) => (
                  <div key={j} className="src-thumb" role="button" tabIndex={0} title={s.name}
                    onClick={() => onOpenPath && s.path && onOpenPath(s.path)}>
                    <img src={thumbUrl(s.path, 240)} alt={s.name} loading="lazy" />
                    {s.path && <a className="src-thumb-dl" title="Download" href={fileUrl(s.path)} download={s.name}
                      onClick={e => e.stopPropagation()}><Icon name="download" size={12} /></a>}
                  </div>
                ))}
              </div>
            )}
            {docs.length > 0 && (
              <div className="src-row">
                <span className="src-label">Sources</span>
                {docs.slice(0, 6).map((s, j) => (
                  <div key={j} className="src-chip" role="button" tabIndex={0} title={`relevance ${s.score}`}
                    onClick={() => onOpenPath && s.path && onOpenPath(s.path)}>
                    <Icon name="file" size={11} sw={1.8} /> {s.name}
                    {s.path && <a className="src-chip-dl" title="Download" href={fileUrl(s.path)} download={s.name}
                      onClick={e => e.stopPropagation()}><Icon name="download" size={10} /></a>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      {!m.streaming && !m.error && m.grounding && <GroundingBadge g={m.grounding} v={m.verification} />}
      {!m.streaming && !m.error && m.text && (
        <div className="msg-actions">
          <button className="msg-act" title="Copy" onClick={() => copyMsg(m.text)}><Icon name="copy" size={12} /> Copy</button>
          {m.text && m.text.length > 200 && <button className="msg-act" title="Download as Markdown" onClick={() => downloadMsg(m.text)}><Icon name="download" size={12} /> Download</button>}
          {isLast && !busy && <button className="msg-act" title="Regenerate" onClick={regenerate}><Icon name="refresh" size={12} /> Regenerate</button>}
        </div>
      )}
    </div>
  );
}

export { ChatMessage };
