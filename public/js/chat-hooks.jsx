import { ChatPanel } from "./chat.jsx";
import { Composer } from "./composer.jsx";
/* Custom hooks extracted from the ChatPanel component in chat.jsx. Global-scope
   module (indirect-eval): the hook functions leak to global for chat.jsx and call
   React hooks internally. */
const { useState, useEffect, useRef } = React;

// keeps the message list pinned to the bottom as new content streams in, but only
// when the user is already near the bottom (don't yank them while reading above).
// Returns the scroll container ref, the atBottom ref (send() flips it true on a
// fresh send), the "jump to latest" affordance state, and the scroll handlers.
function useAutoScroll(msgs, busy) {
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  function onChatScroll() {
    const el = scrollRef.current; if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    atBottomRef.current = atBottom; setShowJump(!atBottom);
  }
  function jumpToLatest() { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; atBottomRef.current = true; setShowJump(false); }
  useEffect(() => { const el = scrollRef.current; if (el && atBottomRef.current) el.scrollTop = el.scrollHeight; }, [msgs, busy]);
  return { scrollRef, atBottomRef, showJump, onChatScroll, jumpToLatest };
}

// the per-chat mode toggles shown in the composer "+" menu (think / web / research
// / deep / deep-work / fact-check / use-files / use-memory). Four mirror the user's
// saved settings (re-sync when those change); the rest default off per chat.
// Returns each flag and its setter; ChatPanel threads them to the Composer and
// reads them in send().
function useChatModes(settings) {
  const [thinkOn, setThinkOn] = useState(!!settings.thinking);
  useEffect(() => { setThinkOn(!!settings.thinking); }, [settings.thinking]);
  const [webOn, setWebOn] = useState(settings.webSearch === true);
  useEffect(() => { setWebOn(settings.webSearch === true); }, [settings.webSearch]);
  const [researchOn, setResearchOn] = useState(false);   // quick research (agent loop) — exclusive with deep
  const [deepOn, setDeepOn] = useState(false);           // deep research (orchestrated pipeline) — exclusive with research
  const [deepWorkOn, setDeepWorkOn] = useState(false);   // multi-agent team (orchestrated) — exclusive with research/deep
  const [factCheckOn, setFactCheckOn] = useState(settings.factCheck !== false);
  useEffect(() => { setFactCheckOn(settings.factCheck !== false); }, [settings.factCheck]);
  const [useFilesOn, setUseFilesOn] = useState(true);   // per-chat: pull context from the user's docs/KB (RAG)
  const [useMemoryOn, setUseMemoryOn] = useState(true); // per-chat: apply long-term memory
  return {
    thinkOn, setThinkOn, webOn, setWebOn, researchOn, setResearchOn, deepOn, setDeepOn,
    deepWorkOn, setDeepWorkOn, factCheckOn, setFactCheckOn, useFilesOn, setUseFilesOn, useMemoryOn, setUseMemoryOn,
  };
}

export { useChatModes, useAutoScroll };
