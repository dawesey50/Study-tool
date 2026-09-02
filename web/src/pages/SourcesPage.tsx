import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, flattenSections, type Source, type SourceType } from '../lib/api';
import { Icon, type IconName } from '../components/ui/Icon';
import { UploadQueueList, useUploadQueue } from '../components/UploadQueue';
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<SourceType>('slides');
  const [dragging, setDragging] = useState(false);

  const { data: sources, isLoading } = useQuery({
    queryKey: ['sources', moduleId],
    queryFn: () => api.listSources(moduleId!),
    enabled: Boolean(moduleId),
  });

  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['sources', moduleId] });
    queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
    queryClient.invalidateQueries({ queryKey: ['modules'] });
  };

  const queue = useUploadQueue(moduleId, invalidate);

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
          <p className="flex-1 pb-1.5 text-xs leading-relaxed text-muted">
            Each file is titled from its filename, and every file in one drop is filed under the
            type chosen here. Rename or re-type any of them afterwards.
          </p>
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
            const files = [...(event.dataTransfer.files ?? [])];
            if (files.length) void queue.add(files, type);
          }}
          className={`mt-3 flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-4 py-8 text-center transition ${
            dragging ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent/50 hover:bg-canvas'
          }`}
        >
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="sr-only"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length) void queue.add(files, type);
              if (fileRef.current) fileRef.current.value = '';
            }}
          />
          <Icon name="upload" size={22} className={dragging ? 'text-accent' : 'text-faint'} />
          <span className="mt-2 text-sm font-medium">
            Drop files here, or click to choose
          </span>
          <span className="mt-1 text-xs text-muted">
            {ACCEPT.replace(/\./g, '').replace(/,/g, ', ')} · drop a whole module at once and
            walk away
          </span>
          {/*
            The size limit is worth stating before you hit it. A scanned
            textbook can be several hundred megabytes, and finding the ceiling
            by having an upload fail is a poor way to learn it.
          */}
          {health && (
            <span className="mt-1 text-2xs text-faint">
              Up to {health.maxUploadMb} MB per file — raise MAX_UPLOAD_MB in .env for anything
              bigger
            </span>
          )}
        </label>

        <UploadQueueList
          items={queue.items}
          onCancel={queue.cancel}
          onClear={queue.clearFinished}
        />
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
          <SourceCard key={source.id} source={source} moduleId={moduleId} />
        ))}
      </div>
    </div>
  );
}

function SourceCard({ source, moduleId }: { source: Source; moduleId: string }) {
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

