# Backend & Security — learning notes

## WooCommerce REST and OAuth1
1. **What:** WooCommerce exposes `/wp-json/wc/v3/*` (products, orders, …). Clients authenticate with a consumer key/secret pair tied to a WordPress user.
2. **Why it exists:** It gives external systems safe, versioned access to store data that runs through WooCommerce's business logic.
3. **Why we need it:** woo-mcp must read and write products and orders without touching the DB (D-003).
4. **How:** Over HTTPS: Basic auth (key:secret). Over plain HTTP (our in-cluster Service): **OAuth 1.0a one-legged**. Add `oauth_consumer_key`, `oauth_nonce`, `oauth_timestamp` and `oauth_signature_method=HMAC-SHA256`, build the signature base string `METHOD&urlencode(url)&urlencode(sorted params)`, sign it with HMAC using `consumer_secret&` (empty token secret), and send the signature as a query parameter. The secret never travels over the wire, so interception doesn't reveal it.
5. **Where:** `services/woo-mcp/src/woo/oauth1.ts` (planned), validated in ARC-14.
6. **Alternatives:** Application Passwords (HTTPS-only), WP-CLI exec (needs pod exec RBAC), direct SQL (bypasses business logic).
7. **Debugging:** 401 `woocommerce_rest_authentication_error` means a signature mismatch. Check URL normalisation (scheme, host, port, path exactly as WordPress sees them), parameter encoding (RFC 3986), and clock skew.
8. **Self-test:** Why is Basic auth refused over HTTP but OAuth1 accepted?

## API keys
1. **What:** Long random bearer secrets that identify a user to the gateway (`mgw_…`).
2. **Why:** MCP clients like Claude Code send a static header; they can't do our login form.
3. **Why we need it:** REQ-AUTH-03/04/05.
4. **How:** Generate 32 random bytes → show once → store `sha256(key)` + prefix. On each request, hash the presented key and look it up by hash. Revocation sets `revoked_at`, and the next lookup fails. A fast hash is fine because the key has 256 bits of entropy (brute force is infeasible). Passwords, by contrast, need argon2 because humans choose weak ones.
5. **Where:** `services/gateway/src/auth/{api-keys,key-routes}.ts`; `/mcp` check in `src/mcp/route.ts`; scripts get short-lived keys from `scripts/lib/gateway-key.mjs`.
6. **Alternatives:** JWTs (can't be revoked instantly without a denylist), OAuth (stand-out item).
7. **Debugging:** Revoked but still working? Look for caching. 401 for a valid key? Check whitespace in the header and the `Bearer ` prefix.
8. **Self-test:** Why don't we need bcrypt or argon2 for API keys? What does the prefix help with?

## Password login and brute-force limits
1. **What:** Email + password login for the dashboard. The password is stored as an **argon2id** hash; a successful login creates a server-side session.
2. **Why:** Humans pick guessable passwords. A slow, memory-hard hash makes every guess expensive for an attacker who steals the database, and a rate limit makes online guessing slow.
3. **Why we need it:** REQ-AUTH-01 (admin vs member needs real identities); D-007.
4. **How:** `hashPassword()` → `$argon2id$v=19$m=19456,t=2,p=1$salt$hash` (the PHC string carries salt and parameters). Login: look up the user → `verify()` → on success insert a session row keyed by `sha256(token)` and send the token in an `HttpOnly; SameSite=Strict` cookie. Three anti-enumeration habits: the same 401 for unknown email / wrong password / disabled user, and an unknown email still runs a full argon2 verify (against a dummy hash) so response *time* does not reveal accounts. The limiter counts failures per IP+email (5) and per IP (20) in 15 minutes.
5. **Where:** `services/gateway/src/auth/{password,sessions,limiter,routes,seed-admin}.ts`.
6. **Alternatives:** bcrypt (no memory hardness), scrypt (fine too), PBKDF2 (GPU-friendly); account lockout per email only (lets anyone lock out the admin); CAPTCHA (overkill here).
7. **Debugging:** Always 429 for everyone? Check which IP the gateway logs for logins: if every request shows the same node address, the ingress is SNATing (`externalTrafficPolicy: Cluster`) and per-IP limits become global. Login 401 with the right password? Check `disabled_at` and that the email is stored lower-case.
8. **Self-test:** Why does an unknown email still cost a full hash? Why is per-IP+email limiting safer than per-email lockout? Why is SHA-256 fine for session tokens but not for passwords?

## Sessions, cookies and CSRF
1. **What:** After login the browser holds a cookie `sid` with a random token; the server keeps `sha256(token)` → user and expiry. CSRF (cross-site request forgery) is another site making the victim's browser send a request that carries this cookie automatically.
2. **Why:** Cookies are sent by the browser on its own, so "has a valid cookie" does not prove "our page made this request".
3. **Why we need it:** REQ-AUTH-01 (dashboard users), D-007, T-12.
4. **How:** Cookie flags: `HttpOnly` (JavaScript cannot read it, so XSS cannot steal it), `SameSite=Strict` (not sent on requests started from another site), `Secure` on https, `Max-Age` 12 h. Plus an `Origin` check on every POST/PUT/PATCH/DELETE under `/api`: browsers always add `Origin` to such requests, and it cannot be forged by page scripts; if it is not our origin → 403 before the route runs. `Sec-Fetch-Site` is the fallback signal. Requests with neither header are not from a browser page, so there is no ambient cookie to abuse. Server-side sessions mean logout and disabling a user take effect on the very next request.
5. **Where:** `services/gateway/src/auth/{guard,sessions,routes}.ts`; chart env `PUBLIC_ORIGIN`, `COOKIE_SECURE`.
6. **Alternatives:** CSRF tokens (synchroniser/double-submit; more moving parts for an SPA), JWT in localStorage (readable by XSS, hard to revoke).
7. **Debugging:** 403 "cross-origin request refused" from your own dashboard → `PUBLIC_ORIGIN` must match the address bar exactly (scheme, host, port). Logged out at once on https → `COOKIE_SECURE` true behind plain http drops the cookie.
8. **Self-test:** Why is `SameSite=Strict` alone not the whole answer? Why is a cross-origin GET not a CSRF risk here? What happens to an open session when an admin disables the user?

## Default-deny authorization
1. **What:** Instead of remembering to add a guard to each route, every `/api` route must *declare* who may call it (`public`, `session`, `admin`); a route that declares nothing is refused at startup.
2. **Why:** The classic authorization bug is not a wrong check but a *missing* one on a newly added route (OWASP API1/API5: broken object/function level authorization).
3. **Why we need it:** REQ-AUTH-01, T-05; the brief demands server-side enforcement, not hidden buttons.
4. **How:** A Fastify `onRoute` hook sees every route as it is registered, throws if `config.access` is missing, and prepends the guards as `onRequest` hooks — so they run before body parsing and validation (anonymous callers learn nothing about the schema). The same hook records a table that the test walks: anonymous → 401 everywhere non-public, member → 403 on every admin route.
5. **Where:** `services/gateway/src/auth/access.ts`, `test/int/authz.int.test.ts`.
6. **Alternatives:** Per-route `preHandler` guards (easy to forget), a global middleware with a URL allowlist (drifts from the real routes), a policy engine (OPA/Casbin: overkill for two roles).
7. **Debugging:** Startup error "needs config.access" → add the policy to the new route. Unexpected 400 instead of 401 → the guard is running after validation (check it is an `onRequest`, not a `preHandler`).
8. **Self-test:** Why test against the registered routes rather than a list in the test? Why should authentication run before body validation?
