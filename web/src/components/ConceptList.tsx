import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Concept } from '../lib/api';
import { Icon } from './ui/Icon';
import { useConfirm } from './ui/Confirm';
import { useToast } from './ui/Toast';

/**
 * The concept list for a section.
 *
 * This is the review surface for extraction, and it exists because everything
 * downstream inherits whatever is in it: notes are generated against this
 * list, coverage is measured against it, questions are sampled from it. If it
 * is wrong and you cannot see that it is wrong, the coverage badge will read
 * 47/47 while the notes miss a third of the lecture.
 *
 * So every concept shows where it came from, and the count is checked against
 * how much material there was. Both are corrections you can make by hand.
 */

const TYPE_LABEL: Record<string, string> = {
  fact: 'Fact',
  mechanism: 'Mechanism',
  pathway: 'Pathway',
  relationship: 'Relationship',
  calculation: 'Calculation',
  clinical: 'Clinical',
  experimental: 'Experimental',
  anatomy: 'Anatomy',
};

export function ConceptList({ moduleId, sectionId }: { moduleId: string; sectionId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const { data, isLoading } = useQuery({
    queryKey: ['concepts', sectionId],
    queryFn: () => api.getConcepts(sectionId),
  });

  // Only polled while a run is in flight, so an idle section makes no requests.
  const [watching, setWatching] = useState(false);
  const { data: job } = useQuery({
    queryKey: ['concept-job', moduleId],
    queryFn: () => api.getConceptJob(moduleId),
    enabled: watching,
    refetchInterval: watching ? 900 : false,
    retry: false,
  });

  useEffect(() => {
    if (!job) return;
    if (job.running === false || ['done', 'failed', 'cancelled'].includes(job.phase)) {
      setWatching(false);
      queryClient.invalidateQueries({ queryKey: ['concepts', sectionId] });
      queryClient.invalidateQueries({ queryKey: ['llm-usage'] });
      if (job.phase === 'failed') toast.error('Extraction stopped', job.error ?? job.message);
      else if (job.phase === 'done') toast.success('Concepts extracted', job.message);
    }
  }, [job, queryClient, sectionId, toast]);

  /**
   * Past papers, not a model. Every question in one was examined by
   * definition, so this is the cheapest evidence in the system and it costs
   * nothing to run.
   */
  const examinable = useMutation({
    mutationFn: () => api.markExaminable(moduleId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['concepts'] });
      if (result.papers === 0) {
        toast.error(
          'No past papers in this module',
          'Upload one on the Sources page, filed as "Past paper", and run this again.',
        );
      } else if (result.unmeasured) {
        toast.error(
          'Could not compare against the papers',
          'The past papers or the concepts have no embeddings yet. Run Backfill missing ' +
            'embeddings in Settings first.',
        );
      } else {
        toast.success(
          result.flagged > 0
            ? `Flagged ${result.flagged} concept${result.flagged === 1 ? '' : 's'} as examinable`
            : 'Nothing new to flag',
          `Checked ${result.conceptsConsidered} concepts against ${result.passages} passages ` +
            `from ${result.papers} paper${result.papers === 1 ? '' : 's'}.`,
        );
      }
    },
    onError: (error: Error) => toast.error('Could not check the past papers', error.message),
  });

  const extract = useMutation({
    mutationFn: (fresh: boolean) =>
      api.extractConcepts(moduleId, { sectionIds: [sectionId], fresh }),
    onSuccess: () => setWatching(true),
    onError: (error: Error) => toast.error('Could not start extraction', error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteConcept(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['concepts', sectionId] }),
    onError: (error: Error) => toast.error('Could not delete that concept', error.message),
  });

  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updateConcept>[1] }) =>
      api.updateConcept(id, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['concepts', sectionId] }),
    onError: (error: Error) => toast.error('Could not save that change', error.message),
  });

  if (isLoading) return <div className="skeleton h-40" />;

  const concepts = data?.concepts ?? [];
  const running = watching && job && !['done', 'failed', 'cancelled'].includes(job.phase);

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Concepts
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            The atomic units this section will be examined on. Notes are written against this
            list and questions are sampled from it, so it is worth reading before either.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          {concepts.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => examinable.mutate()}
              disabled={examinable.isPending}
              title="Match this module's past papers against the concepts and flag what has come up"
            >
              <Icon name="file" size={13} />
              {examinable.isPending ? 'Checking…' : 'Check past papers'}
            </button>
          )}
          {concepts.length > 0 && (
            <button
              className="btn btn-sm"
              onClick={() => extract.mutate(true)}
              disabled={Boolean(running) || extract.isPending}
              title="Ignore the cached answer and pay for a fresh extraction"
            >
              <Icon name="refresh" size={13} />
              Re-extract
            </button>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={() => extract.mutate(false)}
            disabled={Boolean(running) || extract.isPending}
          >
            <Icon name="sparkle" size={13} />
            {running ? 'Working…' : concepts.length ? 'Extract again' : 'Extract concepts'}
          </button>
        </div>
      </div>

      {running && (
        <div className="mt-3 rounded-xl border border-line bg-panel px-3 py-2">
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="truncate text-muted">{job?.message}</span>
            <button className="text-xs text-muted hover:text-ink" onClick={() => api.cancelExtraction(moduleId)}>
              Cancel
            </button>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-accent" />
          </div>
        </div>
      )}

      {data?.plausibility && (
        <p className="mt-3 rounded-xl border border-flag/30 bg-flag-soft px-3 py-2 text-xs leading-relaxed text-flag">
          {data.plausibility.message}
        </p>
      )}

      {concepts.length === 0 && !running && (
        <div className="card mt-4 px-6 py-10 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Icon name="sparkle" size={20} />
          </span>
          <h3 className="mt-3 font-medium">Nothing extracted yet</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
            {data?.sourceChunks
              ? `${data.sourceChunks} chunks of material are mapped to this section. Extracting reads them and writes down every specific claim that could be examined.`
              : 'No sources are mapped to this section yet. Upload the material and map it first — there is nothing here to extract from.'}
          </p>
        </div>
      )}

      {concepts.length > 0 && (
        <>
          <div className="mt-4 flex items-baseline gap-3 text-xs text-muted">
            <span>
              <strong className="text-ink">{concepts.length}</strong> concepts
            </span>
            <span>
              {concepts.filter((concept) => concept.examinableFlag).length} flagged examinable
            </span>
            {concepts.some((concept) => concept.ownedElsewhere) && (
              <span>
                {concepts.filter((concept) => concept.ownedElsewhere).length} also taught
                elsewhere
              </span>
            )}
          </div>

          <ul className="mt-2 space-y-2">
            {concepts.map((concept) => (
              <ConceptRow
                key={concept.id}
                concept={concept}
                moduleId={moduleId}
                onToggleExaminable={() =>
                  update.mutate({
                    id: concept.id,
                    body: { examinableFlag: !concept.examinableFlag },
                  })
                }
                onEdit={(statement) => update.mutate({ id: concept.id, body: { statement } })}
                onDelete={async () => {
                  const confirmed = await confirm({
                    title: 'Delete this concept?',
                    message:
                      'Anything generated from it later — notes, questions — will not include ' +
                      'it. Extracting again would bring it back.',
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  });
                  if (confirmed) remove.mutate(concept.id);
                }}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ConceptRow({
  concept,
  moduleId,
  onToggleExaminable,
  onEdit,
  onDelete,
}: {
  concept: Concept;
  moduleId: string;
  onToggleExaminable: () => void;
  onEdit: (statement: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(concept.statement);

  return (
    <li className="card p-3">
      {editing ? (
        <div>
          <textarea
            className="input min-h-[4.5rem] resize-none text-sm leading-relaxed"
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <button
              className="btn btn-sm"
              onClick={() => {
                setDraft(concept.statement);
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary btn-sm"
              disabled={!draft.trim() || draft === concept.statement}
              onClick={() => {
                onEdit(draft.trim());
                setEditing(false);
              }}
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed">{concept.statement}</p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs">
        <span className="chip bg-line/60 text-muted">
          {TYPE_LABEL[concept.type] ?? concept.type}
        </span>

        <button
          onClick={onToggleExaminable}
          className={`chip transition ${
            concept.examinableFlag
              ? 'bg-accent-soft text-accent'
              : 'bg-line/40 text-faint hover:text-muted'
          }`}
          title={
            concept.examinableFlag
              ? 'Flagged as examinable — click to unflag'
              : 'Not flagged as examinable — click to flag'
          }
        >
          <Icon name="check" size={10} />
          examinable
        </button>

        {concept.emphasisScore !== null && concept.emphasisScore >= 0.7 && (
          <span className="chip bg-line/40 text-muted" title="The material dwelt on this">
            emphasised
          </span>
        )}

        {/* A citation is the difference between a claim from your lecture and
            one the model knew already. Showing it makes that checkable. */}
        {concept.citations.map((citation) => (
          <span key={citation} className="font-mono text-faint">
            {citation}
          </span>
        ))}

        {concept.citations.length === 0 && (
          <span className="text-flag">no citation — cannot be traced to your material</span>
        )}

        <span className="ml-auto flex items-center gap-1">
          <button
            className="btn-icon h-6 w-6"
            onClick={() => setEditing((value) => !value)}
            aria-label="Edit this concept"
            title="Edit"
          >
            <Icon name="edit" size={12} />
          </button>
          <button
            className="btn-icon h-6 w-6"
            onClick={onDelete}
            aria-label="Delete this concept"
            title="Delete"
          >
            <Icon name="trash" size={12} />
          </button>
        </span>
      </div>

      {concept.examinableEvidence?.length ? (
        <details className="mt-2">
          <summary className="cursor-pointer text-2xs text-muted">
            Examined before · {concept.examinableEvidence.length} match
            {concept.examinableEvidence.length === 1 ? '' : 'es'} in past papers
          </summary>
          <ul className="mt-1 space-y-1">
            {concept.examinableEvidence.map((entry) => (
              <li
                key={entry.chunkId}
                className="rounded-lg border border-line px-2 py-1 text-2xs leading-relaxed text-muted"
              >
                <span className="font-mono text-faint">{entry.location}</span> — {entry.excerpt}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {concept.ownedElsewhere && (
        <p className="mt-2 rounded-lg border border-accent/25 bg-accent-soft/40 px-2 py-1 text-2xs leading-relaxed">
          Also taught in{' '}
          <Link
            className="font-medium text-accent hover:underline"
            to={`/modules/${moduleId}/sections/${concept.ownedElsewhere.sectionId}`}
          >
            {concept.ownedElsewhere.sectionNumber} {concept.ownedElsewhere.sectionTitle}
          </Link>
          , which owns it. Notes here will point there rather than repeat it.
        </p>
      )}
    </li>
  );
}
