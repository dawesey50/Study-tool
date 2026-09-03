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

Phase 2 is built: the model layer with its cost accounting and spending limits,
concept extraction, note generation and the coverage check. Every prompt behind
it is a first draft that has never seen a real lecture, so what remains is
reading its output on your own material and revising it — `npm run simulate`
shows the pipeline running end to end on a made-up lecture, which proves the
plumbing but says nothing about the writing.

Exam mode is Phase 5. The database schema already covers it, so that phase
adds behaviour rather than reshaping data.

The question engine and the scheduler are built but have never seen a real
lecture. `npm run spike` is there to answer the question the whole engine rests
on — whether filtering by similarity produces questions that feel genuinely
different — and it needs a real API key and real material to answer properly.

| Phase | Status |
|---|---|
| 1 — Schema, ingestion, section tree, block note editor, search | Done |
| 2 — Model routing, cost accounting, spending limits | Done |
| 2 — Concept extraction and ownership | Done, prompt unvalidated |
| 2 — Note generation and the coverage check | Done, prompt unvalidated |
| 3 — Question engine: blueprints, novelty gate, examiner pass | Done, untested on real material |
| 4 — FSRS scheduling at concept level, mastery rollup | Done |
| 5 — Past papers setting examinability | Done |
| 5 — Timed exams, concept map | Not started |

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
bullet, `/` to insert a callout, a table, a figure or a cross-reference. There
is no block type to pick.

A figure can only be placed from the ones ingestion pulled out of your own
PDFs, and a cross-reference can only point at a section that exists, because
either one typed by hand could look right and resolve to nothing. A
cross-reference stores the section's identity, never its number, so moving
either section around the tree renumbers what it displays instead of breaking
it.

Underneath, each top-level paragraph carries a stable id and is stored as its
own row. That is not machinery that leaked into the design, it is the point: a
block has an identity, an origin and a lock, which is what lets generation later
be told to expand this paragraph, rewrite that one, and leave the two you wrote
yourself completely alone. Exposing that in the interface was the mistake;
keeping it in storage was not.

Storage is markdown rather than the editor's own JSON, so it stays readable,
diffable, and directly usable as both input and output for a model.

**Concepts are the unit everything else references.** Extraction reads the
chunks mapped to a section and writes down each specific claim that could be
examined, with the slide or page it came from. Notes are generated against that
list, coverage is measured against it and questions are sampled from it — so
everything later inherits whatever is in it, which is why it is a list you read
and correct rather than a hidden intermediate.

Two things hold whatever the model returns. A concept citing chunks that are
not in the section is dropped rather than stored, because a claim that cannot
be traced back to your material is one the model knew already. And near-
identical concepts are merged: over-splitting is what makes a coverage badge
lie, since five restatements of one idea are all "covered" by the sentence that
says it once.

**Pathways render as diagrams, equations as maths.** A `diagram` block holding
Mermaid is drawn where it sits — a pathway as arrows beats the same pathway as
a sentence, and biochemistry is full of them. `$...$` in prose is rendered by
KaTeX, because the Nernst equation set properly is materially easier to read
than as plain text. Both libraries load only when a note actually contains one,
so a module with neither pays nothing for them. Storage stays markdown either
way: a fenced ```mermaid block, and the LaTeX between its dollar signs.

**Past papers say what is examinable.** Every question in one was examined by
definition, so matching them against the concept list needs no model at all.
Each flag it sets carries the paper, the page and the words that matched,
because that flag goes on to weight note generation and question sampling — a
wrong one you cannot check is worse than no flag. It never clears a flag you
set yourself.

**Generated notes never touch your writing.** A generation run replaces the
blocks it wrote before and nothing else: anything you wrote, and anything you
locked, stays exactly where it is. A restore point is taken first regardless.

**The coverage badge says only what it checked.** It verifies that every
concept in the section's list is explained somewhere in the notes — by
comparing against what was actually written, not against the model's claim to
have covered it. It cannot verify that the concept list covers the lecture, and
it does not pretend to; the tooltip says so. When something is not covered it is
named, because "44/47, and here are the three" is worth more than 47/47 obtained
by letting the loop keep trying.

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

[WEEKLY.md](WEEKLY.md) is the one-page version of how a week goes with this,
and what to check before term.

[TESTING.md](TESTING.md) explains the five testing layers, and — importantly —
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

**Restore points** are the smaller, faster thing beside it, on the same page.
One holds a module's notes and nothing else, and one is saved automatically
before anything rewrites notes in bulk. Restoring puts the notes back exactly —
identities, locks and authorship included — and because that can delete work
done since, the confirmation says how many blocks will go and how many of them
you wrote yourself before it does anything. Restoring saves the state it is
replacing first, so it is itself undoable.

Use a restore point to undo a generation run; use a backup to survive losing
the folder.

Copying the whole `data/` folder also works and is the way to move everything
at once: it is `processor.db` plus the media beside it.
