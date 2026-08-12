# Testing Processor

Four layers, cheapest first. Run the top two constantly, the third before you
commit anything structural, and the fourth when you want to convince yourself
the thing genuinely works.

| What | Command | Needs | Time |
|---|---|---|---|
| Types | `npm run typecheck` | — | ~5s |
| Unit + API tests | `npm test` | — | ~15s |
| Both together | `npm run check` | — | ~20s |
| Browser journey | `npm run test:e2e` | running server, Playwright | ~30s |
| Clicking around | `npm run seed` | running server | — |

Nothing above needs the network or an API key. The test suites use a
deterministic offline embedding provider and a throwaway database in your
temp folder, so they never touch `data/`.

---

## 1. Types

```bash
npm run typecheck
```

Covers both workspaces. `noUncheckedIndexedAccess` is on, so this catches a
real class of mistake rather than just spelling.

## 2. Unit and API tests

```bash
npm test                                    # everything
npx tsx --test server/test/chunk.test.ts    # one file
```

**Unit tests** cover the logic where a subtle bug would quietly corrupt your
material:

- `chunk.test.ts` — chunks never span a page, slide or timestamp boundary;
  splitting always terminates and loses nothing.
- `transcript.test.ts` — VTT and SRT parsing, hour offsets, rolling-caption
  de-duplication, and the rule that a long silence starts a new block so a
  citation cannot claim the wrong timestamp.
- `sections.test.ts` — numbering derived from position, reordering,
  reparenting, the refusal to drop a section inside itself, and that
  `replaceTree` preserves ids so attached notes survive a tree edit.
- `vector.test.ts` — BLOB round-tripping, cosine, and nearest-neighbour
  ranking against whichever vector backend is active.

**API tests** (`api.test.ts`) drive the real Fastify app, the real SQLite file
and the real ingestion pipeline through `app.inject()`. They upload the
fixture PDF as genuine multipart, ingest it, and assert on citations, figure
extraction, mapping confirmation, note round-tripping and search. Only the
data directory and the embedding provider are substituted.

This layer is where a regression is cheapest to catch. It found two real bugs
during Phase 1: a bodyless `POST` being rejected outright, and the error
handler being registered after the routes so every validation failure came
back as a 500 with a raw dump.

### Fixtures

`server/test/fixtures/` holds a two-page lecture PDF with two captioned
figures, and a VTT transcript with a deliberate 34-minute gap in the middle.
Both are small and committed, so the suites are self-contained.

## 3. The browser journey

```bash
npm install -D playwright && npx playwright install chromium   # once
npm run build && npm start                                     # terminal 1
npm run test:e2e                                               # terminal 2
```

One flowing journey rather than isolated cases: create a module, paste an
outline, upload and ingest slides, map them to sections, read chunks with
their slide citations, confirm figures actually render, write a note and
reload, lock it, search, and drag a section to a new position.

It fails on any browser console error, not just a failed assertion.

```bash
E2E_HEADED=1 npm run test:e2e                        # watch it happen
E2E_SCREENSHOT_DIR=./shots npm run test:e2e          # capture failures
```

Playwright is intentionally not a project dependency — most work does not need
it, and it is a large install. The script says so clearly if it is missing.

## 4. Clicking around with real data

```bash
npm run dev      # terminal 1
npm run seed     # terminal 2
```

Creates a demo Neuroscience module with a twelve-section hierarchy, ingests
both fixtures, and writes a few note blocks. Re-runnable — each run makes a new
module rather than touching what you already have.

To try it with your own material, just use the app: Sources → pick a type →
choose a file. Your own lecture PDFs are the real test, and the one worth doing
before term starts.

---

## What to check once the real embedding model works

The suites deliberately use `EMBEDDINGS_PROVIDER=hash`, which is deterministic
and offline but has **no semantic understanding at all**. It proves the
plumbing works; it says nothing about whether matching is any good.

So the first time you run with the real model — `EMBEDDINGS_PROVIDER=local`,
which downloads `all-MiniLM-L6-v2` on first use — check these by hand, because
no automated test here can:

1. **Does section mapping put lectures in sensible places?** Upload a real
   lecture and look at the proposed sections on the Sources page. Proposed
   mappings show dashed; confirmed ones show solid. If the proposals are
   consistently wrong, the thresholds in `server/src/services/mapping.ts`
   (`CHUNK_MATCH_THRESHOLD`, `SECTION_SHARE_THRESHOLD`) are the dials, and they
   have never been tuned against real embeddings.

2. **Does semantic search find paraphrases?** Search for something you never
   typed verbatim — "sodium pump" should reach material that says "Na+/K+
   ATPase". If only exact matches come back, the semantic half is not
   contributing and the sidebar status bar will usually say why.

3. **Are chunks the right size?** Open a section's Sources tab and read the
   extracts. Too coarse and citations get vague; too fine and context is lost.
   `CHUNK_TARGET_CHARS` in `.env` is the dial.

Also worth checking with your own files: that figures come out of *your*
slide decks. The extractor pulls images from the PDF's own objects, which
works well for normal decks, but a slide exported as one flat image per page
will yield one full-page "figure" rather than the diagram on it. If a deck
behaves that way you will see it immediately in the figures strip.

## Common problems

**`npm test` passes but the app misbehaves in the browser.** That gap is
exactly what `npm run test:e2e` exists to close — both Phase 1 browser bugs
were invisible to the API tests.

**Ingest reports chunks but zero figures.** Either the PDF has no embedded
images (text-only, or a scan where the whole page is one image), or they fell
below `FIGURE_MIN_DIMENSION`, or the same image repeated on three or more
pages and was dropped as template furniture. The ingest summary lists skipped
images as a warning.

**Sidebar says "Embeddings unavailable".** The model could not be downloaded.
Ingestion still worked and keyword search still works. Fix the network, then
press **Backfill missing embeddings** on the Sources page.

**A test leaves a stray database behind.** It should not — every suite uses
`mkdtemp` and cleans up in `after()`. If a run is killed mid-way, the leftovers
are in your system temp directory under `processor-*`, and nothing in `data/`
will have been touched.
