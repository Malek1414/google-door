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
- Mocks `/api/door-fix` from a scripted world (door at compass 60°, 8 m): turn 40° → 20° → 5°, two hallucinated jumps, a run of `found:false`, walk to 1 m. `/api/door-check` returns one verdict, `/api/live-token` is refused. The sim door gets a surveyed `approachBearing` so the map fallback can fire (except in the no-direction scenario).
- Compass via `deviceorientationabsolute` / `deviceorientation` (alpha, `webkitCompassHeading`, beta), steps via `devicemotion` peaks at 2 Hz. `navigator.geolocation` is wrapped to count calls.
- `through` follows CONTRACT § Phases: at the threshold the harness keeps stepping in place and serves `inside:true` at confidence 0.55 (must NOT propose) then 0.8 (must propose). "Noch draußen" must return to `threshold` and not re-propose within 4 s. Then devicemotion stops entirely and `through` must come from stillness (`STILL_MS` = 4 s) with no inside flag.
- No-direction scenario (own page, sim door NOT patched): a few good fixes, then only `found:false`. The `noDirectionLine` must be announced exactly once and the arrow must be hidden, with no map note.
- Checks: safety line once and first, phase order, "Noch draußen" only in `through`, both `through` routes, the 0.55 guard, no re-proposal after "Noch draußen", map fallback note, unsure line once, no GPS, no-direction line once without arrow, wheelchair card with three rows and exactly one request.
- `APPROACH_DEMO=1` opens `?approach=demo` / `?approach=check` directly (scripted demo engine, for selectors only). Checks that need door-fix calls or the real no-direction timing print `SKIP` with the reason and do not count as failures.

Screenshots in `e2e/out/approach-*.png`. Exit code = number of failed checks.

# e2e route regression (Malek's e21a687)

`node e2e/route.mjs [baseUrl]` (default `https://localhost:5173/`). Same Chrome and `playwright-core` as the smoke test. Phone viewport 402x874, touch, de-DE, geolocation Berlin Hbf. Each scenario gets a fresh browser context.

- `mock`: `/api/route` answers a recorded Routes response (re-anchored onto the tapped door). Door card → Route: a blue multi-point line on the map (every `google.maps.Polyline` is recorded page-side), "N Min. · X m" in the sheet, Start in slot 1, the steps list. Then a location tick plus a map pan that reloads `/api/entrances`: the preview must survive. Then "Andere Türen" → Kaffee chip → a Google POI → Route: the request goes to the POI, the preview survives a tick + reload again, and Start (slot 1) never opens guidance to the door routed to before.
- `slot`: wheelchair profile, a door the card says cannot be guided to: Start stays in slot 1, disabled (`aria-disabled="true"`), tapping it does nothing.
- `retry`: POI route fails once (quota) with the browser Routes library blocked: German reason plus "Erneut versuchen"; the retry draws the route, and the preview survives tick + reload with neither `selected` nor `placeOpen` set.
- `real`: no mocks, against the running backend (server proxy or the Maps JS fallback): a real line, duration and distance; "Route entfernen" clears line and sheet.
- `503` / `503js`: `/api/route` 503 `not_configured`, with and without the browser Routes library: never "Ungefähr in diese Richtung"; blocked → visible German reason, no line; allowed → a real route or a reason.
- `429`: `?sim=1` → arrival → "Zum Eingang führen"; `/api/door-fix` answers 429 twice, then 200: door-fix keeps being asked and the arrow appears.

Checks that depend on UI still being built print `PENDING` with the reason when the feature is absent from the DOM; present but wrong is a `FAIL`. `ROUTE_ONLY=mock,slot` runs a subset. `ROUTE_ASSETS_FROM=https://localhost:5199` serves every non-API file from an older build under the same origin (the Maps key is referrer-locked), to prove the checks catch the old bugs. Screenshots in `e2e/out/route-*.png`. Exit code = number of FAILs.

Unit side: `test/route-regression.test.ts` (client: German reasons, Maps JS fallback, no invented lines, cache keyed on the target, walking the recorded route) and `test/route-server.test.ts` (Python via vitest: polyline decode, `/api/route` 503 without a key, 401 as `auth`, `/api/door-fix` riding out 429/503; skipped when fastapi/httpx/pydantic are missing, `DOORWAY_PYTHON` picks the interpreter).

# e2e fuzz (seeded monkey test)

`node e2e/fuzz.mjs [baseUrl]`, `FUZZ_SEEDS=1,2,3` (default), `FUZZ_ACTIONS=600` (default), `FUZZ_VERBOSE=1` prints every action, `FUZZ_HEADED=1` shows the browser. Same Chrome and `playwright-core` as the smoke test. Phone viewport 402x874, touch, de-DE, geolocation Berlin Hbf; a fresh context per seed.

- Actions (weighted random walk, reproducible per seed): chips, map taps (Google POIs), `google.maps.Marker` clicks, door/feed/list rows, pills (Route/Start/Teilen/Speichern/close), card tabs, nav tabs, handle taps, CDP touch swipes on the sheet, search (open, type, Enter/suggestion/back/Escape/clear), back/close, rapid double taps, locate/go/layers.
- Faults: geolocation jumps (near, Munich, 0/0), `context.setOffline`, `/api/*` answered 500, 429 or delayed 1.5-3 s, viewport resize/rotate. Off the map (settings, guidance) it backs out, and reloads after 6 s.
- Invariants after every action (sheet transition settled first): no pageerror or console error (browser lines for injected failures and Google's own offline module errors are counted, not failed); exactly one sheet visible, its top below the search bar (unless full) and above the nav; nav visible at the bottom; root never scrolled; no stale `--drag`; no NaN/undefined/null/[object] in text or accessible names; live markers bounded, none left on a detached map; open intervals and window/document listeners bounded; the health snackbar appears within 9 s of a failed /api call or going offline, and "Keine Verbindung" clears within 9 s of a good answer.
- Also measured: first map tiles (ms after navigation), Long tasks > 200 ms with the action that caused them. Report in `e2e/out/fuzz-report.json`. Exit code = number of violations.
