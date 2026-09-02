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
