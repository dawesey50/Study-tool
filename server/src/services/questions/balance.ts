import type { McqOption } from '../../db/schema.js';

/**
 * Answer key balancing — §7.5.
 *
 * Post-processing on the assembled set, deliberately not left to the model.
 * A generator asked to vary its answer position does not, and a bank where C
 * is right two thirds of the time is one you can score above chance on without
 * knowing anything — which would make every other guarantee in the engine
 * pointless.
 *
 * Two rules: correct answers spread as evenly across the positions as the set
 * allows, and never more than two of the same letter in a row.
 */

export interface BalancedQuestion {
  id: string;
  options: McqOption[];
}

const MAX_RUN = 2;

export function balanceAnswerKeys<T extends BalancedQuestion>(
  questions: T[],
  random: () => number = Math.random,
): T[] {
  if (questions.length === 0) return questions;

  const width = Math.max(...questions.map((question) => question.options.length));
  if (width < 2) return questions;

  // How many correct answers each position should carry, as evenly as the
  // count divides.
  const quota = new Array(width).fill(0).map((_, index) => {
    const base = Math.floor(questions.length / width);
    return base + (index < questions.length % width ? 1 : 0);
  });

  const used = new Array(width).fill(0);
  const assigned: number[] = [];

  for (const question of questions) {
    const positions = question.options.map((_, index) => index);

    const allowed = positions.filter((position) => {
      if (position >= question.options.length) return false;
      if (used[position]! >= quota[position]!) return false;
      // No more than two of the same letter consecutively.
      const run = assigned.slice(-MAX_RUN);
      return !(run.length === MAX_RUN && run.every((previous) => previous === position));
    });

    // Quotas can strand a question when the last few positions are full; the
    // run rule is the one that must never break, so the quota gives way first.
    const candidates = allowed.length
      ? allowed
      : positions.filter((position) => {
          const run = assigned.slice(-MAX_RUN);
          return !(run.length === MAX_RUN && run.every((previous) => previous === position));
        });

    const target = candidates[Math.floor(random() * candidates.length)] ?? 0;
    used[target] = (used[target] ?? 0) + 1;
    assigned.push(target);

    moveCorrectTo(question.options, target);
  }

  return questions;
}

/** Swap the correct option into `target`, leaving the others in their order. */
function moveCorrectTo(options: McqOption[], target: number): void {
  const current = options.findIndex((option) => option.correct);
  if (current === -1 || current === target || target >= options.length) return;
  const [correct] = options.splice(current, 1);
  options.splice(target, 0, correct!);
}

/** How the answers actually fall, for the bank view and for tests. */
export function keyDistribution(questions: BalancedQuestion[]): number[] {
  const width = questions.length
    ? Math.max(...questions.map((question) => question.options.length))
    : 0;
  const counts = new Array(width).fill(0);
  for (const question of questions) {
    const index = question.options.findIndex((option) => option.correct);
    if (index >= 0) counts[index] += 1;
  }
  return counts;
}

/** The longest run of the same answer position, which must never exceed two. */
export function longestRun(questions: BalancedQuestion[]): number {
  let longest = 0;
  let run = 0;
  let previous = -1;
  for (const question of questions) {
    const index = question.options.findIndex((option) => option.correct);
    if (index === previous) run += 1;
    else {
      run = 1;
      previous = index;
    }
    if (run > longest) longest = run;
  }
  return longest;
}
