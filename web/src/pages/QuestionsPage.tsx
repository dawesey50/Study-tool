import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, flattenSections, type Question } from '../lib/api';
import { Icon } from '../components/ui/Icon';
import { useConfirm } from '../components/ui/Confirm';
import { useToast } from '../components/ui/Toast';

/**
 * The question bank.
 *
 * This is the review surface for the question engine, and the thing it has to
 * show is not any individual question — those always look fine — but the
 * properties of the set. Whether the answers fall evenly across the positions,
 * whether the same letter runs, how many blueprints were thrown away to get
 * here, and what the gate rejected. A bank where C is right two thirds of the
 * time is one you can score above chance on without knowing anything, and no
 * amount of reading questions one at a time would reveal that.
 *
 * Every question shows its blueprint for the same reason: when a run produces
 * fifty questions that all feel the same, the blueprint is where you find out
 * why.
 */
export function QuestionsPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [count, setCount] = useState(10);
  const [sectionId, setSectionId] = useState('');
  const [watching, setWatching] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showRejections, setShowRejections] = useState(false);

  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });

  const { data: bank, isLoading } = useQuery({
    queryKey: ['questions', moduleId, sectionId],
    queryFn: () => api.listQuestions(moduleId!, sectionId ? { sectionId } : {}),
    enabled: Boolean(moduleId),
  });

  // Polled only while a run is in flight, so an idle bank makes no requests.
  const { data: job } = useQuery({
    queryKey: ['question-job', moduleId],
    queryFn: () => api.getQuestionJob(moduleId!),
    enabled: watching,
    refetchInterval: watching ? 900 : false,
    retry: false,
  });

  useEffect(() => {
    if (!job) return;
    if (['done', 'failed', 'cancelled'].includes(job.phase)) {
      setWatching(false);
      queryClient.invalidateQueries({ queryKey: ['questions', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['llm-usage'] });
      if (job.phase === 'failed') toast.error('Generation stopped', job.error ?? job.message);
      else if (job.phase === 'done') toast.success('Questions generated', job.message);
    }
  }, [job, moduleId, queryClient, toast]);

  const generate = useMutation({
    mutationFn: () =>
      api.generateQuestions(moduleId!, {
        count,
        ...(sectionId ? { sectionIds: [sectionId] } : {}),
      }),
    onSuccess: () => setWatching(true),
    onError: (error: Error) => toast.error('Could not start generating', error.message),
  });

  const cancel = useMutation({
    mutationFn: () => api.cancelQuestions(moduleId!),
    onError: (error: Error) => toast.error('Could not cancel', error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteQuestion(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['questions', moduleId] }),
    onError: (error: Error) => toast.error('Could not delete that question', error.message),
  });

  const sections = module ? flattenSections(module.sections) : [];
  const questions = bank?.questions ?? [];
  const keys = bank?.answerKeys;
  const running = watching && job && !['done', 'failed', 'cancelled'].includes(job.phase);

  return (
    <div className="mx-auto max-w-4xl p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Link className="text-xs text-muted hover:text-fg" to={`/modules/${moduleId}`}>
            {module?.title ?? 'Module'}
          </Link>
          <h1 className="text-lg font-semibold">Question bank</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            Questions are built from a blueprint sampled before the model sees anything — the
            archetype, format, Bloom level and scenario are decided in code, so the variety is
            structural rather than hoped for. Each one is then checked against everything
            already here and scored by a second model.
          </p>
        </div>
        <Link className="btn btn-primary shrink-0" to={`/modules/${moduleId}/practice`}>
          <Icon name="question" className="mr-1 h-4 w-4" />
          Practice
        </Link>
      </div>

      {/* --- generate --------------------------------------------------- */}
      <div className="card mt-5 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted">
            How many
            <input
              className="input mt-1 block w-20"
              type="number"
              min={1}
              max={100}
              value={count}
              onChange={(event) => setCount(Number(event.target.value) || 1)}
              disabled={Boolean(running)}
            />
          </label>
          <label className="min-w-48 flex-1 text-xs text-muted">
            From
            <select
              className="input mt-1 block w-full"
              value={sectionId}
              onChange={(event) => setSectionId(event.target.value)}
              disabled={Boolean(running)}
            >
              <option value="">The whole module</option>
              {sections.map((node) => (
                <option key={node.id} value={node.id}>
                  {node.number} {node.title}
                </option>
              ))}
            </select>
          </label>
          {running ? (
            <button className="btn" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
              Cancel
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => generate.mutate()}
              disabled={generate.isPending}
            >
              <Icon name="sparkle" className="mr-1 h-4 w-4" />
              Generate
            </button>
          )}
        </div>

        {running && job && (
          <div className="mt-3">
            <div className="flex items-center justify-between text-xs text-muted">
              <span className="truncate pr-4">{job.message}</span>
              <span className="shrink-0">
                {job.done}/{job.total}
              </span>
            </div>
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-line">
              <div
                className="h-full bg-accent transition-[width] duration-300"
                style={{ width: `${job.total ? (job.done / job.total) * 100 : 0}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              Each question is generated, checked against the bank and scored by a second model,
              so this is slower than it looks like it should be. Rejected attempts cost too.
            </p>
          </div>
        )}

        {!running && job?.result && (
          <div className="mt-3 space-y-2 text-xs">
            {job.result.stoppedBecause === 'ran_out_of_blueprints' && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
                Gave up after {job.result.blueprintsResampled} blueprints with{' '}
                {job.result.accepted} of {job.result.requested} accepted. This material may not
                hold that many genuinely different questions — asking again will produce the same
                result. More concepts, or more sections in scope, is the fix.
              </p>
            )}
            {job.result.admittedWithoutEmbeddings > 0 && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5">
                {job.result.admittedWithoutEmbeddings} question
                {job.result.admittedWithoutEmbeddings === 1 ? '' : 's'} passed on wording alone,
                because the embedder was unavailable. That check only catches near-copies, so
                read these before trusting them — and run Backfill missing embeddings in
                Settings.
              </p>
            )}
            {job.result.rejected.length > 0 && (
              <button
                className="text-muted underline underline-offset-2 hover:text-fg"
                onClick={() => setShowRejections((previous) => !previous)}
              >
                {job.result.rejected.length} attempt
                {job.result.rejected.length === 1 ? '' : 's'} rejected
                {showRejections ? ' — hide' : ' — show why'}
              </button>
            )}
            {showRejections && (
              <ul className="space-y-1.5 border-l-2 border-line pl-3">
                {job.result.rejected.map((rejection, index) => (
                  <li key={index} className="text-muted">
                    <span className="font-medium text-fg">
                      {rejection.reason.replace(/_/g, ' ')}
                    </span>
                    {rejection.stem ? ` — "${rejection.stem}"` : ''}
                    {rejection.detail ? <span className="block pl-2">{rejection.detail}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            {job.costGbp !== undefined && (
              <p className="text-muted">This run cost £{job.costGbp.toFixed(3)}.</p>
            )}
          </div>
        )}
      </div>

      {/* --- the set-level view ---------------------------------------- */}
      {keys && keys.counted > 1 && (
        <div className="card mt-4 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-muted">
            How the answers fall
          </p>
          <p className="mt-1 text-xs text-muted">
            Across {keys.counted} multiple-choice questions. If one position carries far more
            than its share, the bank is scoreable without knowing the material — which is the
            thing this whole engine exists to avoid.
          </p>
          <div className="mt-3 flex items-end gap-2">
            {keys.distribution.map((tally, position) => {
              const share = keys.counted ? tally / keys.counted : 0;
              const even = 1 / Math.max(1, keys.distribution.length);
              const skewed = Math.abs(share - even) > 0.15;
              return (
                <div key={position} className="flex-1 text-center">
                  <div
                    className={`mx-auto w-full rounded-t ${skewed ? 'bg-amber-500' : 'bg-accent'}`}
                    style={{ height: `${Math.max(4, share * 80)}px` }}
                    title={`${tally} of ${keys.counted}`}
                  />
                  <span className="mt-1 block font-mono text-[11px] text-muted">
                    {String.fromCharCode(65 + position)}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-muted">
            Longest run of the same letter: {keys.longestRun}
            {keys.longestRun > 2 ? ' — above the limit of two.' : '.'}
          </p>
        </div>
      )}

      {/* --- the questions --------------------------------------------- */}
      <div className="mt-5">
        {isLoading ? (
          <div className="skeleton h-40" />
        ) : questions.length === 0 ? (
          <div className="card p-6 text-center text-sm text-muted">
            Nothing here yet. Questions are sampled from the concept list, so extract concepts
            for a section first, then generate.
          </div>
        ) : (
          <ul className="space-y-2">
            {questions.map((question) => (
              <QuestionRow
                key={question.id}
                question={question}
                expanded={expanded === question.id}
                onToggle={() =>
                  setExpanded((previous) => (previous === question.id ? null : question.id))
                }
                onDelete={async () => {
                  const confirmed = await confirm({
                    title: 'Delete this question?',
                    message: 'Its attempt history goes with it.',
                    confirmLabel: 'Delete',
                    tone: 'danger',
                  });
                  if (confirmed) remove.mutate(question.id);
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function QuestionRow({
  question,
  expanded,
  onToggle,
  onDelete,
}: {
  question: Question;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const blueprint = (question.blueprintJson ?? {}) as {
    archetype?: string;
    scenario?: string[];
    constraint?: string | null;
    distractors?: string[];
  };

  return (
    <li className="card overflow-hidden">
      <div className="flex items-start gap-3 p-3">
        <button className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <p className="text-sm leading-relaxed">{question.stem}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
            <span className="rounded bg-line px-1.5 py-0.5 uppercase tracking-wide">
              {question.format}
            </span>
            {blueprint.archetype && <span>{blueprint.archetype.replace(/_/g, ' ')}</span>}
            {question.bloomLevel && <span>· {question.bloomLevel}</span>}
            {question.sectionPaths.length > 0 && (
              <span className="truncate">· {question.sectionPaths.join(' + ')}</span>
            )}
            {question.criticScore !== null && (
              <span title="The second examiner's average across six criteria">
                · examiner {question.criticScore.toFixed(1)}/5
              </span>
            )}
            {question.timesServed > 0 && (
              <span>
                · {question.timesCorrect}/{question.timesServed} right
              </span>
            )}
          </div>
        </button>
        <button
          className="btn btn-sm shrink-0"
          onClick={onDelete}
          title="Delete this question"
          aria-label="Delete this question"
        >
          <Icon name="trash" className="h-4 w-4" />
        </button>
      </div>

      {expanded && (
        <div className="border-t border-line bg-panel p-4 text-sm">
          {question.figure && (
            <figure className="mb-3">
              <img
                src={question.figure.url}
                alt={question.figure.caption ?? 'Figure this question refers to'}
                className="max-h-80 w-full rounded-lg border border-line object-contain"
              />
              {question.figure.caption && (
                <figcaption className="mt-1.5 text-xs text-muted">
                  {question.figure.caption}
                </figcaption>
              )}
            </figure>
          )}
          {question.optionsJson && question.optionsJson.length > 0 && (
            <ul className="space-y-1.5">
              {question.optionsJson.map((option, index) => (
                <li key={index} className={option.correct ? 'font-medium' : 'text-muted'}>
                  <span className="mr-2 font-mono text-xs">
                    {String.fromCharCode(65 + index)}
                  </span>
                  {option.text}
                  {option.correct && <span className="ml-2 text-xs text-emerald-500">correct</span>}
                  {option.whyWrong && (
                    <span className="mt-0.5 block pl-6 text-xs italic">{option.whyWrong}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {question.correctAnswer && (
            <p className="mt-3">
              <span className="text-xs uppercase tracking-wider text-muted">Answer</span>
              <br />
              {question.correctAnswer}
            </p>
          )}
          {question.workedAnswer && (
            <div className="mt-3">
              <p className="text-xs uppercase tracking-wider text-muted">Reasoning</p>
              <p className="mt-1 whitespace-pre-wrap leading-relaxed">{question.workedAnswer}</p>
            </div>
          )}
          {question.markScheme && (
            <div className="mt-3">
              <p className="text-xs uppercase tracking-wider text-muted">Mark scheme</p>
              <p className="mt-1 whitespace-pre-wrap leading-relaxed">{question.markScheme}</p>
            </div>
          )}

          {/*
            The blueprint, shown because when a run produces questions that all
            feel the same, this is where you find out why — and it is the thing
            to change, rather than the prompt.
          */}
          <div className="mt-4 border-t border-line pt-3 text-xs text-muted">
            <p className="uppercase tracking-wider">Blueprint</p>
            <p className="mt-1">
              {blueprint.archetype?.replace(/_/g, ' ') ?? 'unknown'} · {question.format} ·{' '}
              {question.bloomLevel ?? '—'}
              {blueprint.scenario?.length ? ` · ${blueprint.scenario.join(', ')}` : ''}
              {blueprint.constraint ? ` · ${blueprint.constraint}` : ''}
            </p>
          </div>
        </div>
      )}
    </li>
  );
}
