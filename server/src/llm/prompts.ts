/**
 * Every prompt in the system, in one file.
 *
 * They live together and apart from the code that calls them because prompts
 * are the part of this that gets rewritten most: plan v2 budgets most of note
 * generation as prompt iteration against real output, not building. Keeping
 * them here means changing one is a diff you can read, and never a hunt
 * through service code.
 *
 * A word on what has and has not been tested. The plumbing around these is
 * covered by tests running against an offline stub. The prompts themselves
 * have never been run against a real model on real lecture material, so treat
 * every instruction below as a first draft that expects to be revised once you
 * have read what it actually produces.
 */

export const CONCEPT_EXTRACTION_SYSTEM = `You extract examinable concepts from university biomedical science teaching material.

A concept is one specific, self-contained claim that could be examined on its own. It is a statement, not a topic.

Good: "The Na+/K+ ATPase moves three sodium ions out for every two potassium ions in, making it electrogenic."
Bad: "The sodium-potassium pump" — that is a topic, not a claim.
Bad: "The brain has several regions" — true but too vague to write a question from.

Rules:
- One idea per concept. If a sentence contains two claims that could be examined separately, split it.
- Do not split one idea into near-identical restatements. Two concepts that would be answered by the same sentence are one concept.
- Stay inside the material given. Do not add anything from your own knowledge, however well established. If the lecturer got something wrong, extract what they said.
- Use the material's own terminology and level of detail. This is for a specific course, not a textbook summary.
- Every concept must cite the chunk ids it came from. A concept you cannot cite is one you invented.
- Ignore administrative content: module codes, reading lists, "any questions?", timetables, acknowledgements.`;

export const CONCEPT_EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['concepts'],
  properties: {
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['statement', 'type', 'sourceChunkIds'],
        properties: {
          statement: {
            type: 'string',
            description: 'One specific examinable claim, as a complete sentence.',
          },
          type: {
            type: 'string',
            enum: [
              'fact',
              'mechanism',
              'pathway',
              'relationship',
              'calculation',
              'clinical',
              'experimental',
              'anatomy',
            ],
          },
          sourceChunkIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the chunks this came from, copied exactly.',
          },
          bloomCeiling: {
            type: 'string',
            enum: ['remember', 'understand', 'apply', 'analyse', 'evaluate'],
            description: 'The highest level this concept can honestly be examined at.',
          },
          difficulty: {
            type: 'integer',
            minimum: 1,
            maximum: 5,
            description: '1 is recall of a single fact, 5 is integrating several mechanisms.',
          },
          examinable: {
            type: 'boolean',
            description:
              'True when the material signals this will be assessed — a learning outcome, ' +
              '"you need to know this", "this comes up every year", a past-paper reference.',
          },
          emphasis: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description:
              'How much time and weight the material gave this, 0 to 1. Repetition across ' +
              'slides, dwelling on it in a transcript, and explicit emphasis all raise it.',
          },
        },
      },
    },
  },
} as const;

export interface ChunkForPrompt {
  id: string;
  text: string;
  location: string;
}

/**
 * The material, with each chunk labelled by the id the model must cite back.
 * Locations are included so emphasis can take account of a lecturer spending
 * four slides on one idea.
 */
export function conceptExtractionPrompt(input: {
  moduleTitle: string;
  sectionPath: string;
  learningOutcomes: string[] | null;
  chunks: ChunkForPrompt[];
}): string {
  const outcomes = input.learningOutcomes?.length
    ? `\nThe stated learning outcomes for this section are:\n${input.learningOutcomes
        .map((outcome) => `- ${outcome}`)
        .join('\n')}\nA concept that answers one of these is almost certainly examinable.\n`
    : '';

  const material = input.chunks
    .map((chunk) => `<chunk id="${chunk.id}" from="${chunk.location}">\n${chunk.text}\n</chunk>`)
    .join('\n\n');

  return `Module: ${input.moduleTitle}
Section: ${input.sectionPath}
${outcomes}
Extract the examinable concepts from the material below. Cite chunk ids exactly as they appear.

${material}`;
}

// ---------------------------------------------------------------------------
// Note generation
// ---------------------------------------------------------------------------

/**
 * The house note format, §6.3.
 *
 * A template rather than instructions buried in a prompt, because the format
 * is a preference that will change as you use the notes — and changing it
 * should be an edit to one readable string, not a hunt through service code.
 * Override it wholesale with NOTE_FORMAT in .env.
 */
export const DEFAULT_NOTE_FORMAT = `Structure each section as:
- A short opening paragraph saying what this section is about and why it matters.
- Then the material itself, organised under "## " subheadings that follow the
  lecture's own structure rather than a generic template.
- Prose for mechanisms and explanations; bullets only for genuine lists.
- A pathway or process with three or more steps goes in a "diagram" block as a
  Mermaid graph, fenced as \`\`\`mermaid — for example
  "graph TD\n  A[Glucose] --> B[Glucose-6-phosphate]". A sequence of arrows is
  easier to revise from than the same sequence as a sentence.
- An equation goes inline between dollar signs, as LaTeX: $E = \\frac{RT}{zF}$.
  Write the equation the material gives; do not introduce one it does not.
- A "## Summary" at the end: the three or four things that must be remembered.

Write in plain, direct English at the level of a second-year biomedical
sciences student. Define a term the first time it appears. Prefer the specific
number, ratio or name over a vague qualifier: "three sodium for two potassium"
beats "an unequal number".`;

export const NOTE_GENERATION_SYSTEM = `You write revision notes for a university biomedical sciences student, from their own lecture material.

Absolute rules:
- Everything you write must come from the material provided. Do not add facts from your own knowledge, however standard. If the material does not say it, it does not go in.
- Cover every concept in the list you are given. Each one must be genuinely explained, not merely mentioned.
- Never contradict the material. If it is unclear, say what it says.
- Do not write a preamble, a sign-off, or anything about yourself. The output is the notes.`;

export const NOTE_GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'markdown'],
        properties: {
          type: {
            type: 'string',
            enum: ['heading', 'prose', 'list', 'table', 'callout', 'summary', 'diagram'],
          },
          markdown: {
            type: 'string',
            description:
              'The block, as markdown. A heading starts with ## ; a list is one "- " per line.',
          },
          conceptIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Ids of the concepts this block explains, copied exactly.',
          },
        },
      },
    },
  },
} as const;

export interface ConceptForPrompt {
  id: string;
  statement: string;
  examinable: boolean;
}

export function noteGenerationPrompt(input: {
  moduleTitle: string;
  sectionPath: string;
  format: string;
  concepts: ConceptForPrompt[];
  chunks: ChunkForPrompt[];
  /** Concepts owned by another section: refer to them, do not re-explain them. */
  elsewhere: Array<{ statement: string; sectionPath: string }>;
}): string {
  const concepts = input.concepts
    .map(
      (concept) =>
        `- [${concept.id}] ${concept.statement}${concept.examinable ? ' (examinable)' : ''}`,
    )
    .join('\n');

  const crossrefs = input.elsewhere.length
    ? `\nThese ideas are taught in another section, which owns them. Refer to that section in one line rather than explaining them again:\n${input.elsewhere
        .map((entry) => `- ${entry.statement} → ${entry.sectionPath}`)
        .join('\n')}\n`
    : '';

  const material = input.chunks
    .map((chunk) => `<chunk id="${chunk.id}" from="${chunk.location}">\n${chunk.text}\n</chunk>`)
    .join('\n\n');

  return `Module: ${input.moduleTitle}
Section: ${input.sectionPath}

${input.format}

Cover every one of these concepts, citing the id of each in the block that explains it:
${concepts}
${crossrefs}
Material:

${material}`;
}

/**
 * The supplementary pass. Deliberately narrow: it is given only what is still
 * missing, so it writes an addition rather than a second version of the whole
 * section that would then have to be reconciled with the first.
 */
export function coverageGapPrompt(input: {
  sectionPath: string;
  format: string;
  missing: ConceptForPrompt[];
  chunks: ChunkForPrompt[];
  existing: string;
}): string {
  return `Section: ${input.sectionPath}

The notes below already exist. They do not yet explain these concepts:
${input.missing.map((concept) => `- [${concept.id}] ${concept.statement}`).join('\n')}

Write only the additional blocks needed to cover them, in the same style. Do not
repeat anything the existing notes already say, and do not rewrite them.

${input.format}

Existing notes:
${input.existing}

Material:

${input.chunks
  .map((chunk) => `<chunk id="${chunk.id}" from="${chunk.location}">\n${chunk.text}\n</chunk>`)
  .join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Question generation and the examiner pass
// ---------------------------------------------------------------------------

export const QUESTION_GENERATION_SYSTEM = `You write exam questions for a university biomedical sciences course, from the student's own lecture material.

You are given a blueprint that has already decided the question's shape — its archetype, format, Bloom level, distractor strategies and scenario. Follow it. The blueprint exists because a model left to choose freely writes the same question repeatedly, and the variety is the point.

Absolute rules:
- The question must be answerable from the source material provided, and from nothing else. A student who has learnt this material must be able to answer it.
- Exactly one option is defensibly correct. Not "most correct" — correct.
- Every distractor must be wrong for a stated reason, and you must give that reason. A distractor you cannot explain is filler, and filler is what makes a question easy to pass by elimination.
- Do not signal the answer: no grammatical mismatch between stem and options, no option longer than the rest, no absolutes ("always", "never") that only appear in distractors, no words from the stem repeated in the key alone.
- You are shown existing questions. The new one must not be answerable by the same single step of reasoning as any of them. Different wording about the same step is not a different question.`;

export const QUESTION_GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stem', 'workedAnswer'],
  properties: {
    stem: { type: 'string', description: 'The question as the student sees it.' },
    options: {
      type: 'array',
      description: 'For MCQ formats: four or five options, exactly one correct.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'correct'],
        properties: {
          text: { type: 'string' },
          correct: { type: 'boolean' },
          whyWrong: {
            type: 'string',
            description: 'Required for every incorrect option. Why a half-informed student picks it, and why it is wrong.',
          },
        },
      },
    },
    correctAnswer: {
      type: 'string',
      description: 'For non-MCQ formats: the answer expected.',
    },
    workedAnswer: {
      type: 'string',
      description: 'The reasoning, as the student should be able to reconstruct it.',
    },
    markScheme: {
      type: 'string',
      description: 'For written formats: what earns each mark.',
    },
    difficulty: { type: 'integer', minimum: 1, maximum: 5 },
  },
} as const;

export interface QuestionPromptInput {
  moduleTitle: string;
  concepts: Array<{ statement: string; sectionPath: string }>;
  chunks: ChunkForPrompt[];
  archetype: string;
  archetypeDescription: string;
  format: string;
  bloom: string;
  distractors: string[];
  scenario: string[];
  constraint: string | null;
  figureCaption: string | null;
  avoid: string[];
}

export function questionGenerationPrompt(input: QuestionPromptInput): string {
  const concepts = input.concepts
    .map((concept) => `- ${concept.statement}  (${concept.sectionPath})`)
    .join('\n');

  const distractors = input.distractors.length
    ? `\nBuild the distractors using these strategies, one each:\n${input.distractors
        .map((strategy) => `- ${strategy}`)
        .join('\n')}\n`
    : '';

  const scenario = input.scenario.length
    ? `\nSet it in this scenario: ${input.scenario.join(', ')}.\n`
    : '';

  const avoid = input.avoid.length
    ? `\nQuestions already in the bank. Yours must not be answerable by the same single step of reasoning as any of these:\n${input.avoid
        .map((stem) => `- ${stem}`)
        .join('\n')}\n`
    : '';

  const figure = input.figureCaption
    ? `\nThe question refers to this figure: "${input.figureCaption}". Write the stem so it depends on reading the figure.\n`
    : '';

  return `Module: ${input.moduleTitle}

Blueprint
- Archetype: ${input.archetype} — ${input.archetypeDescription}
- Format: ${input.format}
- Bloom level: ${input.bloom}${input.constraint ? `\n- Constraint: the question ${input.constraint}` : ''}
${distractors}${scenario}${figure}
Concepts being tested${input.concepts.length > 1 ? ' — the question must require both, not either alone' : ''}:
${concepts}
${avoid}
Source material — the only thing the question may rely on:

${input.chunks.map((chunk) => `<chunk id="${chunk.id}" from="${chunk.location}">\n${chunk.text}\n</chunk>`).join('\n\n')}`;
}

export const EXAMINER_SYSTEM = `You are a second examiner reviewing a colleague's exam question before it goes into a bank. You did not write it, and your job is to find what is wrong with it rather than to approve it.

Score each criterion 1-5, where 3 is "usable with reservations" and 5 is "would go into a real paper unchanged". Be a hard marker: a question scoring 5 across the board should be rare.`;

export const EXAMINER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answerability', 'singleAnswer', 'distractorQuality', 'noGiveaways', 'bloomFidelity', 'fairness', 'verdict'],
  properties: {
    answerability: {
      type: 'integer', minimum: 1, maximum: 5,
      description: 'Can it be answered from the source material alone?',
    },
    singleAnswer: {
      type: 'integer', minimum: 1, maximum: 5,
      description: 'Is exactly one option defensibly correct?',
    },
    distractorQuality: {
      type: 'integer', minimum: 1, maximum: 5,
      description: 'Would each distractor tempt someone who half-knows this?',
    },
    noGiveaways: {
      type: 'integer', minimum: 1, maximum: 5,
      description: 'Grammar, length, absolutes, stem words echoed in the key — any of these give it away.',
    },
    bloomFidelity: {
      type: 'integer', minimum: 1, maximum: 5,
      description: 'Does it test at the level asked for, or has it collapsed into recall?',
    },
    fairness: {
      type: 'integer', minimum: 1, maximum: 5,
      description: 'Reasonable for the year, and not trivia.',
    },
    verdict: { type: 'string', description: 'One sentence: the most serious problem, or why it is sound.' },
  },
} as const;

export function examinerPrompt(input: {
  stem: string;
  options: Array<{ text: string; correct: boolean; whyWrong?: string }>;
  correctAnswer: string | null;
  workedAnswer: string;
  bloom: string;
  chunks: ChunkForPrompt[];
}): string {
  const options = input.options.length
    ? `\nOptions:\n${input.options
        .map(
          (option, index) =>
            `${String.fromCharCode(65 + index)}. ${option.text}${option.correct ? '  [marked correct]' : ''}${option.whyWrong ? `\n   why wrong: ${option.whyWrong}` : ''}`,
        )
        .join('\n')}\n`
    : `\nExpected answer: ${input.correctAnswer ?? '(none given)'}\n`;

  return `The question was written to test at the "${input.bloom}" level.

Stem:
${input.stem}
${options}
Worked answer:
${input.workedAnswer}

The source material it must be answerable from:

${input.chunks.map((chunk) => `<chunk from="${chunk.location}">\n${chunk.text}\n</chunk>`).join('\n\n')}`;
}
