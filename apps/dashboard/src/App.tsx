import { NavLink, Outlet, Route, Routes } from 'react-router';
import { RequireAuth, useLogout, useMe, useSessionExpiry } from './auth.js';
import { Audit } from './pages/Audit.js';
import { Chat } from './pages/Chat.js';
import { Connect } from './pages/Connect.js';
import { Invite } from './pages/Invite.js';
import { Keys } from './pages/Keys.js';
import { Login } from './pages/Login.js';
import { Members } from './pages/Members.js';
import { Overview } from './pages/Overview.js';
import { Placeholder } from './pages/Placeholder.js';
import { ServerForm } from './pages/ServerForm.js';
import { Servers } from './pages/Servers.js';

export function App() {
  useSessionExpiry();
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/invite" element={<Invite />} />
      <Route path="/connect" element={<RequireAuth><Connect /></RequireAuth>} />
      <Route element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Overview />} />
        <Route path="servers" element={<Servers />} />
        <Route path="servers/new" element={<RequireAuth admin><ServerForm /></RequireAuth>} />
        <Route path="servers/:id/edit" element={<RequireAuth admin><ServerForm /></RequireAuth>} />
        <Route path="chat" element={<Chat />} />
        <Route path="keys" element={<Keys />} />
        <Route path="members" element={<RequireAuth admin><Members /></RequireAuth>} />
        <Route path="audit" element={<RequireAuth admin><Audit /></RequireAuth>} />
        <Route path="*" element={<Placeholder title="Not found" />} />
      </Route>
    </Routes>
  );
}

function Shell() {
  const me = useMe().data!;
  const logout = useLogout();
  const links: [string, string][] = [['/', 'Overview'], ['/servers', 'Servers'], ['/chat', 'Chat'], ['/keys', 'API keys']];
  if (me.role === 'admin') links.push(['/members', 'Members'], ['/audit', 'Audit log']);
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand"><img src="/favicon.svg" alt="" width={22} height={22} /> MCP Gateway</span>
        <nav aria-label="Main">
          {links.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>
          ))}
        </nav>
        <div className="who">
          <span title={me.email}>{me.name} <span className={`badge ${me.role}`}>{me.role}</span></span>
          <button type="button" className="ghost" onClick={() => logout.mutate()} disabled={logout.isPending}>Sign out</button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
