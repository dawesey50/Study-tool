# Processor — spec audit and development plan

Audited 15 August 2026 against `studytoolspec.md` (spec v2).

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
| §3 Frontend stack | **Mostly** | React/TS/Vite/Tailwind/TanStack/TipTap all in use. **KaTeX and Mermaid are installed but never imported** — equations and pathway diagrams do not render |
| §3 Backend stack | **Done** | Fastify, better-sqlite3, Drizzle, sqlite-vec, local media |
| §3 Ingestion libraries | **Mostly** | pdfjs, mammoth, transformers.js in use. `pdf-to-img` never added, so there are no page thumbnails |
| §3 LLM routing (`llm.complete`) | **Not started** | No provider layer exists at all. Everything in §6–§9 depends on this |
| §4 Section hierarchy, drag-and-drop, stable UUIDs | **Done** | Numbers derived from position; verified that reordering renumbers without breaking links |
| §4 Hierarchy by hand / grow as you go | **Done** | Paste an outline, or add sections individually |
| §4 Hierarchy *proposed* by an LLM | **Not started** | Spec calls this "the default flow" |
| §4 Four tabs per section | **Half** | Notes and Sources work; Exam questions and Practice are honest placeholders |
| §5 Data model | **Done** | All 15 tables exist, including those nothing writes to yet |
| §6.1 Note generation pipeline | **Not started** | |
| §6.2 Coverage check and badge | **Not started** | Only referenced in comments |
| §6.3 Note format config template | **Not started** | |
| §6.4 Figure placement by similarity | **Not started** | Figures are extracted and listed, never placed |
| §6.5 Cross-referencing instead of repeating | **Not started** | `crossref` block type exists but renders as plain prose |
| §6.6 Editing and edit preservation | **Done** | Blocks carry origin and a lock; locked blocks reject edits |
| §6.6 Section action toolbar | **Not started** | No "explain further", "rewrite", "go deeper" |
| §7 Question engine | **Not started** | Tables exist; nothing populates them |
| §8 FSRS revision | **Not started** | `ts-fsrs` not installed |
| §9 Exam mode | **Not started** | |
| §10 Sidebar tree, global search | **Done** | Keyword and semantic search, merged |
| §10 Dashboard, concept map, command palette | **Not started** | Some shortcuts exist (⌘K, ⌘,, ⌘B) but no palette |
| §12 Cost estimate | **Not tracked** | Nothing measures spend against the ~£7/module budget |
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

### P0-4 — Dead dependencies, missing rendering

KaTeX and Mermaid are in `web/package.json` and imported nowhere. So the spec's
"pathway and process diagrams as Mermaid" and equation rendering do not exist,
while the download cost does. Either wire them up or remove them; shipping both
the weight and the absence is the worst of both.

### P1-1 — Block types that degrade to plain text

`crossref`, `figure` and `table` are in the type union and the database, but the
editor has no node for them, so they fall through to prose. §6.5's cross-
reference block — the thing that stops notes repeating themselves — has nowhere
to render. This needs solving *before* generation writes those blocks, not
after.

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

### Step 5 — The question engine (5–7 days)

The spec's stated differentiator, and the largest single piece: blueprint
sampling, the archetype and distractor banks, the novelty gate, and the examiner
pass. §7 is specific enough to implement closely — the value is in following it
rather than shortcutting to "ask for ten questions".

Realistically this lands during term, not before it.

### Step 6 — Revision, then exams (during term)

FSRS at concept level (§8), then past papers and timed exams (§9), then the
dashboard and concept map (§10). Each is useful alone and none blocks the
others.

---

## 4. What still cannot be verified here

Stated plainly, because it affects how much to trust the steps above:

- **Real embedding quality.** Everything automated runs on an offline provider
  with no semantic understanding. Section mapping quality, paraphrase search and
  the 0.9 cosine threshold in §6.5 are all unvalidated against real vectors.
- **Real lecture material.** All fixtures are generated. How your actual Bath
  slide decks chunk, and whether figures come out of them cleanly, is unknown
  until you put a few through.

Both resolve the same way: ingest two or three real lectures and one real
textbook chapter, then read the Sources tab and the proposed mappings. Half an
hour of that before Step 2 is worth more than any amount of further work on
generated fixtures, because Steps 2–5 all inherit whatever ingestion produces.
