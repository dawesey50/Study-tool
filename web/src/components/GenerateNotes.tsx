import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Coverage } from '../lib/api';
import { Icon } from './ui/Icon';
import { useConfirm } from './ui/Confirm';
import { useToast } from './ui/Toast';

/**
 * Generate notes, and the coverage badge.
 *
 * The badge is the feature that makes generated notes trustworthy, so it is
 * built to be honest rather than reassuring. It says what it actually
 * verified — that each concept in the list is explained somewhere in the notes
 * — and not what it cannot: that the concept list covers the lecture. Those
 * are different claims and only one of them is being checked, so only one is
 * claimed.
 *
 * When a concept is not covered it is named. A badge reading 44/47 with the
 * three missing spelled out is worth more than one reading 47/47 because the
 * loop was allowed to keep trying until it did.
 */
export function GenerateNotes({ sectionId }: { sectionId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [open, setOpen] = useState(false);

  const { data: concepts } = useQuery({
    queryKey: ['concepts', sectionId],
    queryFn: () => api.getConcepts(sectionId),
  });

  const { data: notes } = useQuery({
    queryKey: ['notes', sectionId],
    queryFn: () => api.getNotes(sectionId),
  });

  const generate = useMutation({
    mutationFn: (fresh: boolean) => api.generateNotes(sectionId, { fresh }),
    onSuccess: (result) => {
      setCoverage(result.coverage);
      queryClient.invalidateQueries({ queryKey: ['notes', sectionId] });
      queryClient.invalidateQueries({ queryKey: ['snapshots'] });
      queryClient.invalidateQueries({ queryKey: ['llm-usage'] });
      toast.success(
        `Wrote ${result.blocksWritten} blocks`,
        result.blocksPreserved > 0
          ? `${result.blocksPreserved} of your own blocks were left untouched.`
          : 'A restore point was saved first.',
      );
    },
    onError: (error: Error) => toast.error('Could not generate notes', error.message),
  });

  const conceptCount = concepts?.concepts.length ?? 0;
  const yours = notes?.filter((block) => block.origin !== 'ai_generated').length ?? 0;
  const generated = notes?.filter((block) => block.origin === 'ai_generated').length ?? 0;

  const run = async (fresh: boolean) => {
    if (generated > 0) {
      const confirmed = await confirm({
        title: 'Generate these notes again?',
        message:
          `The ${generated} generated block${generated === 1 ? '' : 's'} here will be replaced.` +
          (yours > 0
            ? ` The ${yours} you wrote yourself will not be touched.`
            : '') +
          ' A restore point is saved first either way.',
        confirmLabel: 'Generate',
      });
      if (!confirmed) return;
    }
    generate.mutate(fresh);
  };

  if (conceptCount === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2">
      <button
        className="btn btn-sm btn-primary"
        onClick={() => run(false)}
        disabled={generate.isPending}
      >
        <Icon name="sparkle" size={13} />
        {generate.isPending
          ? 'Writing…'
          : generated > 0
            ? 'Generate again'
            : `Generate from ${conceptCount} concepts`}
      </button>

      {coverage && <CoverageBadge coverage={coverage} onOpen={() => setOpen((v) => !v)} />}

      {yours > 0 && (
        <span className="text-2xs text-muted">
          {yours} block{yours === 1 ? '' : 's'} of yours will be left alone
        </span>
      )}

      {coverage && open && coverage.uncovered.length > 0 && (
        <ul className="mt-1 w-full space-y-1 border-t border-line pt-2">
          {coverage.uncovered.map((entry) => (
            <li key={entry.conceptId} className="flex gap-2 text-2xs leading-relaxed text-muted">
              <Icon name="alert" size={11} className="mt-0.5 shrink-0 text-flag" />
              <span>
                {entry.statement}
                {entry.examinable && <span className="ml-1 text-flag">· examinable</span>}
              </span>
            </li>
          ))}
          <li className="pt-1 text-2xs leading-relaxed text-faint">
            {coverage.hitPassLimit
              ? 'Generation used all its supplementary passes without closing this gap. Write ' +
                'these yourself, or reword the concept and generate again.'
              : coverage.stoppedEarly
                ? 'A supplementary pass stopped making progress, so generation stopped rather ' +
                  'than pay to retry the same gap. Write these yourself, or reword the concept.'
                : 'Write these yourself, or generate again.'}
          </li>
        </ul>
      )}
    </div>
  );
}

function CoverageBadge({ coverage, onOpen }: { coverage: Coverage; onOpen: () => void }) {
  if (!coverage.measured) {
    return (
      <span
        className="chip bg-line/60 text-muted"
        title="Coverage could not be measured because embeddings were unavailable. It is not a claim that nothing is covered."
      >
        <Icon name="alert" size={11} />
        coverage not measured
      </span>
    );
  }

  const full = coverage.uncovered.length === 0;
  return (
    <button
      onClick={onOpen}
      className={`chip transition ${full ? 'bg-accent-soft text-accent' : 'bg-flag-soft text-flag'}`}
      title={
        `Each of the ${coverage.total} concepts extracted for this section was checked against ` +
        'what the notes actually say. This verifies that the notes cover the concept list — ' +
        'not that the concept list covers the lecture. If extraction missed something, this ' +
        'badge cannot know.'
      }
    >
      <Icon name={full ? 'check' : 'alert'} size={11} />
      {coverage.covered}/{coverage.total} concepts covered
    </button>
  );
}
