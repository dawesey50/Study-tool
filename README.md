# Processor

A local-first study system for a biomedical sciences degree. You feed it lecture
slides, transcripts, textbook pages and your own notes; it organises them into a
numbered section hierarchy with every extract traceable back to the exact slide,
page or timestamp it came from.

Everything lives in one SQLite file and one media folder on your own machine. No
accounts, no cloud, no lock-in.

## Where this is up to

**Phase 1 (Foundation) is complete and usable on its own.** You can build a
module's section hierarchy, ingest sources, and get an organised, searchable,
correctly cited store of your material with figures pulled out of the PDFs.

The model layer underneath Phase 2 is now in place — routing, cost accounting
and the limits that stop a runaway — but nothing generates yet. Notes are still
yours to write. Concept extraction, generated notes, the question engine,
spaced repetition and exam mode are Phases 2–5, and the database schema already
covers all of them, so those phases add behaviour rather than reshaping data.

| Phase | Status |
|---|---|
| 1 — Schema, ingestion, section tree, block note editor, search | Done |
| 2 — Model routing, cost accounting, spending limits | Done |
| 2 — Concept extraction, note generation, coverage check, cross-referencing | Not started |
| 3 — Question engine: blueprints, novelty gate, examiner pass | Not started |
| 4 — FSRS scheduling at concept level, mastery rollup | Not started |
| 5 — Past papers, timed exams, concept map | Not started |

## Using it

**Double-click `Processor.bat`** (Windows) or **`Processor.command`** (Mac).

That is the whole thing. It installs anything missing, rebuilds if the code
changed, starts the server and opens your browser. After the first run it takes
a couple of seconds. Leave the window open while you work; close it to shut
down.

Make a desktop shortcut to it once (right-click → *Send to* → *Desktop* on
Windows) and you never touch a terminal again.

If something goes wrong:

```bash
npm run doctor
```

It checks Node, dependencies, the database driver, ports and permissions, then
actually starts the server to capture the real error, and tells you what to do
about each one.

### Working on the code

```bash
npm install
npm run dev        # http://localhost:5173, with hot reload
```

That runs the API on port 5174 and Vite on 5173 with a proxy between them, so
edits appear immediately. `npm run app` is the launcher without the
double-click.

Copy `.env.example` to `.env` if you want to change anything. Every setting has
a working default, so this is optional — except an API key, which nothing can
generate without.

### API keys

Put at least one of `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` or `GROQ_API_KEY` in
`.env`. Everything already in the system works without any of them: search,
figures, citations and your own notes need no model at all. **Settings → Models
and spend** shows which keys it found, which model each task will actually run,
and a **Test connection** button that makes one short call so you find out a key
is wrong before a long job does.

Prices for Claude models are built in. If you add a Gemini or Groq key, put
their rates in `data/model-prices.json` — until you do, those calls are counted
but recorded as unpriced rather than as free.

### First run and the embedding model

Embeddings run locally through transformers.js using `all-MiniLM-L6-v2`. The
model (~90MB) is downloaded from HuggingFace the first time it is needed and
cached in `.models/`; after that it works entirely offline.

If that download cannot happen — offline machine, restricted network — ingestion
does **not** fail. Material is stored without vectors, keyword search keeps
working, and the sidebar says so. Once the model can be reached, click
**Backfill missing embeddings** on the Sources page and the vectors are filled
in. To skip the model entirely during development, set
`EMBEDDINGS_PROVIDER=hash`, which is deterministic and offline but produces
meaningless similarity scores.

## How it is put together

```
server/   Fastify + SQLite (better-sqlite3, Drizzle) + ingestion + embeddings
web/      React + Vite + Tailwind + TipTap
data/     Your SQLite file and media folder — gitignored, back this up
```

A few decisions worth knowing about, because they shape everything else:

**Sections are the organising unit, not lectures.** A lecture is a *source*; a
section is a *place in the syllabus*. One lecture usually spans several
sections, so sources are joined to sections many-to-many, with the mapping
proposed by embedding match and confirmable by you.

**Section numbers are derived, never stored.** "1.2.1" is computed from tree
position on read. Identity is a UUID, so dragging a branch somewhere else
renumbers the display without breaking a single link, note or reference.

**Chunks never span a page, slide or timestamp boundary.** A chunk covering
slides 13 and 14 could not honestly cite either, and honest citation is the
point. Transcript blocks are also split at long silences, so "transcript at
34:20" really is the material at 34:20.

**Figures come out of the PDF's own image objects.** pdfjs decodes them while
walking the operator list, and tracking the transformation matrix places each
image well enough to match it to the caption underneath. No poppler dependency.
Images that are too small, or that repeat across three or more pages, are
dropped as slide furniture rather than treated as figures.

**You write in a document; it is stored as blocks.** The editor is one
continuous page — type, press Enter, use `# ` for a heading or `- ` for a
bullet, `/` to insert a callout. There is no block type to pick.

Underneath, each top-level paragraph carries a stable id and is stored as its
own row. That is not machinery that leaked into the design, it is the point: a
block has an identity, an origin and a lock, which is what lets generation later
be told to expand this paragraph, rewrite that one, and leave the two you wrote
yourself completely alone. Exposing that in the interface was the mistake;
keeping it in storage was not.

Storage is markdown rather than the editor's own JSON, so it stays readable,
diffable, and directly usable as both input and output for a model.

**No feature code knows a model name.** Everything goes through one call —
`llm.complete({ task, prompt, images? })` — and the task is mapped to a model in
`.env`. Moving note generation from Sonnet to Opus is a line in a config file
and a restart, which is the whole reason the indirection exists.

Each task has a fallback chain (Claude → Gemini → Groq, skipping any provider
with no key), and one thing it deliberately will not fail over: a refusal. A
provider being down is an outage worth routing around; a model declining is a
decision, and quietly asking a different one is not a fix.

**Spending has brakes, not just a meter.** Every call is written to a ledger
with its tokens and its cost, aggregated per module and shown in Settings
against the spec's ~£7 budget. But a meter only tells you afterwards, and the
failure that costs real money is a coverage loop that never converges and runs
all night. So there are three limits: a token ceiling on any one job, a monthly
cap per module, and a maximum number of passes round any loop that regenerates
until a condition is met. Each stops and says why. None of them silently
switches to a cheaper model, because worse notes you did not ask for is the
failure hardest to notice.

Identical requests are served from a cache keyed on everything that shapes the
answer, so regenerating a lecture after fixing one section does not pay for the
parts that did not change.

**Vector search degrades rather than breaks.** sqlite-vec does the KNN when the
extension loads; when it does not, the same interface falls back to brute-force
cosine in JS, which is fast enough for one person's material.

## Development

```bash
npm run check        # typecheck both workspaces, then run the test suites
npm test             # unit + API tests on their own
npm run test:e2e     # browser journey (needs a running server and Playwright)
npm run seed         # fill a running server with a demo module to click around
npm run db:generate  # regenerate migrations after editing the Drizzle schema
```

Migrations are generated from `server/src/db/schema.ts` and applied
automatically at startup, so there is no separate migrate step.

[TESTING.md](TESTING.md) explains the four testing layers, and — importantly —
what you still need to check by hand the first time the real embedding model
downloads, since the suites run against an offline provider with no semantic
understanding.

## Backing up

**Back up** on a module's page downloads it as a single `.zip` — its rows, its
embeddings and every file they point at. **Restore from a backup** on the
Modules page brings it back, and a restore onto a clean install reproduces the
original exactly, identifiers included. Restoring a module that is still
present makes a copy rather than merging, because a duplicate can be deleted
and a silent overwrite cannot be undone.

The archive is an ordinary zip, openable without this program.

Copying the whole `data/` folder also works and is the way to move everything
at once: it is `processor.db` plus the media beside it.
