// BON-12: stores. Create a WooCommerce store from a name and a niche, watch it come up (Provisioning → Ready or
// Failed with a reason), share it with teammates, see the wp-admin password once, delete it. Every rule (caps,
// ownership, who sees what) is enforced by the API; this page only reflects the answers.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api, type MemberAccess, type RuntimeInfo, type SlugPreview, type StoreInfo, type StoreList, type StoreNiche, type StoreStatus,
} from '../api.js';
import { useMe } from '../auth.js';
import { SecretOnce, when } from '../components.js';

export const NICHES: [StoreNiche, string][] = [
  ['stationery', 'Stationery & desk'], ['tea-coffee', 'Tea & coffee'], ['home-ceramics', 'Home & ceramics'],
  ['bags', 'Bags & accessories'], ['bike', 'Bike accessories'], ['custom', 'Custom (your own niche)'],
];
const STATUS: Record<StoreStatus, [string, string]> = {
  provisioning: ['Creating…', 'unknown'], ready: ['Ready', 'connected'], failed: ['Failed', 'unreachable'],
  deleting: ['Deleting…', 'disabled'], deleted: ['Deleted', 'disabled'],
};

export function StoreStatusBadge({ status }: { status: StoreStatus }) {
  const [label, cls] = STATUS[status];
  return <span className={`status ${cls}`}><span className="dot" aria-hidden="true" />{label}</span>;
}

/** Every 4 s while a store is coming up or going away, else every 15 s. */
const refetch = (d?: StoreList) => (d?.stores.some((s) => s.status === 'provisioning' || s.status === 'deleting' || s.passwordReset?.state === 'pending') ? 4_000 : 15_000);

/** "Pods 4/4 ready · CPU limits 2.1 of 4 · memory 1.5 of 3 GiB · seen 12 s ago" (admins; numbers from the provisioner). */
export function RuntimeLine({ r, now = Date.now() }: { r: RuntimeInfo; now?: number }) {
  const gib = (mib: number) => (mib >= 1024 ? `${Math.round((mib / 1024) * 10) / 10} GiB` : `${Math.round(mib)} MiB`);
  const age = r.at ? Math.max(0, Math.round((now - Date.parse(r.at)) / 1000)) : null;
  const allReady = r.pods.ready === r.pods.total;
  return (
    <p className="small muted" aria-label="Runtime">
      <span className={allReady ? '' : 'error'}>Pods {r.pods.ready}/{r.pods.total} ready</span>
      {r.quota && <> · CPU limits {r.quota.cpuLimits.used} of {r.quota.cpuLimits.hard} · memory limits {gib(r.quota.memoryLimitsMiB.used)} of {gib(r.quota.memoryLimitsMiB.hard)}</>}
      {age !== null && <> · seen {age < 60 ? `${age} s` : `${Math.round(age / 60)} min`} ago</>}
    </p>
  );
}

export function Stores() {
  const list = useQuery({ queryKey: ['stores'], queryFn: () => api<StoreList>('/api/stores'),
    refetchInterval: (q) => refetch(q.state.data), refetchIntervalInBackground: false });
  const data = list.data;
  return (
    <section className="stack">
      <div className="row between">
        <div>
          <h1>Stores</h1>
          <p className="muted">
            Each store is its own WooCommerce shop with its own database. When it is ready its tools appear in the chat and for
            MCP clients as <code>woo-&lt;name&gt;__…</code> — for you, and for the people you share it with.
          </p>
        </div>
        {data && (
          <p className="muted small" aria-live="polite">
            You own {data.limits.mine} of {data.limits.maxPerMember} · {data.limits.total} of {data.limits.maxTotal} on the platform
          </p>
        )}
      </div>
      {list.isPending && <p className="muted">Loading…</p>}
      {list.isError && <p className="error" role="alert">{list.error.message}</p>}
      {data && !data.enabled && <div className="card muted">Creating stores is not available on this installation.</div>}
      {data?.enabled && <NewStore atLimit={data.limits.total >= data.limits.maxTotal} />}
      {data?.stores.map((s) => <StoreCard key={s.id} s={s} />)}
    </section>
  );
}

function NewStore({ atLimit }: { atLimit: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [niche, setNiche] = useState<StoreNiche>('tea-coffee');
  const [nicheText, setNicheText] = useState('');
  const [tagline, setTagline] = useState('');
  // One key per form fill: a double click or a retry after a network error cannot create two stores.
  const idem = useRef(crypto.randomUUID());
  const preview = useQuery({
    queryKey: ['store-slug', name.trim()],
    queryFn: () => api<SlugPreview>(`/api/stores/slug?name=${encodeURIComponent(name.trim())}`),
    enabled: name.trim().length > 0,
    staleTime: 5_000,
  });
  const create = useMutation({
    mutationFn: () => api<StoreInfo>('/api/stores', {
      method: 'POST', headers: { 'idempotency-key': idem.current },
      body: { name: name.trim(), niche, ...(tagline.trim() ? { tagline: tagline.trim() } : {}), ...(niche === 'custom' ? { nicheText: nicheText.trim() } : {}) },
    }),
    onSuccess: () => {
      idem.current = crypto.randomUUID();
      setName(''); setTagline(''); setNicheText('');
      void qc.invalidateQueries({ queryKey: ['stores'] });
    },
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const slug = preview.data;
  return (
    <form className="card form" onSubmit={submit} aria-labelledby="newstore-h">
      <h2 id="newstore-h">Create a store</h2>
      <div className="row wrap align-end">
        <label className="grow">
          <span>Name</span>
          <input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        </label>
        <label className="grow">
          <span>Niche</span>
          <select value={niche} onChange={(e) => setNiche(e.target.value as StoreNiche)}>
            {NICHES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>
      {niche === 'custom' && (
        <label>
          <span>Your niche <span className="muted small">(becomes the store's only category; you add the products)</span></span>
          <input required maxLength={60} value={nicheText} onChange={(e) => setNicheText(e.target.value)} />
        </label>
      )}
      <label>
        <span>Tagline <span className="muted small">(optional)</span></span>
        <input maxLength={120} value={tagline} onChange={(e) => setTagline(e.target.value)} />
      </label>
      {name.trim() && slug && (
        <p className={`small ${slug.available ? 'muted' : 'error'}`} aria-live="polite">
          {slug.available ? <>Its address name will be <code>{slug.slug}</code> (cannot be changed later).</> : <>{slug.reason}</>}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={create.isPending || atLimit || (slug ? !slug.available : false)}>
          {create.isPending ? 'Creating…' : 'Create store'}
        </button>
        {atLimit && <span className="muted small">The platform is at its store limit; delete one first.</span>}
      </div>
      {create.isError && <p className="error" role="alert">{create.error.message}</p>}
      {create.isSuccess && <p className="small muted" role="status">Started. A store takes about 3–4 minutes to come up; this page updates by itself.</p>}
    </form>
  );
}

function StoreCard({ s }: { s: StoreInfo }) {
  const me = useMe().data;
  const [open, setOpen] = useState(false);
  const nicheLabel = s.nicheText ?? NICHES.find(([v]) => v === s.niche)?.[1];
  return (
    <article className={`card server ${STATUS[s.status][1]}`} aria-labelledby={`store-${s.id}`}>
      <div className="row between wrap">
        <div>
          <h2 id={`store-${s.id}`}>{s.name} {!s.isDefault && <code className="muted small">{s.slug}</code>}</h2>
          <p className="muted small">
            {s.isDefault ? 'The store installed with the platform.' : [
              nicheLabel,
              s.role === 'shared' && s.owner ? `shared by ${s.owner.name}` : s.role === 'admin' && s.owner ? `owner: ${s.owner.name}` : 'yours',
              s.createdAt ? `created ${when(s.createdAt)}` : '',
            ].filter(Boolean).join(' · ')}
          </p>
        </div>
        <StoreStatusBadge status={s.status} />
      </div>
      {s.status === 'failed' && s.statusReason && <p className="error small" role="alert">Why it failed: {s.statusReason}</p>}
      {s.status === 'provisioning' && <p className="muted small">Starting the database, WordPress and its MCP server…</p>}
      <p className="small row wrap">
        {s.url && s.status === 'ready' && <a href={s.url} target="_blank" rel="noreferrer">Open store ↗</a>}
        {s.adminUrl && <a href={s.adminUrl} target="_blank" rel="noreferrer">wp-admin ↗</a>}
        {s.role === 'shared' && !s.isDefault && <span className="badge">read-only tools unless the owner widened them</span>}
        {me?.role === 'admin' && s.namespace && <span className="muted">namespace <code>{s.namespace}</code></span>}
      </p>
      {me?.role === 'admin' && s.runtime && s.status === 'ready' && <RuntimeLine r={s.runtime} />}
      {s.canManage && s.status !== 'deleting' && (
        <>
          <button type="button" className="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide settings' : 'Settings, sharing and delete'}</button>
          {open && <Manage s={s} />}
        </>
      )}
    </article>
  );
}

function Manage({ s }: { s: StoreInfo }) {
  return (
    <div className="stack" style={{ marginTop: '0.75rem' }}>
      {s.status === 'ready' && <Password s={s} />}
      <Sharing s={s} />
      <DeleteStore s={s} />
    </div>
  );
}

function Password({ s }: { s: StoreInfo }) {
  const qc = useQueryClient();
  const [shown, setShown] = useState<{ username: string; password: string } | null>(null);
  const reveal = useMutation({
    mutationFn: () => api<{ username: string; password: string }>(`/api/stores/${s.id}/admin-password`, { method: 'POST' }),
    onSuccess: (r) => setShown(r),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['stores'] }); },
  });
  const isAdmin = useMe().data?.role === 'admin';
  const reset = useMutation({
    mutationFn: () => api<StoreInfo>(`/api/stores/${s.id}/admin-password/reset`, { method: 'POST' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['stores'] }); },
  });
  return (
    <div>
      <h3>wp-admin password</h3>
      {shown ? (
        <>
          <p className="small">Username: <code>{shown.username}</code></p>
          <SecretOnce label="Password" value={shown.password} note="Shown only once and not stored in readable form. Copy it now; if you lose it, use “Lost your password?” on the store's login page." />
          <button type="button" className="ghost" onClick={() => setShown(null)}>Hide</button>
        </>
      ) : s.passwordAvailable ? (
        <button type="button" onClick={() => reveal.mutate()} disabled={reveal.isPending}>Show the password (once)</button>
      ) : s.passwordReset?.state === 'pending' ? (
        <p className="muted small" role="status">Setting a new password in the store…</p>
      ) : (
        <p className="muted small">Already shown. {isAdmin ? 'Reset it below, or use' : 'Ask an admin to reset it, or use'} “Lost your password?” on the store's login page.</p>
      )}
      {isAdmin && s.passwordReset?.state === 'failed' && <p className="error small" role="alert">The last reset failed: {s.passwordReset.reason}</p>}
      {isAdmin && !shown && s.passwordReset?.state !== 'pending' && (
        <div className="row wrap" style={{ marginTop: '0.4rem' }}>
          <button type="button" className="ghost danger" onClick={() => { if (window.confirm('Set a new wp-admin password? The current one stops working and the new one is shown once.')) reset.mutate(); }} disabled={reset.isPending}>
            {reset.isPending ? 'Requesting…' : 'Reset the password (admin)'}
          </button>
        </div>
      )}
      {(reveal.isError || reset.isError) && <p className="error" role="alert">{(reveal.error ?? reset.error)?.message}</p>}
    </div>
  );
}

function Sharing({ s }: { s: StoreInfo }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['stores'] }); void qc.invalidateQueries({ queryKey: ['upstreams'] }); };
  const add = useMutation({
    mutationFn: () => api<StoreInfo>(`/api/stores/${s.id}/members`, { method: 'POST', body: { email: email.trim() } }),
    onSuccess: () => { setEmail(''); refresh(); },
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api<void>(`/api/stores/${s.id}/members/${userId}`, { method: 'DELETE' }),
    onSettled: refresh,
  });
  const rule = s.toolRule;
  const [access, setAccess] = useState<MemberAccess>(rule?.memberAccess ?? 'selected');
  const [tools, setTools] = useState<string[]>(rule?.memberTools ?? s.readOnlyTools ?? []);
  useEffect(() => { if (rule) { setAccess(rule.memberAccess); setTools(rule.memberTools); } }, [rule?.memberAccess, rule?.memberTools.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api<StoreInfo>(`/api/stores/${s.id}`, { method: 'PATCH', body: { memberAccess: access, ...(access === 'selected' ? { memberTools: tools } : {}) } }),
    onSuccess: refresh,
  });
  const toggle = (t: string) => setTools((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  return (
    <div>
      <h3>Shared with</h3>
      {s.members?.length === 0 && <p className="muted small">Nobody yet. Only you (and admins) can use this store's tools.</p>}
      <ul className="plain">
        {s.members?.map((m) => (
          <li key={m.userId} className="row between">
            <span>{m.name} <span className="muted small">{m.email}</span></span>
            <button type="button" className="ghost danger" onClick={() => remove.mutate(m.userId)} disabled={remove.isPending} aria-label={`Stop sharing with ${m.name}`}>Remove</button>
          </li>
        ))}
      </ul>
      <form className="row wrap align-end" onSubmit={(e) => { e.preventDefault(); add.mutate(); }}>
        <label className="grow">
          <span>Share with (their email)</span>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" disabled={add.isPending}>Share</button>
      </form>
      {(add.isError || remove.isError) && <p className="error" role="alert">{(add.error ?? remove.error)?.message}</p>}
      {rule && (
        <fieldset className="stack" style={{ marginTop: '0.75rem' }}>
          <legend>What people you share it with may do</legend>
          <div className="choices">
            {(['selected', 'all', 'none'] as const).map((a) => (
              <label key={a} className="choice">
                <input type="radio" name={`rule-${s.id}`} checked={access === a} onChange={() => setAccess(a)} />
                {a === 'selected' ? 'Selected tools' : a === 'all' ? 'All tools (can create products and change orders)' : 'No tools'}
              </label>
            ))}
          </div>
          {access === 'selected' && (
            <div className="choices">
              {s.tools?.map((t) => (
                <label key={t} className="choice"><input type="checkbox" checked={tools.includes(t)} onChange={() => toggle(t)} /><code>{t}</code></label>
              ))}
            </div>
          )}
          <div className="row">
            <button type="button" onClick={() => save.mutate()} disabled={save.isPending || (access === 'selected' && tools.length === 0)}>Save rule</button>
            {save.isSuccess && <span className="muted small" role="status">Saved — applies on their next request.</span>}
          </div>
          {save.isError && <p className="error" role="alert">{save.error.message}</p>}
        </fieldset>
      )}
    </div>
  );
}

function DeleteStore({ s }: { s: StoreInfo }) {
  const qc = useQueryClient();
  const [typed, setTyped] = useState('');
  const del = useMutation({
    mutationFn: () => api<StoreInfo>(`/api/stores/${s.id}?confirm=${encodeURIComponent(typed)}`, { method: 'DELETE' }),
    onSettled: () => { void qc.invalidateQueries({ queryKey: ['stores'] }); void qc.invalidateQueries({ queryKey: ['upstreams'] }); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); del.mutate(); }} className="stack">
      <h3>Delete this store</h3>
      <p className="muted small">
        Removes the shop, its products and orders, its database and its MCP server. This cannot be undone. Type <code>{s.slug}</code> to confirm.
      </p>
      <div className="row wrap align-end">
        <label className="grow"><span className="sr-only">Type the store name to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={s.slug} autoComplete="off" /></label>
        <button type="submit" className="danger" disabled={typed !== s.slug || del.isPending}>{del.isPending ? 'Deleting…' : 'Delete store'}</button>
      </div>
      {del.isError && <p className="error" role="alert">{del.error.message}</p>}
    </form>
  );
}
