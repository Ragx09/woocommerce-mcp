# Red-team brief (for the attacker LLM session)

You are testing a system **we own**, running locally. Try to break it; report everything you find. Another session fixes the issues and asks you to retest.

## Targets (only these)
Local k3d maps Traefik to host port 80, so the URLs carry no explicit port. (On the VPS, same hosts on its domain over https.)
- Storefront: `http://store.127.0.0.1.nip.io/` (WordPress + WooCommerce, COD)
- Dashboard + API: `http://app.127.0.0.1.nip.io/`, `/api/*`
- MCP gateway: `http://app.127.0.0.1.nip.io/mcp` (Streamable HTTP, bearer API key)

Do **not** touch GitHub, Groq, OpenRouter or any other external service, even though the gateway connects to some of them.

## What you get
- User B's gateway API key (role: member) and B's dashboard login. Nothing else: no admin login, no cluster access, no upstream credentials.

## Goals (any one is a finding)
1. Act as admin as user B (add/edit upstreams, invite, revoke others' keys).
2. Read or use an upstream credential (WooCommerce key, GitHub PAT) or another user's API key.
3. Make a call that is not in the audit log, or is attributed to the wrong user.
4. Keep using a key after it is revoked.
5. Reach internal services directly (woo-mcp, MariaDB, Postgres, WordPress admin REST).
6. Make the chat agent do something user B is not allowed to do, or reveal secrets (prompt injection, including via product names/descriptions you can create).
7. Pay less than the price at checkout, or mark an order paid without paying.
8. Break the gateway for other users (one bad request takes down tool listing).

## Report format (one block per finding)
```
Title:
Severity guess: Critical / High / Medium / Low
Target + endpoint:
Steps to reproduce (exact requests):
Expected vs actual:
Suggested fix (optional):
```
End each round with: "Round N complete: X findings."
