# MyNotes — working rules (token-lean)

- Output: terse. No recaps, no restating the request, no doc reads unless needed.
- app.js is ~950KB: NEVER read it whole. Grep for the symbol, then Read a narrow offset/limit.
- Don't re-read docs/. Facts: offline PWA, IndexedDB `mynote-stocks` (v19, stores listed in db.js exportAll/importAll — add new stores to BOTH), no backend, no dev server.
- Served by Apache Alias `/mynote` -> this folder (http://localhost/mynote/). Apache restart needs admin (user does it).
- Every code change: bump `CACHE` in service-worker.js (`mynote-stocks-vNNN`), `node --check` (copy app.js to .mjs first), then `git add <files>`, commit, push (no confirmation needed).
- Sibling repo `../mynote-app` is the more advanced version; port features from its git history (`git show <hash>`), don't rewrite.
- Do not use subagents for this repo. Do not spawn a browser/preview.
