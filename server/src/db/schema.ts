/**
 * The whole data model lives here. Phase 1 only reads and writes a subset of
 * these tables, but the schema is defined up front so later phases are additive
 * migrations rather than reshapes.
 *
 * Two conventions run through all of it:
 *   - Identity is a UUID, never a display number. Section "1.2.1" is computed
 *     from tree position at read time, so reordering never breaks a link.
 *   - Anything derived from a source keeps a pointer back to the exact chunk it
 *     came from. That is what makes "explained on slide 14" work.
 */
import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  blob,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const now = sql`(unixepoch())`;

/** Serialised as a JSON string in SQLite; typed as T at the ORM boundary. */
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>();

// ---------------------------------------------------------------------------
// Modules and the section hierarchy
// ---------------------------------------------------------------------------

export const modules = sqliteTable('modules', {
  id: text('id').primaryKey(),
  code: text('code'),
  title: text('title').notNull(),
  year: integer('year'),
  notes: text('notes'),
  createdAt: integer('created_at').notNull().default(now),
});

export type SectionStatus = 'empty' | 'drafted' | 'edited' | 'complete';

export const sections = sqliteTable(
  'sections',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    /** Null for a top-level section. Deleting a parent removes its subtree. */
    parentId: text('parent_id').references((): AnySQLiteColumn => sections.id, {
      onDelete: 'cascade',
    }),
    title: text('title').notNull(),
    /** Sibling ordering. The displayed number (1.2.1) is derived from this. */
    position: integer('position').notNull().default(0),
    learningOutcomes: json<string[]>('learning_outcomes'),
    status: text('status').$type<SectionStatus>().notNull().default('empty'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [
    index('sections_module_idx').on(t.moduleId),
    index('sections_parent_idx').on(t.parentId, t.position),
  ],
);

// ---------------------------------------------------------------------------
// Sources, chunks and figures
// ---------------------------------------------------------------------------

export type SourceType = 'slides' | 'transcript' | 'textbook' | 'notes' | 'past_paper';
export type SourceStatus = 'uploaded' | 'ingesting' | 'ingested' | 'failed';

/**
 * Sources belong to the module, not to a section, because one lecture normally
 * spills across several sections. The join is source_sections.
 */
export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    type: text('type').$type<SourceType>().notNull(),
    title: text('title').notNull(),
    filename: text('filename').notNull(),
    /** Path to the stored original, relative to DATA_DIR. */
    path: text('path').notNull(),
    lectureDate: text('lecture_date'),
    ingestedAt: integer('ingested_at'),
    status: text('status').$type<SourceStatus>().notNull().default('uploaded'),
    /** Populated when status is 'failed'. */
    error: text('error'),
    pageCount: integer('page_count'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('sources_module_idx').on(t.moduleId)],
);

/**
 * Many-to-many. `confirmed` distinguishes a mapping you accepted from one the
 * embedding match merely proposed.
 */
export const sourceSections = sqliteTable(
  'source_sections',
  {
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    /** Which chunks of the source belong to this section. */
    chunkRange: json<{ chunkIds: string[] }>('chunk_range'),
    score: real('score'),
    confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.sourceId, t.sectionId] }),
    index('source_sections_section_idx').on(t.sectionId),
  ],
);

export const chunks = sqliteTable(
  'chunks',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    embedding: blob('embedding'),
    /** Provenance. Whichever of these the source type provides is populated. */
    pageNo: integer('page_no'),
    slideNo: integer('slide_no'),
    /** Transcript position in seconds, when the transcript carried timestamps. */
    timestamp: real('timestamp'),
    position: integer('position').notNull(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('chunks_source_idx').on(t.sourceId, t.position)],
);

export type FigureType = 'diagram' | 'graph' | 'micrograph' | 'table' | 'structure' | 'photo';

export const figures = sqliteTable(
  'figures',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    /** Path to the extracted image, relative to DATA_DIR. */
    path: text('path').notNull(),
    pageNo: integer('page_no'),
    width: integer('width'),
    height: integer('height'),
    /** Caption text found next to the image in the document. */
    captionExtracted: text('caption_extracted'),
    /** Vision-model description. Phase 2. */
    captionAi: text('caption_ai'),
    altText: text('alt_text'),
    embedding: blob('embedding'),
    type: text('type').$type<FigureType>(),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('figures_source_idx').on(t.sourceId, t.pageNo)],
);

// ---------------------------------------------------------------------------
// Concepts — the atomic examinable units (Phase 2)
// ---------------------------------------------------------------------------

export type ConceptType =
  | 'fact'
  | 'mechanism'
  | 'pathway'
  | 'relationship'
  | 'calculation'
  | 'clinical'
  | 'experimental'
  | 'anatomy';

export const concepts = sqliteTable(
  'concepts',
  {
    id: text('id').primaryKey(),
    /** The section that OWNS this concept. Cross-references point back here. */
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    statement: text('statement').notNull(),
    type: text('type').$type<ConceptType>().notNull(),
    bloomCeiling: text('bloom_ceiling'),
    difficulty: integer('difficulty'),
    examinableFlag: integer('examinable_flag', { mode: 'boolean' }).notNull().default(false),
    emphasisScore: real('emphasis_score'),
    sourceChunkIds: json<string[]>('source_chunk_ids'),
    prerequisiteIds: json<string[]>('prerequisite_ids'),
    embedding: blob('embedding'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('concepts_section_idx').on(t.sectionId)],
);

export type ConceptLinkType = 'duplicate' | 'prerequisite' | 'extends' | 'contrasts' | 'applies';

export const conceptLinks = sqliteTable(
  'concept_links',
  {
    fromConceptId: text('from_concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    toConceptId: text('to_concept_id')
      .notNull()
      .references(() => concepts.id, { onDelete: 'cascade' }),
    type: text('type').$type<ConceptLinkType>().notNull(),
    note: text('note'),
  },
  (t) => [
    primaryKey({ columns: [t.fromConceptId, t.toConceptId, t.type] }),
    index('concept_links_to_idx').on(t.toConceptId),
  ],
);

// ---------------------------------------------------------------------------
// Notes — stored as blocks, rendered as one document
// ---------------------------------------------------------------------------

export type NoteBlockType =
  | 'heading'
  | 'prose'
  | 'list'
  | 'table'
  | 'diagram'
  | 'figure'
  | 'callout'
  | 'summary'
  | 'crossref';

export type NoteBlockOrigin = 'ai_generated' | 'user_written' | 'user_edited';

export const noteBlocks = sqliteTable(
  'note_blocks',
  {
    id: text('id').primaryKey(),
    sectionId: text('section_id')
      .notNull()
      .references(() => sections.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    type: text('type').$type<NoteBlockType>().notNull(),
    markdown: text('markdown').notNull().default(''),
    /** Set for type 'figure'. */
    figureId: text('figure_id'),
    /** Set for type 'crossref' — the section that owns the referenced material. */
    targetSectionId: text('target_section_id'),
    conceptIds: json<string[]>('concept_ids'),
    /** Chunk ids backing this block, so every claim stays traceable. */
    sourceRefs: json<string[]>('source_refs'),
    origin: text('origin').$type<NoteBlockOrigin>().notNull().default('user_written'),
    /** When true, regeneration never touches this block. */
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    embedding: blob('embedding'),
    generatedAt: integer('generated_at'),
    updatedAt: integer('updated_at').notNull().default(now),
  },
  (t) => [index('note_blocks_section_idx').on(t.sectionId, t.position)],
);

// ---------------------------------------------------------------------------
// Questions and attempts (Phase 3-4)
// ---------------------------------------------------------------------------

export type QuestionFormat = 'mcq' | 'saq' | 'essay' | 'data_interp' | 'calculation' | 'ema';

export interface McqOption {
  text: string;
  correct: boolean;
  /** If the model cannot say why a distractor is wrong, it is filler. */
  whyWrong?: string;
}

export const questions = sqliteTable(
  'questions',
  {
    id: text('id').primaryKey(),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    /** The exact blueprint tuple used to generate this. */
    blueprintJson: json<Record<string, unknown>>('blueprint_json'),
    conceptIds: json<string[]>('concept_ids'),
    sectionIds: json<string[]>('section_ids'),
    format: text('format').$type<QuestionFormat>().notNull(),
    stem: text('stem').notNull(),
    optionsJson: json<McqOption[]>('options_json'),
    correctAnswer: text('correct_answer'),
    workedAnswer: text('worked_answer'),
    markScheme: text('mark_scheme'),
    figureId: text('figure_id'),
    bloomLevel: text('bloom_level'),
    difficultyEst: real('difficulty_est'),
    /** Of the stem, for the novelty gate. */
    embedding: blob('embedding'),
    source: text('source').$type<'generated' | 'past_paper'>().notNull().default('generated'),
    timesServed: integer('times_served').notNull().default(0),
    timesCorrect: integer('times_correct').notNull().default(0),
    criticScore: real('critic_score'),
    createdAt: integer('created_at').notNull().default(now),
  },
  (t) => [index('questions_module_idx').on(t.moduleId)],
);

export const attempts = sqliteTable(
  'attempts',
  {
    id: text('id').primaryKey(),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id, { onDelete: 'cascade' }),
    answerGiven: text('answer_given'),
    correct: integer('correct', { mode: 'boolean' }),
    /** Confident-and-wrong is the most important signal in the system. */
    confidenceRating: integer('confidence_rating'),
    secondsTaken: real('seconds_taken'),
    attemptedAt: integer('attempted_at').notNull().default(now),
  },
  (t) => [index('attempts_question_idx').on(t.questionId)],
);

/** FSRS state, scheduled per concept rather than per question. */
export const conceptSchedule = sqliteTable('concept_schedule', {
  conceptId: text('concept_id')
    .primaryKey()
    .references(() => concepts.id, { onDelete: 'cascade' }),
  stability: real('stability'),
  difficulty: real('difficulty'),
  dueDate: integer('due_date'),
  reps: integer('reps').notNull().default(0),
  lapses: integer('lapses').notNull().default(0),
  lastReview: integer('last_review'),
});

export const exams = sqliteTable('exams', {
  id: text('id').primaryKey(),
  moduleId: text('module_id')
    .notNull()
    .references(() => modules.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  blueprintJson: json<Record<string, unknown>>('blueprint_json'),
  questionIds: json<string[]>('question_ids'),
  startedAt: integer('started_at'),
  submittedAt: integer('submitted_at'),
  score: real('score'),
});

/** Randomisation parameters drawn on when sampling a question blueprint. */
export const scenarioSeeds = sqliteTable('scenario_seeds', {
  id: text('id').primaryKey(),
  category: text('category').notNull(),
  value: text('value').notNull(),
  compatibleWith: json<string[]>('compatible_with'),
});

// ---------------------------------------------------------------------------
// Vector index bookkeeping
// ---------------------------------------------------------------------------

/**
 * sqlite-vec addresses rows by integer rowid, but everything else here is keyed
 * by UUID. This table is the mapping between the two, and its autoincrementing
 * primary key is the rowid used in the vec0 shadow tables.
 */
export const vecMap = sqliteTable(
  'vec_map',
  {
    rowid: integer('rowid').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<'chunk' | 'figure' | 'concept' | 'note_block' | 'question'>().notNull(),
    entityId: text('entity_id').notNull(),
  },
  (t) => [uniqueIndex('vec_map_entity_idx').on(t.kind, t.entityId)],
);
