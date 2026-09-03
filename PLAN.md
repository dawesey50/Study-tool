# Processor — spec audit and development plan

Audited 15 August 2026 against `studytoolspec.md` (spec v2).

> **Superseded by plan v2, and partly done.** Step 2 of v2 — "make it safe to
> put a term's work in" — is complete: scanned PDFs are detected and reported,
> a module exports to and restores from a single zip, uploads take many files
> at once, a running ingest can be cancelled, and a restore point is taken
> automatically before anything rewrites notes in bulk — so the first time
> `locked` and `user_written` are tested against a real generator, a bad run is
> survivable. **Step 4 — concept extraction and
> ownership — is built too**, though its prompt is unvalidated until real
> lecture material has been through it, which is Step 1's job. **Step 3 — the LLM layer — is
> also complete**, which closes P1-4: `llm.complete({ task, prompt, images? })`
> routes by config, falls back between providers, records every call's tokens
> and cost per module, caches identical requests, and enforces the three limits
> v2 added (a per-run token ceiling, a per-module monthly cap, and a maximum
> number of passes round any regeneration loop). **P1-1 is closed too**: table,
> figure and cross-reference are real editor nodes rather than block types that
> degraded to plain prose, which had to happen before generation writes them
> rather than after. The findings below stand; the
> ordering has been replaced by v2's, which makes the reality check on real
> material a blocking first step — and that step, Step 1, is still yours to run.
> It no longer blocks any code, but it is what tells you whether the extraction
> prompt and the mapping thresholds are any good, and Step 5 should not start
> until it has.

**Method.** Every claim below was checked against the code or measured, not
recalled. Feature presence was verified by finding the route or component that
implements it — a database table or a code comment mentioning something does
not count as that thing existing. Behavioural claims were measured against
generated fixtures (a 600-page textbook, a 900-page document, a scan with no
text layer).

**State at audit.** 60 automated tests pass (44 server, 16 web) plus 15 browser
steps. Phase 1 of the spec's build order is complete and usable. Phases 2–5 —
which is where the spec's two differentiators live — are not started.

---

## 1. Conformance against the spec

| Spec | Status | Notes |
|---|---|---|
| §2 Local-first, single user, SQLite + media folder | **Done** | One file plus a folder, no accounts, works offline once the model is cached |
| §2 Inputs: slides, transcripts, textbook, own notes | **Done** | PDF, DOCX, TXT/MD, VTT/SRT |
| §2 No audio pipeline | **Done** | Correctly out of scope |
| §3 Frontend stack | **Done** | React/TS/Vite/Tailwind/TanStack/TipTap in use; KaTeX and Mermaid now render equations and pathway diagrams, loaded on demand |
| §3 Backend stack | **Done** | Fastify, better-sqlite3, Drizzle, sqlite-vec, local media |
| §3 Ingestion libraries | **Mostly** | pdfjs, mammoth, transformers.js in use. `pdf-to-img` never added, so there are no page thumbnails |
| §3 LLM routing (`llm.complete`) | **Done** | One interface, task-to-model mapping in config, provider fallback, cost ledger and three spending limits |
| §4 Section hierarchy, drag-and-drop, stable UUIDs | **Done** | Numbers derived from position; verified that reordering renumbers without breaking links |
| §4 Hierarchy by hand / grow as you go | **Done** | Paste an outline, or add sections individually |
| §4 Hierarchy *proposed* by an LLM | **Not started** | Spec calls this "the default flow" |
| §4 Four tabs per section | **Mostly** | Notes, Concepts, Practice and Sources work; Exam questions is still an honest placeholder |
| §5 Data model | **Done** | All 15 tables exist, including those nothing writes to yet |
| §6.1 Note generation pipeline | **Done** | Block-by-block against the concept list; prompt unvalidated on real material |
| §6.2 Coverage check and badge | **Done** | Measured against the note text, capped at three passes, names what is uncovered |
| §6.3 Note format config template | **Done** | One editable template, overridable with NOTE_FORMAT |
| §6.4 Figure placement by similarity | **Done** | Placed beside the block their caption matches |
| §6.5 Cross-referencing instead of repeating | **Mostly** | The crossref block renders and resolves to a live section number; ownership is assigned across the module at ~0.9 cosine. Generation writing crossref blocks instead of prose is Step 5 |
| §6.6 Editing and edit preservation | **Done** | Blocks carry origin and a lock; locked blocks reject edits |
| §6.6 Section action toolbar | **Not started** | No "explain further", "rewrite", "go deeper" |
| §7 Question engine | **Done, untested on real material** | Blueprint sampling, 11 archetypes, 6 distractor strategies, novelty gate, examiner pass, answer-key balancing. `npm run spike` exists to judge the gate — its offline half already showed the trigram check catches copy-paste and not paraphrase |
| §8 FSRS revision | **Done** | ts-fsrs at concept level, confidence-driven grades, mastery rolled up the tree with untested concepts counted as zero. Confident-and-wrong kept beside the schedule because FSRS has no grade for it |
| §9 Exam mode | **Not started** | |
| §10 Sidebar tree, global search | **Done** | Keyword and semantic search, merged |
| §10 Dashboard, concept map, command palette | **Part** | The revision view is a per-module dashboard; no concept map and no command palette |
| §12 Cost estimate | **Done** | Every call recorded and priced, aggregated per module in Settings against the cap |
| §13 Things to deliberately not do | **Respected** | No audio, no accounts, no chat-first UI, no topic-string questions, no silent overwrites, no decorative figures |

---

## 2. Problems found in this audit

Ordered by how much damage each does. The first four are cheap and block real
use of the system with your own material.

### P0-1 — A scanned textbook produces nothing, silently

**Measured:** a 6-page PDF whose pages are images with no text layer yields
`0 text blocks, 0 chunks, 6 figures, 0 warnings`.

You would see "0 chunks · 6 figures" and no explanation. Worse, every later
phase reads from chunks, so a scanned book is invisible to note generation and
the question engine while appearing to have been ingested successfully.

Many biomedical textbooks are distributed as scans, so this is likely to be the
first thing you hit. Two parts: detect it and say so plainly, then offer an OCR
path (spec §14.3 already anticipates Gemini Flash vision for this).

### P0-2 — No backup or export

The spec's central promise is that your material is yours and portable. There
is no way to export a module, no way to verify a backup is good, and no
in-app statement of what to copy. `data/` is documented in the README, which is
not the same as the app helping you keep your work.

For a system holding a term's notes, this is the highest-consequence gap in the
audit. Losing the folder loses everything.

### P0-3 — One file at a time, capped at 200 MB

A real module is roughly 20 lectures plus a textbook. Uploading them one at a
time, waiting for each, is tedious enough that it will put you off using the
thing. The 200 MB cap is also below some scanned textbooks — the 900-page test
document was 121 MB, and a genuine scan is larger.

### P0-4 — Dead dependencies, missing rendering — **fixed**

KaTeX and Mermaid were in `web/package.json` and imported nowhere, so the
spec's "pathway and process diagrams as Mermaid" and equation rendering did not
exist while the download cost did.

Plan v2 was right to defer this rather than wire a renderer to content that did
not exist yet. Generation can now write a diagram block, so both are wired up:
Mermaid draws pathway diagrams where they sit, `$...$` renders through KaTeX,
and the note format asks generation to produce both. Each library is imported
on demand, so a module with no diagrams and no equations pays nothing for
them — which was the half of the complaint that mattered.

### P1-1 — Block types that degrade to plain text — **fixed**

`crossref`, `figure` and `table` were in the type union and the database, but
the editor had no node for them, so they fell through to prose. §6.5's cross-
reference block — the thing that stops notes repeating themselves — had nowhere
to render.

All three are now real nodes, with the reference columns (`figure_id`,
`target_section_id`) written on every save so "which blocks point at this
section?" is a query rather than a scan of every note's text.

### P1-2 — No way to cancel a running ingest

A wrong file, or a scan you did not mean to process, runs to completion. There
is no cancel, and no delete-while-running.

### P1-3 — Section mapping thresholds are untuned

`CHUNK_MATCH_THRESHOLD` and `SECTION_SHARE_THRESHOLD` in
`server/src/services/mapping.ts` are reasoned guesses that have never seen a
real embedding, because the test suites run on a deterministic offline provider
with no semantic understanding. They may be badly wrong on real material.

### P1-4 — No cost tracking

The spec budgets ~£7 per module. Once §6–§9 exist, nothing will measure what is
actually being spent, and a runaway regeneration loop could cost real money
with no visible warning.

---

## 3. Development plan

Term starts in roughly two weeks. That budget shapes everything below: the plan
is ordered so that the most valuable thing you could have on day one of term
arrives first, and so that each step is usable before the next begins.

### Step 0 — Make it safe to put real material in (about a day)

Do this before feeding it a term's worth of lectures, because the later steps
build on whatever ingestion produces.

1. Detect a text-free PDF and say so: "This looks like a scan — no text could
   be read. Generated notes and questions need text." Offer OCR as the fix.
2. Export and restore a module as a single file, plus a "back up now" action
   that states plainly where your data is.
3. Multi-file upload with a queue, so a module's twenty lectures go in once.
   Raise the size cap and make the limit's error message accurate.
4. Cancel a running ingest.
5. Either wire up KaTeX and Mermaid, or remove them.

### Step 1 — The LLM layer (about a day)

Everything in §6–§9 sits on this, and it is worth building once, properly:

- `llm.complete({ task, prompt, images? })` with the spec's §3 routing table,
  so models are a config choice rather than a code change.
- Provider fallback (Claude → Gemini → Groq) as §3 describes.
- **Token and cost accounting per call**, aggregated per module, surfaced in
  Settings. This is P1-4, and it is far cheaper to build in now than to retrofit.
- Response caching keyed on input hash, since §12's whole cost argument depends
  on never regenerating unchanged content.

### Step 2 — Concept extraction (2–3 days)

The atomic unit everything else references. Nothing about notes, coverage,
questions or scheduling works without it.

- Extract concepts per section from mapped chunks, with `source_chunk_ids` so
  every concept traces back to a slide or timestamp.
- Populate `examinable_flag` and `emphasis_score` from lecturer cues.
- A concept list view per section, so you can see and correct what it found —
  this is also how you will judge whether extraction is good enough to build on.

### Step 3 — Note generation with the coverage check (4–5 days)

The thing you will actually use daily, and the point at which the app stops
being a filing cabinet.

- Generate notes block by block against the concept list.
- The coverage check of §6.2: embed each block, verify every concept is
  covered, run supplementary passes until it is, then show the badge
  ("47/47 concepts covered"). This is the feature that makes the notes
  trustworthy, so it is not optional.
- Respect `locked` and `user_written` absolutely. The mechanism exists and is
  enforced but has never been exercised against a real generator — this step is
  where that guarantee gets tested for the first time.
- Figure placement by caption similarity (§6.4), and the crossref block from
  P1-1 rendering properly.

### Step 4 — Cross-referencing (2 days)

§6.5. Match each section's concepts against the rest of the module, assign
ownership, write crossref blocks instead of duplicated prose, and add the
backlinks panel. Worth doing soon after generation, because retrofitting
de-duplication onto notes already written is harder than generating them right.

### Step 5 — The question engine — **built**

Blueprint sampling, the archetype and distractor banks, the novelty gate and
the examiner pass are all in, along with the bank and practice views. §7 was
followed closely rather than shortcut to "ask for ten questions".

What it has not had is a real model on real material, and that is the whole
question. `npm run spike` exists to answer it: offline it runs hand-written
stem pairs through the gate, and with a key it generates thirty questions on
one section, prints the survivors and leaves you to read them.

Its offline half has already paid for itself. The word-trigram check does not
do what the code claimed — it scored a one-word edit at 0.69 but a genuine
paraphrase at 0.00 and a clause-reordered duplicate at 0.13. Trigrams catch
copy-paste and nothing subtler, so the whole burden of catching paraphrase
falls on the embedding, and a run without a working embedder is close to no
gate at all. Every run now reports how many questions got through on wording
alone rather than letting that pass silently.

### Step 6 — Revision — **built**; then exams

FSRS at concept level (§8) is done: concepts scheduled rather than questions,
confidence deciding the grade, mastery rolled up the section tree with untested
concepts counted as zero, and confident-and-wrong kept as its own list because
FSRS has no grade that can express it.

Still to come: past papers driving timed exams (§9), and the concept map
(§10). Each is useful alone and neither blocks the other.

---

## 4. What still cannot be verified here

Stated plainly, because it affects how much to trust the steps above:

- **Real embedding quality.** Everything automated runs on an offline provider
  with no semantic understanding. Section mapping quality, paraphrase search and
  the 0.9 cosine threshold in §6.5 are all unvalidated against real vectors.
- **Real lecture material.** All fixtures are generated. How your actual Bath
  slide decks chunk, and whether figures come out of them cleanly, is unknown
  until you put a few through.

- **Whether the novelty gate works.** The one assumption the question engine
  rests on. Only half testable offline, and the half that ran found the trigram
  check weaker than assumed.
- **Whether the schedule is any good.** FSRS itself is well studied; what is
  not is the mapping from a confidence button to a grade, or whether asking for
  confidence every time is something you will actually keep doing.

All of these resolve the same way: ingest two or three real lectures and one
real textbook chapter, then read the Sources tab and the proposed mappings.
Half an hour of that is worth more than any amount of further work on generated
fixtures, because everything downstream inherits whatever ingestion produces —
and then `npm run spike --module <id>` with a real key, and read the questions.
