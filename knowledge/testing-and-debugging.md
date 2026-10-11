# Testing & Debugging — learning notes

## Test layers
1. **What:** Unit tests check pure logic. Integration tests check real component pairs. E2E tests check the whole user flow. Deployment checks validate the manifests and the cluster.
2. **Why:** Fast, precise unit tests catch most bugs cheaply. E2E tests catch wiring bugs but are slow and give vague signals. You want both.
3. **Why we need it:** Every task needs evidence, and the demo must not fail live.
4. **How here:** vitest for unit and integration (including fake MCP servers that are slow, dead or have colliding names); `scripts/e2e.sh` for the DoD checks with two real keys; `scripts/check-chart.sh` for Helm (see TEST_PLAN.md).
5. **Where:** `services/*/test`, `tests/e2e`, `scripts/`.
6. **Alternatives:** Manual testing only. It isn't repeatable and can't produce evidence.
7. **Debugging a failing test:** Reproduce it in isolation; read the actual error; check whether the failure is in the test's setup or in the code under test.
8. **Self-test:** Which test layer would catch (a) a wrong OAuth1 signature, (b) a NetworkPolicy label typo, (c) chat calls not being attributed to the user?
