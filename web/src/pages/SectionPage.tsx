import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ConceptList } from '../components/ConceptList';
import { NoteEditor } from '../components/NoteEditor';
import { api, type Chunk, type Source } from '../lib/api';
import { Icon, type IconName } from '../components/ui/Icon';
import { useToast } from '../components/ui/Toast';

type Tab = 'notes' | 'concepts' | 'exam' | 'practice' | 'sources';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'notes', label: 'Notes', icon: 'notes' },
  { id: 'concepts', label: 'Concepts', icon: 'sparkle' },
  { id: 'exam', label: 'Exam questions', icon: 'file' },
  { id: 'practice', label: 'Practice', icon: 'question' },
  { id: 'sources', label: 'Sources', icon: 'layers' },
];

/**
 * A section is a workspace with tabs, per §4 of the spec.
 *
 * Concepts is a fifth beyond the four §4 names, because the concept list is
 * not an implementation detail: notes are generated against it, coverage is
 * measured against it and questions are sampled from it, so everything later
 * inherits whatever is in it. It has to be somewhere you read and correct.
 */
export function SectionPage() {
  const { moduleId, sectionId } = useParams<{ moduleId: string; sectionId: string }>();
  const [tab, setTab] = useState<Tab>('notes');

  const { data: section } = useQuery({
    queryKey: ['section', sectionId],
    queryFn: () => api.getSection(sectionId!),
    enabled: Boolean(sectionId),
  });

  const { data: sources } = useQuery({
    queryKey: ['sources', moduleId],
    queryFn: () => api.listSources(moduleId!),
    enabled: Boolean(moduleId),
  });

  if (!section || !sectionId || !moduleId) {
    return (
      <div className="mx-auto max-w-4xl space-y-3 px-8 py-10">
        <div className="skeleton h-8 w-2/3" />
        <div className="skeleton h-32" />
      </div>
    );
  }

  const sectionSources = sources?.filter((source) =>
    source.sections.some((mapping) => mapping.sectionId === sectionId),
  );

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <SectionHeader sectionId={sectionId} number={section.number} title={section.title} />

      {section.learningOutcomes?.length ? (
        <ul className="card mt-4 space-y-1.5 px-4 py-3 text-sm">
          {section.learningOutcomes.map((outcome) => (
            <li key={outcome} className="flex gap-2.5">
              <Icon name="check" size={14} className="mt-1 text-accent" />
              <span className="leading-relaxed">{outcome}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-7 flex gap-0.5 border-b border-line">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            aria-current={tab === entry.id ? 'page' : undefined}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition ${
              tab === entry.id
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-muted hover:border-line hover:text-ink'
            }`}
          >
            <Icon name={entry.icon} size={14} />
            {entry.label}
            {entry.id === 'sources' && sectionSources?.length ? (
              <span className="chip bg-line/60 text-muted">{sectionSources.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="py-7">
        {tab === 'notes' && <NoteEditor sectionId={sectionId} />}
        {tab === 'concepts' && <ConceptList moduleId={moduleId} sectionId={sectionId} />}
        {tab === 'exam' && <ExamQuestions moduleId={moduleId} sectionId={sectionId} />}
        {tab === 'practice' && <SectionPractice moduleId={moduleId} sectionId={sectionId} />}
        {tab === 'sources' && (
          <SourcesTab moduleId={moduleId} sectionId={sectionId} sources={sectionSources} />
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  sectionId,
  number,
  title,
}: {
  sectionId: string;
  number: string;
  title: string;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);

  const rename = useMutation({
    mutationFn: (newTitle: string) => api.updateSection(sectionId, { title: newTitle }),
    onSuccess: (_, newTitle) => {
      setDraft(null);
      queryClient.setQueryData(['section', sectionId], (previous: unknown) =>
        previous && typeof previous === 'object' ? { ...previous, title: newTitle } : previous,
      );
      queryClient.invalidateQueries({ queryKey: ['sections'] });
    },
    onError: (error: Error) => toast.error('Could not rename the section', error.message),
  });

  return (
    <div className="group flex items-baseline gap-3">
      <span className="font-mono text-sm tabular-nums text-faint">{number}</span>
      {draft === null ? (
        <>
          <h1
            className="cursor-text text-2xl font-semibold tracking-tight"
            onDoubleClick={() => setDraft(title)}
          >
            {title}
          </h1>
          <button
            className="btn-icon h-7 w-7 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100"
            onClick={() => setDraft(title)}
            aria-label="Rename section"
            title="Rename section"
          >
            <Icon name="edit" size={14} />
          </button>
        </>
      ) : (
        <input
          autoFocus
          className="input flex-1 text-2xl font-semibold"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => (draft.trim() ? rename.mutate(draft.trim()) : setDraft(null))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && draft.trim()) rename.mutate(draft.trim());
            if (event.key === 'Escape') setDraft(null);
          }}
        />
      )}
    </div>
  );
}

function SourcesTab({
  moduleId,
  sectionId,
  sources,
}: {
  moduleId: string;
  sectionId: string;
  sources: Source[] | undefined;
}) {
  const { data: figures } = useQuery({
    queryKey: ['section-figures', sectionId],
    queryFn: () => api.getSectionFigures(sectionId),
  });

  if (!sources?.length) {
    return (
      <div className="card px-6 py-12 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Icon name="upload" size={20} />
        </span>
        <h3 className="mt-3 font-medium">No sources mapped here yet</h3>
        <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
          Sources belong to the module and are mapped to the sections they cover, because one
          lecture usually spans several.
        </p>
        <Link className="btn mt-4" to={`/modules/${moduleId}/sources`}>
          Add and map sources
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {sources.map((source) => (
        <SourceChunks key={source.id} source={source} sectionId={sectionId} />
      ))}

      {figures && figures.length > 0 && (
        <section>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-muted">
            <Icon name="image" size={14} />
            Figures from this section&rsquo;s sources
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Nothing extracted is lost. Generated notes will place the ones that genuinely
            illustrate the text; the rest stay here.
          </p>
          <div className="mt-3 grid grid-cols-3 gap-3">
            {figures.map((figure) => (
              <figure key={figure.id} className="card overflow-hidden">
                <img
                  src={figure.url}
                  alt={figure.altText ?? figure.captionExtracted ?? 'Extracted figure'}
                  className="h-32 w-full bg-canvas object-contain"
                  loading="lazy"
                />
                <figcaption className="border-t border-line px-2 py-1.5 text-2xs leading-snug text-muted">
                  {figure.captionExtracted ?? figure.captionAi ?? 'No caption found'}
                  {figure.pageNo ? (
                    <span className="mt-0.5 block font-mono text-faint">p.{figure.pageNo}</span>
                  ) : null}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** The chunks of one source that were matched to this section, with citations. */
function SourceChunks({ source, sectionId }: { source: Source; sectionId: string }) {
  const [expanded, setExpanded] = useState(false);

  const { data: chunks } = useQuery({
    queryKey: ['chunks', source.id],
    queryFn: () => api.getChunks(source.id),
    enabled: expanded,
  });

  const mapping = source.sections.find((entry) => entry.sectionId === sectionId);
  const chunkIds = new Set(mapping?.chunkIds ?? []);
  const relevant: Chunk[] | undefined = chunks?.filter(
    (chunk) => chunkIds.size === 0 || chunkIds.has(chunk.id),
  );

  return (
    <div className="card p-4">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">{source.title}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            <span>{source.type.replace('_', ' ')}</span>
            {source.pageCount ? <span>· {source.pageCount} pages</span> : null}
            <span>·</span>
            <span className={mapping?.confirmed ? 'text-accent' : ''}>
              {mapping?.confirmed ? 'mapping confirmed' : 'mapping proposed'}
            </span>
          </div>
        </div>
        <button className="btn btn-sm shrink-0" onClick={() => setExpanded((previous) => !previous)}>
          <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
          {expanded ? 'Hide' : 'Show'} extract
        </button>
      </div>

      {expanded && (
        <div className="mt-4 space-y-4">
          {!chunks && <div className="skeleton h-20" />}
          {relevant?.length === 0 && (
            <p className="text-sm text-muted">No chunks matched to this section.</p>
          )}
          {relevant?.map((chunk) => (
            <div key={chunk.id} className="border-l-2 border-line pl-3">
              <div className="font-mono text-2xs text-faint">{chunk.location}</div>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed">{chunk.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Real questions from real papers, for this section.
 *
 * These carry no answer and never will. A past paper prints the question and
 * not the mark scheme, and generating one would put invented marking in front
 * of you looking exactly like the examiner's — which is worse than having
 * none, because you would revise against it.
 *
 * What they are for is the other two things: they say what has actually been
 * examined, and they stop the generator writing a question that reproduces
 * one. That second job runs whether or not you ever read this tab.
 */
function ExamQuestions({ moduleId, sectionId }: { moduleId: string; sectionId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const { data, isLoading } = useQuery({
    queryKey: ['questions', moduleId, sectionId, 'past_paper'],
    queryFn: () => api.listQuestions(moduleId, { sectionId, source: 'past_paper' }),
  });

  const { data: sources } = useQuery({
    queryKey: ['sources', moduleId],
    queryFn: () => api.listSources(moduleId),
  });

  const extract = useMutation({
    mutationFn: () => api.extractPastPapers(moduleId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['questions'] });
      if (result.found === 0) {
        toast.error(
          'No questions found in those papers',
          'Exam papers are split on their question numbering. If the paper is a scan with no ' +
            'text layer, or numbers its questions in a way this does not recognise, nothing ' +
            'can be pulled out of it.',
        );
      } else if (result.unmapped) {
        toast.success(
          `${result.stored} questions stored from ${result.papers} paper${result.papers === 1 ? '' : 's'}`,
          'They could not be filed under a section yet, because this module has no concepts ' +
            'with embeddings. They already guard the novelty gate — extract concepts and run ' +
            'this again to file them.',
        );
      } else {
        toast.success(
          result.stored > 0
            ? `${result.stored} questions from ${result.papers} paper${result.papers === 1 ? '' : 's'}`
            : 'Nothing new — already extracted',
          `${result.mapped} matched to a concept${result.skippedExisting ? `, ${result.skippedExisting} already had` : ''}.`,
        );
      }
    },
    onError: (error: Error) => toast.error('Could not extract questions', error.message),
  });

  if (isLoading) return <div className="skeleton h-32" />;

  const questions = data?.questions ?? [];
  const papers = (sources ?? []).filter((source) => source.type === 'past_paper');

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Exam questions
          </h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            Pulled straight out of the papers, unaltered and without answers. Every one of these
            was actually examined, which is why they set what counts as examinable — and why the
            generator is blocked from writing anything that resembles them.
          </p>
        </div>
        <button
          className="btn btn-sm shrink-0"
          onClick={() => extract.mutate()}
          disabled={extract.isPending || papers.length === 0}
          title={
            papers.length === 0
              ? 'Upload a past paper on the Sources page first'
              : 'Split this module’s past papers into questions'
          }
        >
          <Icon name="refresh" size={14} className="mr-1" />
          {extract.isPending ? 'Reading…' : 'Extract from papers'}
        </button>
      </div>

      {papers.length === 0 ? (
        <div className="card mt-4 p-6 text-center text-sm text-muted">
          No past papers in this module. Upload one on the{' '}
          <Link className="underline underline-offset-2" to={`/modules/${moduleId}/sources`}>
            Sources page
          </Link>
          , filed as “Past paper”.
        </div>
      ) : questions.length === 0 ? (
        <div className="card mt-4 p-6 text-center text-sm text-muted">
          {papers.length} past paper{papers.length === 1 ? '' : 's'} uploaded, but no questions
          filed under this section yet. Extract them, and if they still do not appear it is
          because they have not matched any of this section’s concepts.
        </div>
      ) : (
        <ul className="mt-4 space-y-2">
          {questions.map((question) => {
            const blueprint = (question.blueprintJson ?? {}) as {
              paper?: string;
              number?: string;
              marks?: number;
            };
            return (
              <li key={question.id} className="card p-3">
                <div className="flex items-baseline gap-2">
                  {blueprint.number && (
                    <span className="shrink-0 font-mono text-xs text-muted">
                      {blueprint.number}
                    </span>
                  )}
                  <p className="text-sm leading-relaxed">{question.stem}</p>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] text-muted">
                  {blueprint.paper && <span>{blueprint.paper}</span>}
                  {blueprint.marks !== undefined && <span>· {blueprint.marks} marks</span>}
                  <span className="rounded bg-line px-1.5 py-0.5 uppercase tracking-wide">
                    {question.format}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The section's slice of the question bank, and a way into practice scoped to
 * it. The full bank lives at the module level, because the properties worth
 * checking — how the answer keys fall, whether the same letter runs — are
 * properties of the whole set and a per-section view of them would mislead.
 */
function SectionPractice({ moduleId, sectionId }: { moduleId: string; sectionId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['questions', moduleId, sectionId],
    queryFn: () => api.listQuestions(moduleId, { sectionId }),
  });

  if (isLoading) return <div className="skeleton h-32" />;

  const questions = data?.questions ?? [];

  if (questions.length === 0) {
    return (
      <div className="card p-6 text-center">
        <p className="text-sm text-muted">
          No questions for this section yet. They are sampled from its concept list, so extract
          concepts first, then generate from the bank.
        </p>
        <Link className="btn btn-primary mt-4 inline-flex" to={`/modules/${moduleId}/questions`}>
          <Icon name="sparkle" size={14} className="mr-1" />
          Generate questions
        </Link>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
            Practice
          </h2>
          <p className="mt-1 text-xs text-muted">
            {questions.length} question{questions.length === 1 ? '' : 's'} touch this section.
          </p>
        </div>
        <Link
          className="btn btn-primary shrink-0"
          to={`/modules/${moduleId}/practice?section=${sectionId}`}
        >
          <Icon name="question" size={14} className="mr-1" />
          Start
        </Link>
      </div>

      <ul className="mt-4 space-y-2">
        {questions.map((question) => (
          <li key={question.id} className="card p-3">
            <p className="text-sm leading-relaxed">{question.stem}</p>
            <div className="mt-1.5 flex flex-wrap gap-x-2 text-[11px] text-muted">
              <span className="rounded bg-line px-1.5 py-0.5 uppercase tracking-wide">
                {question.format}
              </span>
              {question.bloomLevel && <span>{question.bloomLevel}</span>}
              {question.timesServed > 0 && (
                <span>
                  · {question.timesCorrect}/{question.timesServed} right
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">
        Answers are deliberately not shown here — the full record, with the reasoning and the
        blueprint behind each question, is in the{' '}
        <Link className="underline underline-offset-2" to={`/modules/${moduleId}/questions`}>
          question bank
        </Link>
        .
      </p>
    </div>
  );
}
