Goal: keep Yaver connectivity usable for magara and ubuntu-4gb-hel1-1 under the Snowball and failure-plumbing rules.

Current evidence:
- ubuntu-4gb-hel1-1 is reachable through https://public.yaver.io/d/2ed7da41-bd6c-4dad-8a13-116756a7ed02/info after updating production relay SPKI config and the box's cached public relay pin.
- magara still has no reachable HTTP, SSH, Tailscale, or relay path from this Mac and Convex marks it needsAuth. Do not weaken security or bypass relay pinning to make it appear reachable.

Product work to prefer:
- Fix false-green rescue behavior.
- Make relay SPKI pin rotation and stale cached relay metadata self-healing.
- Ensure rescue restart targets the actual installed service name.
- Add or keep tests that prove the guard by failing without the fix.

Gate:
- go test focused relay/rescue tests in desktop/agent.
- production Chromium closed-loop should keep ubuntu connected and should show a concrete route/blocker for magara.
