import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, flattenSections, type IngestResult, type Source, type SourceType } from '../lib/api';

const SOURCE_TYPES: Array<{ value: SourceType; label: string }> = [
  { value: 'slides', label: 'Lecture slides' },
  { value: 'transcript', label: 'Lecture transcript' },
  { value: 'textbook', label: 'Textbook pages' },
  { value: 'notes', label: 'Your own notes' },
  { value: 'past_paper', label: 'Past paper' },
];

const ACCEPT = '.pdf,.docx,.txt,.md,.vtt,.srt';

export function SourcesPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<SourceType>('slides');
  const [title, setTitle] = useState('');
  const [lastIngest, setLastIngest] = useState<Record<string, IngestResult>>({});

  const { data: sources, isLoading } = useQuery({
    queryKey: ['sources', moduleId],
    queryFn: () => api.listSources(moduleId!),
    enabled: Boolean(moduleId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['sources', moduleId] });
    queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
  };

  /**
   * Upload then ingest, as two steps. The file is safely on disk before any
   * parser runs, so a parse failure is recoverable with a re-ingest rather
   * than needing the file uploaded again.
   */
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('type', type);
      if (title.trim()) form.append('title', title.trim());
      form.append('file', file);

      const source = await api.uploadSource(moduleId!, form);
      const result = await api.ingestSource(source.id);
      return { source, result };
    },
    onSuccess: ({ source, result }) => {
      setTitle('');
      if (fileRef.current) fileRef.current.value = '';
      setLastIngest((previous) => ({ ...previous, [source.id]: result }));
      invalidate();
    },
  });

  const backfill = useMutation({
    mutationFn: api.backfillEmbeddings,
    onSuccess: invalidate,
  });

  if (!moduleId) return null;

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
      <p className="mt-1 text-sm text-muted">
        Slides, transcripts, textbook pages and your own notes. Sources belong to the module, not
        to one section, because a lecture usually spans several.
      </p>

      <div className="card mt-6 p-4">
        <div className="flex items-end gap-3">
          <div className="w-48">
            <label className="label" htmlFor="source-type">
              Type
            </label>
            <select
              id="source-type"
              className="input"
              value={type}
              onChange={(event) => setType(event.target.value as SourceType)}
            >
              {SOURCE_TYPES.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex-1">
            <label className="label" htmlFor="source-title">
              Title <span className="normal-case text-muted">(optional)</span>
            </label>
            <input
              id="source-title"
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="L07 Action Potentials"
            />
          </div>
        </div>

        <div className="mt-3">
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-line
                       file:bg-panel file:px-3 file:py-1.5 file:text-sm file:font-medium
                       hover:file:bg-canvas"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
            }}
            disabled={upload.isPending}
          />
          <p className="mt-1.5 text-xs text-muted">
            Accepted: {ACCEPT.replace(/\./g, '').replace(/,/g, ', ')}. Uploading starts ingestion
            straight away.
          </p>
        </div>

        {upload.isPending && (
          <p className="mt-3 text-sm text-muted">Uploading and ingesting…</p>
        )}
        {upload.error && <p className="mt-3 text-sm text-flag">{(upload.error as Error).message}</p>}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button className="btn" onClick={() => backfill.mutate()} disabled={backfill.isPending}>
          Backfill missing embeddings
        </button>
        <span className="text-xs text-muted">
          Run this if material was ingested while the embedding model was unreachable.
        </span>
      </div>
      {backfill.data && (
        <p className="mt-2 text-sm text-muted">
          Embedded {backfill.data.chunks.embedded} of {backfill.data.chunks.pending} chunks and{' '}
          {backfill.data.noteBlocks.embedded} of {backfill.data.noteBlocks.pending} note blocks.
        </p>
      )}

      <div className="mt-8 space-y-3">
        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {sources?.length === 0 && (
          <p className="text-sm text-muted">Nothing ingested yet.</p>
        )}
        {sources?.map((source) => (
          <SourceCard
            key={source.id}
            source={source}
            moduleId={moduleId}
            ingest={lastIngest[source.id]}
          />
        ))}
      </div>
    </div>
  );
}

function SourceCard({
  source,
  moduleId,
  ingest,
}: {
  source: Source;
  moduleId: string;
  ingest: IngestResult | undefined;
}) {
  const queryClient = useQueryClient();
  const [editingMapping, setEditingMapping] = useState(false);

  const { data: sections } = useQuery({
    queryKey: ['sections', moduleId],
    queryFn: () => api.getSections(moduleId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sources', moduleId] });

  const reingest = useMutation({ mutationFn: () => api.ingestSource(source.id), onSuccess: invalidate });
  const remove = useMutation({ mutationFn: () => api.deleteSource(source.id), onSuccess: invalidate });
  const setSections = useMutation({
    mutationFn: (sectionIds: string[]) => api.setSourceSections(source.id, sectionIds),
    onSuccess: () => {
      setEditingMapping(false);
      invalidate();
    },
  });

  const flat = sections ? flattenSections(sections) : [];
  const mapped = new Set(source.sections.map((entry) => entry.sectionId));

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="font-medium">{source.title}</div>
          <div className="mt-0.5 text-xs text-muted">
            {source.type.replace('_', ' ')} · {source.filename}
            {source.pageCount ? ` · ${source.pageCount} pages` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusPill status={source.status} />
          <button className="btn" onClick={() => reingest.mutate()} disabled={reingest.isPending}>
            Re-ingest
          </button>
          <button className="btn" onClick={() => remove.mutate()}>
            Delete
          </button>
        </div>
      </div>

      {source.error && (
        <p className="mt-2 rounded border border-flag/30 bg-flag-soft px-2 py-1 text-sm text-flag">
          {source.error}
        </p>
      )}

      {ingest && (
        <p className="mt-2 text-xs text-muted">
          {ingest.chunks} chunks · {ingest.figures} figures ·{' '}
          {ingest.embedded ? 'embedded' : 'stored without vectors'} · {ingest.proposedSections}{' '}
          section{ingest.proposedSections === 1 ? '' : 's'} proposed
          {ingest.warnings.length > 0 && (
            <span className="mt-1 block text-flag">{ingest.warnings.join(' ')}</span>
          )}
        </p>
      )}

      <div className="mt-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">Sections</span>
          <button
            className="text-xs text-accent hover:underline"
            onClick={() => setEditingMapping((previous) => !previous)}
          >
            {editingMapping ? 'Cancel' : 'Edit'}
          </button>
        </div>

        {!editingMapping ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {source.sections.length === 0 && (
              <span className="text-sm text-muted">
                Not mapped to any section yet.
              </span>
            )}
            {source.sections.map((mapping) => (
              <span
                key={mapping.sectionId}
                className={`rounded-full px-2 py-0.5 text-xs ${
                  mapping.confirmed
                    ? 'bg-accent-soft text-accent'
                    : 'border border-dashed border-line text-muted'
                }`}
                title={
                  mapping.confirmed
                    ? 'Confirmed by you'
                    : `Proposed from embedding match (${mapping.score.toFixed(2)})`
                }
              >
                {mapping.sectionNumber} {mapping.sectionTitle}
                {!mapping.confirmed && ' ?'}
              </span>
            ))}
          </div>
        ) : (
          <MappingEditor
            sections={flat}
            selected={mapped}
            onSave={(ids) => setSections.mutate(ids)}
            saving={setSections.isPending}
          />
        )}
      </div>
    </div>
  );
}

function MappingEditor({
  sections,
  selected,
  onSave,
  saving,
}: {
  sections: ReturnType<typeof flattenSections>;
  selected: Set<string>;
  onSave: (ids: string[]) => void;
  saving: boolean;
}) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(selected));

  const toggle = (id: string) =>
    setChosen((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="mt-2">
      <div className="max-h-64 overflow-y-auto rounded border border-line">
        {sections.map((section) => (
          <label
            key={section.id}
            className="flex cursor-pointer items-center gap-2 border-b border-line px-2 py-1 text-sm last:border-b-0 hover:bg-canvas"
            style={{ paddingLeft: `${8 + (section.depth - 1) * 14}px` }}
          >
            <input
              type="checkbox"
              checked={chosen.has(section.id)}
              onChange={() => toggle(section.id)}
            />
            <span className="font-mono text-xs text-muted">{section.number}</span>
            <span className="truncate">{section.title}</span>
          </label>
        ))}
      </div>
      <button
        className="btn btn-primary mt-2"
        onClick={() => onSave([...chosen])}
        disabled={saving}
      >
        Confirm mapping
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: Source['status'] }) {
  const styles: Record<Source['status'], string> = {
    uploaded: 'bg-canvas text-muted',
    ingesting: 'bg-amber-100 text-amber-800',
    ingested: 'bg-accent-soft text-accent',
    failed: 'bg-flag-soft text-flag',
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs ${styles[status]}`}>{status}</span>
  );
}
