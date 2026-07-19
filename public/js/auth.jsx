import { Icon, BrandGlyph } from "./icons.jsx";
// auth.jsx — sign-in + first-run setup screens (multi-tenant)
function AuthScreen({ mode, onAuth }) {
  const { useState } = React;
  const setup = mode === "setup";
  const [form, setForm] = useState({ name: "", username: "", password: "", confirm: "" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = p => setForm(f => ({ ...f, ...p }));

  async function submit(e) {
    e.preventDefault();
    if (setup && form.password !== form.confirm) { setErr("Passwords don't match"); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch(setup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(setup ? { name: form.name, username: form.username, password: form.password } : { username: form.username, password: form.password }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Something went wrong");
      onAuth(j.user);
    } catch (e2) { setErr(e2.message); setBusy(false); }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <div className="row center gap-2" style={{ marginBottom: 4 }}>
          <div className="brand-mark"><BrandGlyph size={18} /></div>
          <span className="x-bold tighter" style={{ fontSize: 21 }}>Heap Chat</span>
        </div>
        <div className="t-sm ink-3" style={{ textAlign: "center", marginBottom: 16, lineHeight: 1.5 }}>
          {setup
            ? "Welcome! Create the admin account to get started — your existing knowledge base, chats, and memory move into it."
            : "Sign in to your library"}
        </div>
        {setup && (
          <div className="field" style={{ marginBottom: 10 }}>
            <span className="field-label">Display name</span>
            <input className="ex-input" value={form.name} onChange={e => set({ name: e.target.value })} placeholder="Your name" autoComplete="name" />
          </div>
        )}
        <div className="field" style={{ marginBottom: 10 }}>
          <span className="field-label">Username</span>
          <input className="ex-input" autoFocus value={form.username} onChange={e => set({ username: e.target.value })} placeholder="username" autoComplete="username" autoCapitalize="none" />
        </div>
        <div className="field" style={{ marginBottom: 10 }}>
          <span className="field-label">Password</span>
          <input className="ex-input" type="password" value={form.password} onChange={e => set({ password: e.target.value })} autoComplete={setup ? "new-password" : "current-password"} />
        </div>
        {setup && (
          <div className="field" style={{ marginBottom: 10 }}>
            <span className="field-label">Confirm password</span>
            <input className="ex-input" type="password" value={form.confirm} onChange={e => set({ confirm: e.target.value })} autoComplete="new-password" />
          </div>
        )}
        {err && <div className="callout warn" style={{ margin: "4px 0 10px", textAlign: "left" }}><Icon name="alert" size={15} /><span>{err}</span></div>}
        <button className="btn primary" type="submit" disabled={busy || !form.username.trim() || !form.password} style={{ width: "100%", justifyContent: "center", marginTop: 6 }}>
          {busy ? <><span className="spin-mini" /> {setup ? "Creating…" : "Signing in…"}</> : setup ? "Create admin account" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

export { AuthScreen };
