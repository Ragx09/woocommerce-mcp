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
5. **Where:** `services/gateway/src/auth/apiKeys.ts` (planned).
6. **Alternatives:** JWTs (can't be revoked instantly without a denylist), OAuth (stand-out item).
7. **Debugging:** Revoked but still working? Look for caching. 401 for a valid key? Check whitespace in the header and the `Bearer ` prefix.
8. **Self-test:** Why don't we need bcrypt or argon2 for API keys? What does the prefix help with?
