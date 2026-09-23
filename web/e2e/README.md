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
