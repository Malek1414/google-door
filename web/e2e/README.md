# e2e smoke

`node e2e/smoke.mjs [baseUrl]` (default `https://localhost:5173/`)

Needs system Chrome and `playwright-core`. If it is not resolvable from this folder, set
`PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core`. Chrome path can be overridden with `CHROME_PATH`.

Steps (one PASS/FAIL line each, screenshots in `e2e/out/NN-name.png`):

1. Map loads (`.gm`, search field "Hier suchen")
2. Each bottom tab (Erkunden, Für dich, Beitragen, Unternehmen) fills `.gm-sheet-body` without page errors
3. First chip toggles `aria-pressed`
4. First `.gm-row` opens a door card with a "Route" button
5. `?sim=1` clicks through the start screens and waits up to 60 s for "angekommen"
6. Prints all console errors and page errors

Exit code = number of failed steps.

# e2e approach replay (last 10 metres)

`node e2e/approach.mjs [baseUrl]` drives the real engine end to end. Needs the same Chrome and `playwright-core` as the smoke test.

- Reaches the screen through the UI: `?sim=1&speed=20` → Start → arrival card → "Zum Eingang führen" (blind profile = guidance, wheelchair profile = door check; profiles are preset in localStorage).
- Mocks `/api/door-fix` from a scripted world (door at compass 60°, 8 m): turn 40° → 20° → 5°, two hallucinated jumps, a run of `found:false`, walk to 1 m. `/api/door-check` returns one verdict, `/api/live-token` is refused. The sim door gets a surveyed `approachBearing` so the map fallback can fire.
- Compass via `deviceorientationabsolute` / `deviceorientation` (alpha, `webkitCompassHeading`, beta), steps via `devicemotion` peaks at 2 Hz. `navigator.geolocation` is wrapped to count calls.
- Checks: safety line once and first, phase order, "Noch draußen" only in `through` and guidance keeps running, map fallback note, unsure line once, no GPS, wheelchair card with three rows and exactly one request.
- `APPROACH_DEMO=1` opens `?approach=demo` / `?approach=check` directly (scripted demo engine, for selectors only).

Screenshots in `e2e/out/approach-*.png`. Exit code = number of failed checks.
