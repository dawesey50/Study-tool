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

There is no AI generation yet. Notes are yours to write; concept extraction,
generated notes, the question engine, spaced repetition and exam mode are
Phases 2–5. The database schema already covers all of them, so those phases add
behaviour rather than reshaping data.

| Phase | Status |
|---|---|
| 1 — Schema, ingestion, section tree, block note editor, search | Done |
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
a working default, so this is optional.

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

Copy the `data/` folder. It is the whole system: `processor.db` plus the media
files it points at. A git repo or a synced folder both work.
