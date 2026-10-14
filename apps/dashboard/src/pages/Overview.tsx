import { Link } from 'react-router';
import { useMe } from '../auth.js';

/** Landing page: who you are and how to connect an MCP client to the gateway. */
export function Overview() {
  const me = useMe().data!;
  const endpoint = `${window.location.origin}/mcp`;
  return (
    <section className="stack">
      <h1>Welcome, {me.name}</h1>
      <div className="card">
        <h2>Connect an MCP client</h2>
        <p>Every enabled server's tools are available at one endpoint, named <code>&lt;server&gt;__&lt;tool&gt;</code>.</p>
        <dl className="kv">
          <dt>Endpoint</dt>
          <dd><code>{endpoint}</code></dd>
          <dt>Transport</dt>
          <dd>Streamable HTTP</dd>
          <dt>Auth header</dt>
          <dd><code>Authorization: Bearer &lt;your API key&gt;</code> (create one under <Link to="/keys">My API keys</Link>)</dd>
        </dl>
      </div>
      <div className="card">
        <h2>Signed in as</h2>
        <dl className="kv">
          <dt>Email</dt>
          <dd>{me.email}</dd>
          <dt>Role</dt>
          <dd>{me.role === 'admin' ? 'Admin: manages servers, members and keys, and sees the audit log' : 'Member: uses the tools and manages your own keys'}</dd>
        </dl>
      </div>
    </section>
  );
}
