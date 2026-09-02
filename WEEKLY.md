# Using this each week

Plan v2's Step 6 asks for a one-page note on how the weekly loop actually goes,
and for that loop to be fast enough that using it is easier than not. Here is
the loop; the timings are what to measure, not what has been measured.

**The test that matters:** if a lecture takes more than about ten minutes of
your attention to get from "slides downloaded" to "notes I trust", find the
friction and remove it. An app that is 80% built when term starts, does not fit
into the week, and quietly stops being opened is the failure nobody plans for.

---

## Once, at the start of a module

1. **Make the module** and paste your handbook outline into the hierarchy.
   Sections are places in the syllabus, not lectures — one lecture usually
   spans several. Getting this roughly right matters more than getting it
   perfect; you can drag sections around later without breaking anything.
2. **Drop in the past papers** you have, filed as *Past paper*. Then open any
   section's **Concepts** tab and press **Check past papers** once concepts
   exist. Every question in a paper was examined by definition, so this is the
   cheapest signal in the system and it costs nothing to run.
3. **Set your spending cap** in Settings → Models and spend, and press **Test
   connection** so you find out a key is wrong now rather than mid-lecture.

## Every week, per lecture

1. **Drop the slides and the transcript in** on the Sources page. Several files
   at once; it ingests in the background while you do something else.
2. **Check the mapping.** The proposals are a guess made from embeddings, and
   this is the step everything downstream inherits. Dashed means proposed, solid
   means you confirmed it. *Do not skip this* — a lecture mapped to the wrong
   section produces concepts from the wrong material, notes covering the wrong
   things, and a coverage badge that reads full while being confidently wrong.
3. **Extract concepts** on each section the lecture touched, and **read the
   list**. This is the review step that decides whether everything after it is
   worth having. Look for statements too vague to write a question from — "the
   brain has several regions" — because those mean the extraction prompt needs
   fixing, and fixing it now is far cheaper than after notes and questions have
   both inherited the mush.
4. **Generate the notes**, then read the coverage badge. It tells you the notes
   cover the concept list; it cannot tell you the concept list covers the
   lecture. If something is uncovered it is named — write those bits yourself.
5. **Write your own bits.** Anything you write, and anything you lock, survives
   every future generation run untouched. Lock the paragraphs you care about.

## When something looks wrong

- **Notes missing something obvious?** The concept list is the place to look,
  not the notes. Add the concept by hand and generate again.
- **Concept list too short or too long?** There is a warning when the count is
  wildly out of line with the material, but it only fires on extremes. Trust
  your reading of it over the warning.
- **A generation run made things worse?** Module page → **Restore points**. One
  is saved automatically before every run, and restoring is itself undoable.
- **Spend climbing faster than expected?** Settings → Models and spend shows it
  per module against the cap, and what the cache has saved.

## What to do before term, once

Plan v2's Step 1, still the highest-value half day in the plan:

- Put three real lectures, a textbook chapter and a transcript through.
- Check chunk sizes and mappings by eye.
- Search for a paraphrase — "sodium pump" should reach "Na⁺/K⁺ ATPase".
- Open the figures strip: did diagrams come out as diagrams, or did a
  flat-image deck give you one full-page "figure" per slide?
- Then tune `CHUNK_MATCH_THRESHOLD` and `SECTION_SHARE_THRESHOLD` in
  `server/src/services/mapping.ts`, and the thresholds in `.env`, against what
  you actually saw.

Every threshold in this system is currently a reasoned guess that has never met
a real embedding or a real lecture. That half day is what turns them into
numbers.
