# Testing Processor on your own material

A checklist. Tick as you go.

**Time:** about 2 hours, best split across two sittings.
**Cost:** £1–3 of API credit for the whole thing.
**You need:** 3 real lectures + 1 past paper, and an Anthropic API key.

Your lectures can be **PowerPoint (.pptx)** — that works, including speaker
notes. Also accepted: `.pdf`, `.docx`, `.txt`, `.md`, `.vtt`, `.srt`.

> If your lectures are the old `.ppt` format, open one in PowerPoint and
> *Save As → .pptx*. The old binary format cannot be read by anything.

**The rule:** if a stage fails, **stop there**. Everything after it inherits
the problem, and carrying on just shows you the same fault six more times.

At the end you run one command that writes a file describing everything that
happened. Send me that file.

---

## Setup

- [ ] **1.** Open a terminal in the project folder.

- [ ] **2.** Run:
      ```bash
      npm install
      npm run check
      ```
      Should end with all tests passing (~30s). If not, stop — that's the
      checkout, not your material.

- [ ] **3.** Create a file called `.env` in the project folder containing:
      ```
      ANTHROPIC_API_KEY=sk-ant-your-key-here
      EMBEDDINGS_PROVIDER=local
      ```
      > `EMBEDDINGS_PROVIDER=local` matters as much as the key. Without it the
      > system uses a fake embedder with no understanding of meaning, and half
      > of what you're testing becomes noise while still *looking* like it works.

- [ ] **4.** Start it:
      ```bash
      npm run app
      ```
      First run downloads a ~90 MB model. Be patient.

- [ ] **5.** **CHECK:** bottom-left of the sidebar says `local`, not `hash`,
      with no embeddings warning.
      - ❌ If it says the embedder is unavailable → network problem. Stop.

---

## Stage 1 — Ingestion (20 min)

- [ ] **6.** Create a module (+ in the sidebar). Name it after the unit.

- [ ] **7.** Go to Sources. Upload **3 lectures**, type = *Slides*.

- [ ] **8.** Upload **1 past paper**, type = **Past paper**.
      > Not cosmetic. That dropdown decides whether the questions in it later
      > stop the generator writing copies of real exam questions.

- [ ] **9.** **CHECK** each file on the Sources page:
      - Did it finish, or fail?
      - Sensible chunk count? A 30-slide deck → tens of chunks, not 2, not 400.
      - Any warning about speaker notes? That's good — notes are usually the
        only full sentences in a deck.
      - Look at the figures strip. Did diagrams come out as diagrams?

      **What wrong looks like:**
      - ❌ "Almost no selectable text" → the deck is pictures of slides. Nothing
        downstream can read it.
      - ❌ Zero chunks from a file that ingested "successfully".
      - ❌ Wildly different chunk counts between two similar decks.

---

## Stage 2 — The hierarchy (10 min)

- [ ] **10.** On the module page, press **Propose from material**.
      One cheap model call. Nothing changes until you accept.

- [ ] **11.** **CHECK** the proposal:
      - Does it resemble how the unit is actually taught?
      - Are sections the size of a topic you'd revise in one sitting? (Not one
        per lecture; not one for the whole module.)

- [ ] **12.** Accept it — or edit it, or paste your handbook outline instead.
      Any of the three is fine. You just need a tree before Stage 3.

---

## Stage 3 — Mapping (15 min) ⚠️ **MOST IMPORTANT**

Everything downstream inherits this. A lecture filed under the wrong section
sends its concepts, notes and questions to the wrong place, and nothing later
will tell you that's what happened.

- [ ] **13.** Go back to Sources. Each source now shows matched sections
      with a score.

- [ ] **14.** **CHECK** for each lecture:
      - Is the top-scoring section the right one?
      - Are scores spread out, or all clustered at one value?

- [ ] **15.** Confirm the mappings you agree with. A confirmed mapping is used
      as-is downstream; an unconfirmed one is only a guess.

- [ ] **16.** **Write down the scores you saw** even if they look fine. This
      threshold has never been tested against a real embedding — your numbers
      are the first evidence anyone has.

      **What wrong looks like:**
      - ❌ One lecture mapped to five sections at once → threshold too low.
      - ❌ A lecture mapped to nothing → threshold too high.
      - Either way, tell me. The dial is `CHUNK_MATCH_THRESHOLD` (currently
        0.25) in `server/src/services/mapping.ts`.

---

## Stage 4 — Concepts (20 min) ⚠️ **SECOND MOST IMPORTANT**

- [ ] **17.** Pick **one section you know well**. Open its **Concepts** tab.
      Press **Extract**.

- [ ] **18.** **Read every concept it produced.** Not skim — read.

- [ ] **19.** **CHECK:**
      - Is each one **atomic and specific**?
        - ✅ "The Na+/K+ ATPase exports three sodium ions for every two
          potassium imported"
        - ❌ "The brain has several regions" — you can't write a question from
          that
      - Does the count feel right for the material?
      - Click through the citations. Does each concept come from where it says?
      - Is anything obviously missing that you'd be examined on?

      **If this stage is bad, STOP.** The prompt needs fixing here, where it's
      cheap — not after notes and questions have both inherited it. Run the
      report (step 33) and send it.

---

## Stage 5 — Notes (15 min)

- [ ] **20.** Same section, **Notes** tab, press **Generate**.

- [ ] **21.** **CHECK:**
      - Would you actually revise from this?
      - Does the coverage badge match what you can see? If it claims 12/12 and
        two concepts are plainly missing, the threshold is too generous.
      - Are citations attached, and do they go somewhere real?

- [ ] **22.** **The important one:** write a paragraph of your own. Lock it
      (button at the bottom of the editor). Regenerate the section.
      - ✅ Your paragraph must still be there, **unchanged**.
      - ❌ If it isn't, stop and tell me immediately. That's the promise the
        whole system rests on and this is the first time it's met a real
        generator.

- [ ] **23.** Put the cursor in a generated paragraph. Press **Explain further**.
      It should show a proposal *beside* the original and change nothing until
      you press Use this.

---

## Stage 6 — Past-paper questions (10 min)

- [ ] **24.** Open any section's **Exam questions** tab. Press
      **Extract from papers**. Free — no model involved.

- [ ] **25.** **CHECK:**
      - Roughly the right number of questions found?
      - Are they actually questions, not rubric ("Answer ALL questions") or
        page numbers?
      - Did it pick up the mark allocations?

      - ❌ **Zero found?** Your paper numbers its questions in a way the
        splitter doesn't recognise. Send me the report — the patterns are easy
        to extend once I can see the shape of a real paper.

---

## Stage 7 — The novelty spike (20 min) ⚠️ **THE ONE THAT MATTERS**

This is the question the whole project rests on.

- [ ] **26.** Copy the module id from the URL (the long code after
      `/modules/`).

- [ ] **27.** In a second terminal:
      ```bash
      npm run spike -- --module PASTE_ID_HERE -n 30
      ```
      Costs roughly 50p. Generates 30 questions with the gates on and the
      examiner off, then prints them.

- [ ] **28.** **Read all thirty as a set** and answer one question:

      > **Are these thirty different questions, or five questions wearing hats?**

      - ✅ Genuinely varied → the design works.
      - ❌ Repetitive despite passing the gate → the problem is in blueprint
        sampling, not the gate. Raising thresholds would only shrink the bank.
      - ❌ Very few survived → the gate is too strict for your material. The
        output says why each was rejected.

- [ ] **29.** **CHECK** the output for `no embedding` / `admittedWithoutEmbeddings`.
      Above zero means the embedder wasn't working and the gate barely ran.

---

## Stage 8 — Practice and revision (15 min)

- [ ] **30.** Question bank → generate **15** questions (examiner on this time).
      Then go to **Practise** and actually answer them.

      Keyboard: `a`–`d` choose, `1`–`5` how sure, `Enter` answers then moves on.

- [ ] **31.** **CHECK:**
      - Are the questions answerable from the notes you have?
      - Do the distractors make you think, or are three obviously silly?
      - Does anything mention a figure you can't see? (It shouldn't.)
      - Answer one **deliberately wrong** while marking yourself **Certain**.
        It should call that out, and the concept should appear under
        "confidently wrong" on the Revision page.

- [ ] **32.** Open **Revise**. Does the mastery figure look honest? After 15
      questions on a 200-concept module it should read *very low* — it counts
      untested concepts as zero on purpose.

---

## Stage 9 — A mock exam (15 min)

- [ ] **33.** **Mocks** → 10 questions, 20 minutes, "two fifths" real questions.
      Build it.

- [ ] **34.** **CHECK:**
      - Does it mix real past-paper questions with generated ones, labelled?
      - Can you see any answers before submitting? (There shouldn't be any in
        the page at all.)
      - Submit. Is the score honest about what it *couldn't* mark?

---

## Finally — send me the report

- [ ] **35.** Stop the app (Ctrl-C), then run:
      ```bash
      npm run report
      ```

      | Command | What it includes |
      |---|---|
      | `npm run report` | counts, warnings, short excerpts |
      | `npm run report -- --full` | longer excerpts — best for judging writing |
      | `npm run report -- --quiet` | counts and warnings only, **no material** |

- [ ] **36.** It writes `data/report-YYYY-MM-DD.md`. **Read it before sending.**
      It contains excerpts of your own coursework. It never contains your API
      key. If you'd rather not share the material, `--quiet` still gives me
      enough to spot most problems.

- [ ] **37.** Send me the file, plus **answers to these three** — the report
      can't tell me any of them:

      1. **Were the concepts right?** (Stage 4)
      2. **Were the thirty questions genuinely different?** (Stage 7)
      3. **Would you revise from the notes?** (Stage 5)

Those three are the whole project. Everything else is plumbing, and the
plumbing is tested.

---

## If something breaks

| Symptom | Likely cause |
|---|---|
| Sidebar says `hash` | `EMBEDDINGS_PROVIDER=local` missing from `.env` |
| "Embeddings unavailable" | Model download blocked — check the network |
| Upload rejected | `.ppt` not `.pptx`; save-as in PowerPoint |
| "Almost no selectable text" | Deck is images of slides, not text |
| Nothing happens on Generate | No API key, or a spending cap hit — check Settings |
| Everything is very slow | First run downloads the embedding model, once |

Run `npm run doctor` for a check of the setup itself, and `npm run report`
whenever you want to know what state things are in.
