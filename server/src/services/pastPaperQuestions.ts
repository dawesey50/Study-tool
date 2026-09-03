import { eq, inArray } from 'drizzle-orm';
import { config } from '../config.js';
import { getDb, schema } from '../db/index.js';
import { indexVector } from '../db/vectorIndex.js';
import { embedSafely } from '../embeddings/index.js';
import { newId } from '../lib/ids.js';
import { fromBlob, toBlob } from '../lib/vector.js';
import { flatten, getTree } from './sections.js';

/**
 * Turning an uploaded past paper into questions.
 *
 * WHY THIS EXISTS
 *
 * The novelty gate's most important check is the one that stops a generated
 * question reproducing a real exam question — such a question teaches the
 * paper rather than the concept, and it looks like a success while doing it.
 * That check reads rows from `questions` with `source = 'past_paper'`, and
 * until this file existed nothing ever wrote one. Uploading a paper chunked it
 * and flagged concepts as examinable, which is a different job. So the gate
 * compared every generated question against an empty set and waved it through,
 * and its test passed only because the test built the row by hand.
 *
 * A guarantee that is honest in the code and false on real data is worse than
 * no guarantee, because the bank looks guarded when it is not.
 *
 * WHY IT SPLITS BEFORE IT ASKS A MODEL
 *
 * Exam papers number their questions. That is not a heuristic about language,
 * it is a typographic convention that has held for a century, and it means the
 * split can be done in code — deterministically, for nothing, offline, and
 * testably. A model is then optional: it tidies what the splitter found,
 * separating the stem from the rubric and the mark allocation. Without a key
 * the split still produces usable stems, which is the difference between the
 * gate working and not working.
 *
 * The reverse order — hand the whole paper to a model and ask for questions —
 * would be shorter to write, cost money every time, produce a different answer
 * on every run, and fail silently when the paper is long.
 */

/** Lines that start a new question. Ordered most specific first. */
const QUESTION_START = [
  /^\s*(?:Question|QUESTION)\s+(\d{1,2})\b[.):]?/,
  /^\s*Q\s?(\d{1,2})\b[.):]?/,
  /^\s*(\d{1,2})\s*[.)]\s+(?=\S)/,
];

/** Sub-parts within a question: (a), (b), a), i., ii. */
const SUBPART_START = /^\s*\(?([a-h]|[ivx]{1,4})\)\s+(?=\S)/i;

/** "[5 marks]", "(10 marks)", "(2)" at the end of a line. */
const MARKS = /[[(]\s*(\d{1,3})\s*(?:marks?|mks?)?\s*[\])]\s*$/i;

/**
 * Boilerplate that is never a question. Kept deliberately short: over-eager
 * filtering here silently loses real questions, and a stray rubric line in the
 * bank is a far cheaper mistake than a missing one.
 */
const RUBRIC = [
  /^answer\s+(all|any|both|only)\b/i,
  /^time\s+allowed\b/i,
  /^do\s+not\s+turn\s+over\b/i,
  /^this\s+(paper|examination)\b/i,
  /^university\s+of\b/i,
  /^total(\s+marks)?\s*[:=]/i,
  /^page\s+\d+\s+of\s+\d+$/i,
  /^\s*end\s+of\s+(paper|examination)\s*$/i,
];

export interface ExtractedQuestion {
  /** "3" or "3(b)", as printed on the paper. */
  number: string;
  stem: string;
  marks: number | null;
  /** Where it came from, for the citation. */
  page: number | null;
}

/**
 * Split a paper's text into questions.
 *
 * Exported on its own because it is the part worth testing hardest: everything
 * downstream inherits whatever this produces, and it is the only piece that
 * runs with no model, no key and no network.
 */
export function splitIntoQuestions(
  pages: Array<{ text: string; page: number | null }>,
): ExtractedQuestion[] {
  const questions: ExtractedQuestion[] = [];

  let current: { number: string; lines: string[]; page: number | null } | null = null;
  let parentNumber = '';

  const flush = () => {
    if (!current) return;
    const joined = current.lines.join(' ').replace(/\s+/g, ' ').trim();
    const marks = joined.match(MARKS);
    const stem = joined.replace(MARKS, '').trim();

    // A number with no words after it is a heading, not a question.
    if (stem.length >= config.pastPapers.minQuestionChars) {
      questions.push({
        number: current.number,
        stem,
        marks: marks ? Number(marks[1]) : null,
        page: current.page,
      });
    }
    current = null;
  };

  for (const { text, page } of pages) {
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (RUBRIC.some((pattern) => pattern.test(line))) continue;

      let started = false;
      for (const pattern of QUESTION_START) {
        const match = line.match(pattern);
        if (!match) continue;
        flush();
        parentNumber = match[1]!;
        current = {
          number: parentNumber,
          lines: [line.slice(match[0].length).trim()],
          page,
        };
        started = true;
        break;
      }
      if (started) continue;

      const subpart = line.match(SUBPART_START);
      if (subpart) {
        flush();
        current = {
          // A sub-part before any numbered question still deserves a label.
          number: parentNumber ? `${parentNumber}(${subpart[1]})` : `(${subpart[1]})`,
          lines: [line.slice(subpart[0].length).trim()],
          page,
        };
        continue;
      }

      // A continuation line. Text before the first question number is the
      // paper's front matter and is dropped.
      if (current) current.lines.push(line);
    }
  }
  flush();

  return questions;
}

export interface ExtractResult {
  sourceId: string;
  sourceTitle: string;
  /** How many the splitter found. */
  found: number;
  /** How many were new; re-running does not duplicate. */
  stored: number;
  skippedExisting: number;
  /** Questions matched to at least one concept. */
  mapped: number;
  /** True when concepts or embeddings were missing, so nothing was mapped. */
  unmapped: boolean;
}

export interface ExtractOptions {
  sourceId: string;
}

/**
 * Extract, embed, map to concepts and store.
 *
 * Re-running is safe and is the expected case: a paper extracted before its
 * concepts existed maps to nothing, and running it again once they do fills
 * that in without creating duplicates.
 */
export async function extractPastPaperQuestions(
  options: ExtractOptions,
): Promise<ExtractResult> {
  const db = getDb();

  const source = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.id, options.sourceId))
    .get();
  if (!source) throw new Error('Source not found');
  if (source.type !== 'past_paper') {
    throw new Error(
      `"${source.title}" is filed as ${source.type}. Only past papers hold real exam ` +
        'questions — change its type on the Sources page if that is wrong.',
    );
  }

  const chunks = db
    .select()
    .from(schema.chunks)
    .where(eq(schema.chunks.sourceId, source.id))
    .orderBy(schema.chunks.position)
    .all();

  const extracted = splitIntoQuestions(
    chunks.map((chunk) => ({ text: chunk.text, page: chunk.pageNo })),
  );

  const result: ExtractResult = {
    sourceId: source.id,
    sourceTitle: source.title,
    found: extracted.length,
    stored: 0,
    skippedExisting: 0,
    mapped: 0,
    unmapped: false,
  };
  if (extracted.length === 0) return result;

  // Already stored, by stem, so re-running is idempotent.
  const existing = new Set(
    db
      .select({ stem: schema.questions.stem })
      .from(schema.questions)
      .where(eq(schema.questions.moduleId, source.moduleId))
      .all()
      .map((row) => normalise(row.stem)),
  );

  const fresh = extracted.filter((question) => !existing.has(normalise(question.stem)));
  result.skippedExisting = extracted.length - fresh.length;
  if (fresh.length === 0) return result;

  // --- map to concepts ------------------------------------------------------
  const sections = flatten(getTree(source.moduleId));
  const concepts = sections.length
    ? db
        .select()
        .from(schema.concepts)
        .where(
          inArray(
            schema.concepts.sectionId,
            sections.map((node) => node.id),
          ),
        )
        .all()
    : [];

  const conceptVectors = concepts
    .map((concept) => ({ concept, vector: fromBlob(concept.embedding as Buffer | null) }))
    .filter(
      (entry): entry is { concept: (typeof concepts)[number]; vector: Float32Array } =>
        entry.vector !== null,
    );

  const vectors = await embedSafely(fresh.map((question) => question.stem));
  result.unmapped = conceptVectors.length === 0;

  for (const [index, question] of fresh.entries()) {
    const vector = vectors[index] ?? null;

    // Which concepts this question tests. Unlike a generated question, where
    // the concepts are chosen first and the question written to them, here it
    // is inferred — so it is a proposal, and the threshold is the same one
    // that decides examinability.
    const matched = vector
      ? conceptVectors
          .map((entry) => ({ entry, score: cosine(vector, entry.vector) }))
          .filter((hit) => hit.score >= config.pastPapers.matchThreshold)
          .sort((a, b) => b.score - a.score)
          .slice(0, 4)
      : [];

    if (matched.length > 0) result.mapped += 1;

    const id = newId();
    db.insert(schema.questions)
      .values({
        id,
        moduleId: source.moduleId,
        blueprintJson: {
          origin: 'past_paper',
          paper: source.title,
          number: question.number,
          ...(question.page !== null ? { page: question.page } : {}),
          ...(question.marks !== null ? { marks: question.marks } : {}),
        },
        conceptIds: matched.map((hit) => hit.entry.concept.id),
        sectionIds: [...new Set(matched.map((hit) => hit.entry.concept.sectionId))],
        // Real papers are written prose, not multiple choice. Calling one an
        // MCQ would put it into practice with no options to choose from.
        format: formatFor(question),
        stem: question.stem,
        optionsJson: null,
        correctAnswer: null,
        // Deliberately empty. A past paper carries no answer, and inventing
        // one would put a made-up mark scheme in front of you as if it were
        // the examiner's.
        workedAnswer: null,
        markScheme: null,
        bloomLevel: null,
        difficultyEst: null,
        embedding: vector ? toBlob(vector) : null,
        source: 'past_paper',
      })
      .run();

    if (vector) indexVector('question', id, vector);
    result.stored += 1;
  }

  return result;
}

/**
 * Papers ask for calculations and essays, never for a multiple choice this
 * system could mark. The distinction that matters downstream is only whether
 * something is short or long, since that decides how it is presented.
 */
function formatFor(question: ExtractedQuestion): schema.QuestionFormat {
  // What is being asked settles it before how many marks it carries. A
  // twelve-mark "calculate the ATP yield, showing your working" is a long
  // calculation, not an essay, and filing it as one would present it with a
  // prose box and no working space.
  if (/\bcalculate|compute|how many|what is the (rate|value|concentration)/i.test(question.stem)) {
    return 'calculation';
  }
  if (question.marks !== null && question.marks >= 10) return 'essay';
  return 'saq';
}

/** Extract every past paper in a module, for the button that does the lot. */
export async function extractAllPastPapers(moduleId: string): Promise<ExtractResult[]> {
  const db = getDb();
  const papers = db
    .select()
    .from(schema.sources)
    .where(eq(schema.sources.moduleId, moduleId))
    .all()
    .filter((source) => source.type === 'past_paper' && source.status === 'ingested');

  const results: ExtractResult[] = [];
  for (const paper of papers) {
    results.push(await extractPastPaperQuestions({ sourceId: paper.id }));
  }
  return results;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  return magnitude === 0 ? 0 : dot / magnitude;
}
