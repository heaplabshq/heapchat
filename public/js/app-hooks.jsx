import { App } from "./app.jsx";
import { ProjectAPI } from "./projects.jsx";
import { AgentAPI } from "./agents.jsx";
import { serialize, ChatAPI } from "./chat-data.jsx";
/* Custom hooks extracted from the App god component in app.jsx. Global-scope
   module (indirect-eval): the hook functions leak to global for app.jsx; they
   call React hooks internally and resolve API globals (ProjectAPI/AgentAPI from
   projects.jsx/agents.jsx) at call time (App render). */
const { useState, useEffect, useRef } = React;

// useState mirrored to localStorage[key]: parse(stored) seeds the initial value;
// the returned setter (supports an updater fn) serializes on every write. Behaves
// exactly like the inline get/setItem pairs it replaces.
function usePersistentState(key, parse, serialize) {
  const [val, setVal] = useState(() => parse(localStorage.getItem(key)));
  const set = next => setVal(prev => {
    const v = typeof next === "function" ? next(prev) : next;
    localStorage.setItem(key, serialize(v));
    return v;
  });
  return [val, set];
}

// owns the sidebar's project + agent lists and their reloaders (mount-loaded).
// setProjects/setAgents never escaped App, so they stay private to the hook.
function useProjectsAgents() {
  const [projects, setProjects] = useState([]);
  const [agents, setAgents] = useState([]);
  const reloadProjects = () => { ProjectAPI.list().then(setProjects).catch(() => {}); };
  const reloadAgents = () => { AgentAPI.list().then(setAgents).catch(() => {}); };
  useEffect(() => { reloadProjects(); reloadAgents(); }, []);
  return { projects, agents, reloadProjects, reloadAgents };
}

// owns the sidebar's recent-chats list. Refreshes on view/query/controls change,
// and re-polls a few times after a reply finishes (server auto-titles async).
// Deps that stay in App (chatQuery for the sidebar input, the chat controls) are
// passed in; returns { recentChats, setRecentChats, loadRecentChats }.
function useRecentChats(chatQuery, view, chatControls, projectChatControls) {
  const [recentChats, setRecentChats] = useState([]);
  const loadRecentChats = () => ChatAPI.all(chatQuery).then(list => setRecentChats(list.slice(0, chatQuery ? 40 : 20))).catch(() => {});
  useEffect(() => {
    const t = setTimeout(loadRecentChats, chatQuery ? 200 : 0);
    return () => clearTimeout(t);
  }, [view, chatControls, chatQuery]);
  const replyBusyRef = useRef(false);
  const mainBusy = !!(chatControls && chatControls.busy);
  const projBusy = !!(projectChatControls && projectChatControls.busy);
  useEffect(() => {
    const busyNow = mainBusy || projBusy;
    const justFinished = replyBusyRef.current && !busyNow;
    replyBusyRef.current = busyNow;
    if (!justFinished) return;
    const timers = [1200, 3000, 6000, 10000, 15000].map(ms => setTimeout(loadRecentChats, ms));
    return () => timers.forEach(clearTimeout);
  }, [mainBusy, projBusy]);
  return { recentChats, setRecentChats, loadRecentChats };
}

export { useProjectsAgents, useRecentChats, usePersistentState };
