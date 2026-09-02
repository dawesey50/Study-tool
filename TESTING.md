# Testing Processor

Five layers, cheapest first. Run the top two constantly, the third before you
commit anything structural, and the last two when you want to convince yourself
the thing genuinely works.

| What | Command | Needs | Time |
|---|---|---|---|
| Types | `npm run typecheck` | — | ~5s |
| Unit + API tests | `npm test` | — | ~15s |
| Both together | `npm run check` | — | ~20s |
| Browser journey | `npm run test:e2e` | running server, Playwright | ~30s |
| Pipeline dry run | `npm run simulate` | — | ~5s |
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
- `web/test/blockMarkdown.test.ts` — that a section survives the trip from
  storage into the editor and back unchanged, including tables, placed figures
  and cross-references. This one matters more than its size suggests: it runs
  on every save, and a bug there does not crash anything, it quietly rewrites
  your notes into something slightly wrong until you notice weeks later.
- `generation.test.ts` — note generation and the coverage check. The one that
  matters most is the lock: `locked` and `user_written` have been enforced since
  Phase 1, but only against a person editing, never against a generator
  rewriting a section. That guarantee is now tested against the thing it was
  built for. The coverage loop has two exits and both are covered — the pass cap,
  and a pass that stopped making progress, because continuing past that only
  costs money.
- `pastPapers.test.ts` — flagging concepts as examinable from past papers. No
  model is involved, so what it has to get right is not being confidently
  wrong: every flag carries its evidence, a flag you set by hand is never
  cleared, and when there is nothing to compare it concludes nothing rather
  than guessing.
- `concepts.test.ts` — extraction, dedupe and ownership, all against the stub.
  It says nothing about whether the extraction *prompt* is any good — that
  needs real material and your judgement. What it does prove is what must hold
  whatever the model returns: an uncitable concept is dropped, restatements
  merge, ids survive a re-run so nothing pointing at a concept is orphaned, and
  a spending limit stops the whole job rather than being hit once per section.
- `snapshots.test.ts` — restore points. The central test simulates the failure
  they exist for rather than waiting for it: it takes a restore point through
  the same seam generation will use, then deletes and overwrites everything in
  the section, and checks that going back really goes back — locks, authorship
  and block identities included. It also covers the case that matters for
  pruning, twenty snapshots inside one second, which is what a run over twenty
  sections does.
- `llm.test.ts` — the model layer, all of it offline. A stub provider that
  reports real-looking token counts stands in for the transport, so routing,
  the ledger, the cache, the fallback chain and every spending limit are
  exercised without a key. Three of those tests exist because the alternative
  is proving them with a real bill: a run that will not stop at its token
  ceiling, a month that will not stop at its cap, and a coverage loop that
  never converges. The stub answers for whatever model it is asked for, so the
  cost arithmetic is checked against the real price table rather than an
  invented rate.

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
reload, lock it, insert a table and a figure and a cross-reference and check
they come back as real blocks rather than the text of their own markup, add a
Mermaid pathway and a LaTeX equation and confirm both actually render — which
also proves the on-demand imports resolve rather than silently failing — search,
drag a section to a new position — which must renumber the cross-reference
rather than leave it stale — and open Settings to check that it says which
model each task will run and where the spending limits sit.

It fails on any browser console error, not just a failed assertion.

```bash
E2E_HEADED=1 npm run test:e2e                        # watch it happen
E2E_SCREENSHOT_DIR=./shots npm run test:e2e          # capture failures
```

Playwright is intentionally not a project dependency — most work does not need
it, and it is a large install. The script says so clearly if it is missing.

## 4. A dry run of the whole pipeline

```bash
npm run simulate
```

Takes a made-up neuroscience lecture — nine slides and a transcript with the
lecturer's own cues in it — through ingest, mapping, concept extraction, note
generation and the coverage check, printing each stage. No key, no network, and
a throwaway database it removes afterwards.

**What it proves and what it does not.** The model is a stub and its output was
written by hand, so this exercises the plumbing: that material flows all the way
through, that citations survive, that dedupe and the uncitable-concept guard
fire, that your locked block is untouched by a generation run, and that the
coverage badge counts what was actually written. It says nothing whatever about
whether a real model would extract good concepts or write good notes. Three
flaws in the canned output are deliberate — a duplicated concept, one citing a
chunk from another section, one concept the notes never cover — so you can watch
each guard do its job.

It has already earned its keep: the first run showed a supplementary coverage
pass appending a duplicate of the entire section, because the code trusted the
prompt's instruction not to repeat itself instead of checking.

## 5. Clicking around with real data

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

## What to check the first time a real API key is in place

Same caveat as the embedding model, for the same reason: every automated test
runs against a stub provider, which proves the plumbing and nothing about a
real API.

1. **Press Test connection** in Settings → Models and spend. It makes one short
   call and names the provider and model that answered. Do this before a long
   job rather than after.
2. **Read the routing table under "Which model runs what."** With only one key
   set, tasks routed to a provider you have no key for quietly run on a
   stand-in — the table says so in red, but it is worth knowing that concept
   extraction is running on Claude rather than the cheaper Gemini route it was
   designed for.
3. **Check the Gemini and Groq model names** in `.env` against those providers'
   own documentation before adding their keys. They rename models often, and
   the defaults shipped here are a starting point, not a promise.
4. **Watch the first module's spend** for a few generations, then judge whether
   `LLM_MONTHLY_CAP_GBP` is set somewhere useful. The default is £15 against a
   spec budget of about £7, which is deliberately loose — a cap that fires
   during ordinary work teaches you to raise it without reading it.
5. **Read a concept list for a lecture you know well** and decide whether you
   agree with it. This is plan v2's done-when for concept extraction and only
   you can run it. Concepts must be atomic and specific: "the brain has several
   regions" is too vague to write a question from, and if extraction is
   producing statements like that, the prompt in
   `server/src/llm/prompts.ts` needs fixing there, where it is cheap, rather
   than after notes and questions have both inherited it.
6. **Check the concept count warning is not crying wolf.** It fires only on
   extremes and every number behind it is a guess — a slide deck is terse and
   dense in claims, a transcript verbose and sparse. `CONCEPT_CHARS_EACH` and
   the band either side of it are in `.env`.

## Common problems

**`npm test` passes but the app misbehaves in the browser.** That gap is
exactly what `npm run test:e2e` exists to close — both Phase 1 browser bugs
were invisible to the API tests.

**A big document seems to hang.** It should not any more: ingestion runs as a
background job with a progress bar, and the rest of the app stays usable while
it works. A 600-page textbook takes about ten seconds to read. If it genuinely
stops moving, the progress line names the page it stopped on.

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
