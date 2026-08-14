import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  api,
  flattenSections,
  type IngestJob,
  type IngestResult,
  type Source,
  type SourceType,
} from '../lib/api';
import { Icon, type IconName } from '../components/ui/Icon';
import { useConfirm } from '../components/ui/Confirm';
import { useToast } from '../components/ui/Toast';

const SOURCE_TYPES: Array<{ value: SourceType; label: string }> = [
  { value: 'slides', label: 'Lecture slides' },
  { value: 'transcript', label: 'Lecture transcript' },
  { value: 'textbook', label: 'Textbook pages' },
  { value: 'notes', label: 'Your own notes' },
  { value: 'past_paper', label: 'Past paper' },
];

const TYPE_ICON: Record<SourceType, IconName> = {
  slides: 'layers',
  transcript: 'notes',
  textbook: 'book',
  notes: 'edit',
  past_paper: 'question',
};

const ACCEPT = '.pdf,.docx,.txt,.md,.vtt,.srt';

export function SourcesPage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<SourceType>('slides');
  const [title, setTitle] = useState('');
  const [dragging, setDragging] = useState(false);
  const [lastIngest, setLastIngest] = useState<Record<string, IngestResult>>({});
  const [job, setJob] = useState<IngestJob | null>(null);

  const { data: sources, isLoading } = useQuery({
    queryKey: ['sources', moduleId],
    queryFn: () => api.listSources(moduleId!),
    enabled: Boolean(moduleId),
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['sources', moduleId] });
    queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
    queryClient.invalidateQueries({ queryKey: ['modules'] });
  };

  /**
   * Upload, then follow the ingestion rather than waiting on one long request.
   * A textbook takes minutes to read, and the rest of the app stays usable
   * throughout — you can write notes in another section while it works.
   */
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('type', type);
      if (title.trim()) form.append('title', title.trim());
      form.append('file', file);

      const source = await api.uploadSource(moduleId!, form);
      setTitle('');
      if (fileRef.current) fileRef.current.value = '';
      invalidate();

      await api.ingestSource(source.id);

      // Poll until it finishes. Slow enough not to be chatty, quick enough
      // that the page bar still looks alive.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        const status = await api.ingestStatus(source.id);
        setJob(status);
        if (status.phase === 'done' || status.phase === 'failed') return { source, status };
      }
    },
    onSuccess: ({ source, status }) => {
      setJob(null);
      invalidate();

      if (status.phase === 'failed' || !status.result) {
        toast.error(`Could not read ${source.title}`, status.error ?? 'Ingestion failed.');
        return;
      }
      const result = status.result;
      setLastIngest((previous) => ({ ...previous, [source.id]: result }));
      toast.success(
        `Ingested ${source.title}`,
        `${result.chunks} chunks, ${result.figures} figures, ${result.proposedSections} section${
          result.proposedSections === 1 ? '' : 's'
        } proposed.`,
      );
    },
    onError: (error: Error) => {
      setJob(null);
      toast.error('Ingestion failed', error.message);
    },
  });

  if (!moduleId) return null;

  return (
    <div className="mx-auto max-w-4xl px-8 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Sources</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
          Slides, transcripts, textbook pages and your own notes. Sources belong to the module
          rather than one section, because a lecture usually spans several.
        </p>
      </header>

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
              Title <span className="font-normal normal-case text-faint">optional</span>
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

        <label
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files?.[0];
            if (file) upload.mutate(file);
          }}
          className={`mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
            dragging ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/50 hover:bg-canvas'
          } ${upload.isPending ? 'pointer-events-none opacity-60' : ''}`}
        >
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload.mutate(file);
            }}
            disabled={upload.isPending}
          />
          <Icon name="upload" size={22} className={dragging ? 'text-accent' : 'text-faint'} />
          <span className="mt-2 text-sm font-medium">
            {upload.isPending ? 'Reading your document…' : 'Drop a file here, or click to choose'}
          </span>
          <span className="mt-1 text-xs text-muted">
            {ACCEPT.replace(/\./g, '').replace(/,/g, ', ')} · ingestion starts straight away
          </span>
        </label>

        {upload.isPending && <IngestProgress job={job} />}
      </div>

      <div className="mt-8 space-y-3">
        {isLoading && (
          <>
            <div className="skeleton h-28" />
            <div className="skeleton h-28" />
          </>
        )}

        {sources?.length === 0 && (
          <div className="card px-6 py-12 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name="file" size={20} />
            </span>
            <h2 className="mt-3 font-medium">Nothing ingested yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
              Add a lecture deck or transcript above. Text keeps its slide number or timestamp,
              and figures are pulled out of the PDF automatically.
            </p>
          </div>
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
  const toast = useToast();
  const confirm = useConfirm();
  const [editingMapping, setEditingMapping] = useState(false);

  const { data: sections } = useQuery({
    queryKey: ['sections', moduleId],
    queryFn: () => api.getSections(moduleId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sources', moduleId] });

  const reingest = useMutation({
    mutationFn: async () => {
      await api.ingestSource(source.id);
      // Same background job as a fresh upload, so follow it the same way.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        const status = await api.ingestStatus(source.id);
        if (status.phase === 'done' || status.phase === 'failed') return status;
      }
    },
    onSuccess: (status) => {
      invalidate();
      if (status.phase === 'failed' || !status.result) {
        toast.error('Re-ingestion failed', status.error ?? 'Could not read the file.');
        return;
      }
      toast.success(
        `Re-ingested ${source.title}`,
        `${status.result.chunks} chunks, ${status.result.figures} figures.`,
      );
    },
    onError: (error: Error) => toast.error('Re-ingestion failed', error.message),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteSource(source.id),
    onSuccess: () => {
      invalidate();
      toast.success('Source deleted');
    },
    onError: (error: Error) => toast.error('Could not delete the source', error.message),
  });

  const setSections = useMutation({
    mutationFn: (sectionIds: string[]) => api.setSourceSections(source.id, sectionIds),
    onSuccess: (mappings) => {
      setEditingMapping(false);
      invalidate();
      toast.success(`Mapped to ${mappings.length} section${mappings.length === 1 ? '' : 's'}`);
    },
    onError: (error: Error) => toast.error('Could not save the mapping', error.message),
  });

  const askThenDelete = async () => {
    const confirmed = await confirm({
      title: `Delete ${source.title}?`,
      message:
        'The stored file, its extracted text and every figure pulled out of it will be removed. ' +
        'Notes you have written are not affected.',
      confirmLabel: 'Delete source',
      tone: 'danger',
    });
    if (confirmed) remove.mutate();
  };

  const flat = sections ? flattenSections(sections) : [];
  const mapped = new Set(source.sections.map((entry) => entry.sectionId));

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-canvas text-muted">
            <Icon name={TYPE_ICON[source.type]} size={17} />
          </span>
          <div className="min-w-0">
            <div className="font-medium">{source.title}</div>
            <div className="mt-0.5 truncate text-xs text-muted">
              {source.type.replace('_', ' ')} · {source.filename}
              {source.pageCount ? ` · ${source.pageCount} pages` : ''}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <StatusPill status={source.status} />
          <button
            className="btn-icon"
            onClick={() => reingest.mutate()}
            disabled={reingest.isPending}
            title="Re-ingest — parse the file again"
            aria-label="Re-ingest"
          >
            <Icon name="refresh" size={15} className={reingest.isPending ? 'animate-spin' : ''} />
          </button>
          <button
            className="btn-icon hover:text-flag"
            onClick={askThenDelete}
            title="Delete source"
            aria-label="Delete source"
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </div>

      {source.error && (
        <p className="mt-3 rounded-lg border border-flag/30 bg-flag-soft px-3 py-2 text-sm text-flag">
          {source.error}
        </p>
      )}

      {ingest && (
        <p className="mt-3 text-xs text-muted">
          {ingest.chunks} chunks · {ingest.figures} figures ·{' '}
          {ingest.embedded ? 'embedded' : 'stored without vectors'} · {ingest.proposedSections}{' '}
          section{ingest.proposedSections === 1 ? '' : 's'} proposed
          {ingest.warnings.length > 0 && (
            <span className="mt-1 block text-warn">{ingest.warnings.join(' ')}</span>
          )}
        </p>
      )}

      <div className="mt-3 border-t border-line pt-3">
        <div className="flex items-center gap-2">
          <span className="text-2xs font-semibold uppercase tracking-wider text-muted">
            Sections
          </span>
          <button
            className="text-xs font-medium text-accent transition hover:underline"
            onClick={() => setEditingMapping((previous) => !previous)}
          >
            {editingMapping ? 'Cancel' : 'Edit'}
          </button>
        </div>

        {!editingMapping ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {source.sections.length === 0 && (
              <span className="text-sm text-muted">Not mapped to any section yet.</span>
            )}
            {source.sections.map((mapping) => (
              <span
                key={mapping.sectionId}
                className={`chip ${
                  mapping.confirmed
                    ? 'bg-accent-soft text-accent'
                    : 'border border-dashed border-line text-muted'
                }`}
                title={
                  mapping.confirmed
                    ? 'Confirmed by you'
                    : `Proposed from an embedding match (${mapping.score.toFixed(2)})`
                }
              >
                <span className="font-mono">{mapping.sectionNumber}</span>
                {mapping.sectionTitle}
                {!mapping.confirmed && <Icon name="question" size={11} />}
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
      <div className="max-h-64 overflow-y-auto rounded-lg border border-line">
        {sections.map((section) => (
          <label
            key={section.id}
            className="flex cursor-pointer items-center gap-2 border-b border-line px-2 py-1.5 text-sm transition last:border-b-0 hover:bg-canvas"
            style={{ paddingLeft: `${8 + (section.depth - 1) * 16}px` }}
          >
            <input
              type="checkbox"
              checked={chosen.has(section.id)}
              onChange={() => toggle(section.id)}
              className="accent-accent"
            />
            <span className="font-mono text-2xs tabular-nums text-faint">{section.number}</span>
            <span className="truncate">{section.title}</span>
          </label>
        ))}
      </div>
      <button className="btn btn-primary mt-2" onClick={() => onSave([...chosen])} disabled={saving}>
        <Icon name="check" size={14} />
        Confirm mapping
      </button>
    </div>
  );
}

function StatusPill({ status }: { status: Source['status'] }) {
  const styles: Record<Source['status'], string> = {
    uploaded: 'bg-line/60 text-muted',
    ingesting: 'bg-warn-soft text-warn',
    ingested: 'bg-accent-soft text-accent',
    failed: 'bg-flag-soft text-flag',
  };
  return <span className={`chip ${styles[status]}`}>{status}</span>;
}

/**
 * Progress for an ingestion in flight.
 *
 * A long document used to give no feedback at all, which is indistinguishable
 * from a hang — and since the work blocked the server, the app really was
 * unusable while it ran. Both halves of that are fixed; this is the visible one.
 */
function IngestProgress({ job }: { job: IngestJob | null }) {
  const percent =
    job && job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : null;

  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas p-3">
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">{job?.message ?? 'Starting…'}</span>
        {percent !== null && <span className="tabular-nums text-muted">{percent}%</span>}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line">
        <div
          className={`h-full rounded-full bg-accent transition-[width] duration-300 ${
            percent === null ? 'w-1/3 animate-pulse' : ''
          }`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-muted">
        You can carry on using the rest of the app while this runs — writing notes in another
        section is fine.
      </p>
    </div>
  );
}
