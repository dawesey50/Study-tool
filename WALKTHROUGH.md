# Testing it on your own material

The automated tests prove the plumbing. They say nothing about whether any of
this is any good, because every one of them runs against a stub model and an
offline embedder with no semantic understanding. This is the walkthrough that
answers the other question.

**Budget about two hours**, split across two sittings. Roughly £1–3 of API
credit for the whole thing.

Each stage below has a **stop-and-look**. If a stage fails, stop there — every
later stage inherits it, and running on will only tell you that something
upstream was wrong in six different ways.

At the end, `npm run report` writes a file that describes everything that
happened. Send it to me and I can see what you saw.

---

## Before you start

```bash
npm install
npm run check          # types + 228 tests, all offline, ~30s
```

If that fails, stop — something is wrong with the checkout, not with your
material.

Then put a key in `.env` at the repo root:

```
ANTHROPIC_API_KEY=sk-ant-...
EMBEDDINGS_PROVIDER=local
```

`EMBEDDINGS_PROVIDER=local` matters as much as the key. On `hash` — the default
in tests — the embedder returns vectors with no meaning in them, and section
mapping, the coverage check, concept dedupe and half the novelty gate all
silently become nonsense. The first run downloads a ~90 MB model.

Start it:

```bash
npm run app            # or: npm run dev
```

**Stop and look.** The bottom-left of the sidebar should say `local`, not
`hash`, and not show an embeddings warning. If it says the embedder is
unavailable, that is a network problem and nothing below will mean anything.

---

## Stage 1 — Ingestion (20 min)

Make a module. Upload **three real lectures and one past paper** — enough that
mapping has something to be wrong about, few enough that you can read all of it.

File the past paper as **Past paper** in the type dropdown. That is not
cosmetic: it is what decides whether the questions in it guard the novelty gate
later.

**Stop and look — Sources page:**

- Did every file finish ingesting, or did one fail?
- Does each lecture show a sensible chunk count? A 30-slide deck should give
  tens of chunks, not two and not four hundred.
- If a file says it looks scanned, it is — a PDF with no text layer yields
  nothing, and there is no fixing it downstream.
- Look at the figures strip. Did diagrams come out as diagrams? A deck exported
  as one flat image per page gives you one full-page "figure" per slide instead,
  which you will recognise instantly.

**What wrong looks like:** zero chunks from a file that ingested "successfully",
or chunk counts wildly different between two similar decks.

---

## Stage 2 — The hierarchy (10 min)

On the module page, press **Propose from material**.

This reads the titles and opening slides of what you uploaded and suggests a
structure. It costs one cheap call. Nothing changes until you accept.

**Stop and look:**

- Does the proposed structure resemble how the unit is actually taught?
- Are sections the size of a topic you would revise in one sitting — not one per
  lecture, not one for the whole module?
- Before accepting: does it warn you about anything it would delete? On a fresh
  module it should have nothing to warn about.

Accept it, or edit it, or paste your handbook outline instead. Any of the three
is fine — what matters is that you have a tree before the next stage.

---

## Stage 3 — Mapping (15 min) — **the most important stage**

Go back to Sources. Each source now shows which sections it was matched to,
with a score.

Everything downstream inherits this. A lecture mapped to the wrong section means
its concepts, its notes and its questions all end up in the wrong place, and
nothing later will tell you that is what happened.

**Stop and look:**

- For each lecture, is the top-scoring section the right one?
- Are the scores clustered around one value, or spread out? Clustered means the
  threshold is not discriminating.
- Confirm the mappings you agree with. A confirmed mapping is used verbatim
  downstream; a proposal is only a guess.

**What wrong looks like:** a lecture mapped to five sections at once, or to
none. Both mean `CHUNK_MATCH_THRESHOLD` (currently 0.25, in
`server/src/services/mapping.ts`) is wrong for your material — too low and
everything matches everything, too high and nothing matches.

**Write down what you see here even if it looks fine.** This threshold has never
been tested against a real embedding, and your numbers are the first evidence
anyone will have.

---

## Stage 4 — Concepts (20 min) — **the second most important**

Pick **one section you know well**. Open its Concepts tab and press Extract.

Then read every concept it produced. Not skim — read.

**Stop and look:**

- Is each one *atomic and specific*? "The Na+/K+ ATPase exports three sodium
  ions for every two potassium imported" is a concept. "The brain has several
  regions" is not — you cannot write a question from it.
- Does the count feel right for the material? Roughly one per 900 characters is
  what the plausibility check assumes, and that assumption is a guess.
- Click through to the citations. Does each concept actually come from where it
  says it does?
- Is anything missing that you would expect to be examined on?

**What wrong looks like:** vague statements, or concepts that cite nothing, or a
list of 40 for a lecture with 12 ideas in it.

**If this stage is bad, stop.** The prompt in `server/src/llm/prompts.ts` needs
fixing here, where it is cheap — not after notes and questions have both
inherited it. Send me the report and I will look at the prompt.

---

## Stage 5 — Notes (15 min)

Same section, Notes tab, press Generate.

**Stop and look:**

- Would you revise from this?
- Does the coverage badge agree with what you can see? If it says 12/12 covered
  and two concepts are obviously missing, the coverage threshold is too
  generous.
- Are citations attached and do they go somewhere real?
- Now write a paragraph of your own, lock it, and regenerate. **Your paragraph
  must still be there, unchanged.** This is the promise the whole system rests
  on and this is the first time it meets a real generator.

Then try the block actions: put the cursor in a generated paragraph and press
"Explain further". It should show you a proposal beside the original and change
nothing until you accept.

---

## Stage 6 — Past-paper questions (10 min)

Open any section's **Exam questions** tab and press **Extract from papers**.

This needs no model and costs nothing — it splits the paper on its question
numbering.

**Stop and look:**

- Did it find roughly the right number of questions?
- Are they actually questions, rather than rubric ("Answer ALL questions") or
  page furniture?
- Did it get the mark allocations?

**What wrong looks like:** zero found. Your paper either numbers its questions
in a way the splitter does not recognise, or is a scan with no text. Send me the
report — the patterns it matches on are in
`server/src/services/pastPaperQuestions.ts` and are easy to extend once I can
see the shape of a real paper.

---

## Stage 7 — The novelty spike (20 min) — **the one that matters most**

This is the question the whole project rests on.

```bash
npm run spike -- --module <module-id> -n 30
```

The module id is in the URL when you have the module open.

It generates 30 questions with the gates on and the examiner off, prints every
survivor, and stops. It costs perhaps 50p.

**Then read them as a set** and answer one question:

> Are these thirty different questions, or five questions wearing hats?

That is a judgement only you can make and it decides what happens next.

- **Genuinely varied** → the design works. Move on.
- **Repetitive despite passing the gate** → the problem is in blueprint
  sampling, not the gate, and raising the thresholds would only shrink the bank
  without fixing it.
- **Very few survived** → the gate is too strict for your material. The run
  reports why each one was rejected.

Also check the output for `admittedWithoutEmbeddings`. If it is above zero, the
embedder was not working and the gate was barely running.

---

## Stage 8 — Practice and the schedule (15 min)

Generate a proper batch from the question bank — say 15, with the examiner on
this time. Then go to Practice and actually answer them.

**Stop and look:**

- Are the questions answerable from the notes you have?
- Do the distractors make you think, or are three of them obviously silly?
- Does anything reference a figure you cannot see? (It should not — but this is
  the first time that path runs on real material.)
- Answer one deliberately wrong while marking yourself Certain. It should call
  that out immediately, and the concept should appear under "confidently wrong"
  on the Revision page.

Then check the Revision page: does the mastery figure look honest given how
little you have answered? It counts untested concepts as zero on purpose, so
after 15 questions on a 200-concept module it should read very low.

---

## Stage 9 — A mock exam (15 min)

Build a paper. 10 questions, 20 minutes, two fifths real questions.

**Stop and look:**

- Does it mix real past-paper questions with generated ones, and label which is
  which?
- Can you see any answers before submitting? (Open devtools if you like — they
  are not there.)
- Submit it. Is the score honest about what it could not mark?

---

## Finally — send me the report

```bash
npm run report
```

Writes `data/report-<date>.md`. Options:

| | |
|---|---|
| `npm run report` | counts, warnings, short excerpts |
| `npm run report -- --full` | longer excerpts, best for judging the writing |
| `npm run report -- --quiet` | counts and warnings only, no material at all |

**Read it before you send it.** It contains excerpts of your own coursework —
concepts, notes, questions. It never contains your API key. If you would rather
not share the material, `--quiet` gives me the shape without the substance,
which is still enough to spot most problems.

What I can tell from it: whether each stage produced anything, whether the
thresholds are in the right region, whether the question bank has real variety
or has collapsed to three archetypes, whether the answer keys are skewed,
whether the examiner is actually marking or rubber-stamping, and what everything
cost.

What I cannot tell from it, and need you to say in your own words:

1. **Were the concepts right?** (Stage 4)
2. **Were the thirty questions genuinely different?** (Stage 7)
3. **Would you revise from the notes?** (Stage 5)

Those three are the whole project. Everything else is plumbing, and the
plumbing is tested.
