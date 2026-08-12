import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { NoteEditor } from '../components/NoteEditor';
import { api, type Chunk, type Source } from '../lib/api';

type Tab = 'notes' | 'exam' | 'practice' | 'sources';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'notes', label: 'Notes' },
  { id: 'exam', label: 'Exam questions' },
  { id: 'practice', label: 'Practice' },
  { id: 'sources', label: 'Sources' },
];

/** A section is a workspace with four tabs, per §4 of the spec. */
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
    return <div className="p-8 text-sm text-muted">Loading…</div>;
  }

  const sectionSources = sources?.filter((source) =>
    source.sections.some((mapping) => mapping.sectionId === sectionId),
  );

  return (
    <div className="mx-auto max-w-4xl px-8 py-8">
      <SectionHeader sectionId={sectionId} number={section.number} title={section.title} />

      {section.learningOutcomes?.length ? (
        <ul className="mt-3 space-y-1 rounded-md border border-line bg-panel px-4 py-3 text-sm">
          {section.learningOutcomes.map((outcome) => (
            <li key={outcome} className="flex gap-2">
              <span className="text-muted">›</span>
              <span>{outcome}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-6 flex gap-1 border-b border-line">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            onClick={() => setTab(entry.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              tab === entry.id
                ? 'border-accent font-medium text-accent'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {entry.label}
            {entry.id === 'sources' && sectionSources?.length ? (
              <span className="ml-1.5 text-xs text-muted">{sectionSources.length}</span>
            ) : null}
          </button>
        ))}
      </div>

      <div className="py-6">
        {tab === 'notes' && <NoteEditor sectionId={sectionId} />}
        {tab === 'exam' && (
          <Placeholder
            title="Past-paper questions"
            body="Real questions for this section appear here once you ingest a past paper. Paper
                  ingestion arrives in Phase 5."
          />
        )}
        {tab === 'practice' && (
          <Placeholder
            title="Generated practice questions"
            body="The question engine — blueprint sampling, novelty gate and examiner pass — is
                  Phase 3. It needs the concepts that Phase 2 extracts from these sources."
          />
        )}
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
  });

  return (
    <div className="flex items-baseline gap-3">
      <span className="font-mono text-sm text-muted">{number}</span>
      {draft === null ? (
        <h1
          className="cursor-text text-2xl font-semibold tracking-tight"
          onDoubleClick={() => setDraft(title)}
          title="Double-click to rename"
        >
          {title}
        </h1>
      ) : (
        <input
          autoFocus
          className="input text-2xl font-semibold"
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
      <div className="card p-8 text-center text-sm text-muted">
        <p>No sources are mapped to this section yet.</p>
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
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">
            Figures from this section&rsquo;s sources
          </h3>
          <p className="mt-1 text-xs text-muted">
            Nothing extracted is lost. Phase 2 places the ones that genuinely illustrate the
            notes; the rest stay here.
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
                <figcaption className="border-t border-line px-2 py-1.5 text-[11px] leading-snug text-muted">
                  {figure.captionExtracted ?? figure.captionAi ?? 'No caption found'}
                  {figure.pageNo ? <span className="block">p.{figure.pageNo}</span> : null}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
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
        <div>
          <div className="font-medium">{source.title}</div>
          <div className="mt-0.5 text-xs text-muted">
            {source.type.replace('_', ' ')}
            {source.pageCount ? ` · ${source.pageCount} pages` : ''}
            {mapping?.confirmed ? ' · mapping confirmed' : ' · mapping proposed'}
          </div>
        </div>
        <button className="btn" onClick={() => setExpanded((previous) => !previous)}>
          {expanded ? 'Hide' : 'Show'} extract
        </button>
      </div>

      {expanded && (
        <div className="mt-4 space-y-3">
          {!chunks && <p className="text-sm text-muted">Loading…</p>}
          {relevant?.length === 0 && (
            <p className="text-sm text-muted">No chunks matched to this section.</p>
          )}
          {relevant?.map((chunk) => (
            <div key={chunk.id} className="border-l-2 border-line pl-3">
              <div className="font-mono text-[11px] text-muted">{chunk.location}</div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed">{chunk.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Placeholder({ title, body }: { title: string; body: string }) {
  return (
    <div className="card p-8 text-center">
      <h3 className="font-medium">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">{body}</p>
    </div>
  );
}
