import { useCallback, useRef, useState } from 'react';
import { api, type IngestJob, type SourceType } from '../lib/api';
import { Icon } from './ui/Icon';
import { useToast } from './ui/Toast';

/**
 * Drop a whole module's material in at once and walk away.
 *
 * Files are uploaded and ingested one at a time rather than in parallel:
 * parsing is CPU-bound, so running four at once would finish no sooner and
 * would make each one's progress meaningless. What matters is that the queue
 * is unattended — a term's twenty lectures go in with one drop.
 */

export type QueueStatus = 'waiting' | 'uploading' | 'ingesting' | 'done' | 'failed' | 'cancelled';

export interface QueueItem {
  id: string;
  file: File;
  status: QueueStatus;
  message: string;
  sourceId?: string;
  scanned?: boolean;
  /**
   * What ingestion noticed but did not fail on — speaker notes found, half the
   * slides empty, a terse deck with little to extract from.
   *
   * These were generated and thrown away, which made them worse than useless:
   * the parser spends real effort deciding that a deck has no speaker notes
   * and will therefore give concept extraction very little to go on, and then
   * the person who could act on it never sees it and blames the model.
   */
  warnings?: string[];
  progress?: { done: number; total: number };
}

export function useUploadQueue(moduleId: string | undefined, onChanged: () => void) {
  const toast = useToast();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [running, setRunning] = useState(false);
  const cancelled = useRef(new Set<string>());

  const patch = useCallback((id: string, changes: Partial<QueueItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...changes } : item)),
    );
  }, []);

  const runOne = useCallback(
    async (item: QueueItem, type: SourceType) => {
      patch(item.id, { status: 'uploading', message: 'Uploading…' });

      const form = new FormData();
      form.append('type', type);
      form.append('file', item.file);
      const source = await api.uploadSource(moduleId!, form);
      patch(item.id, { sourceId: source.id, status: 'ingesting', message: 'Reading…' });
      onChanged();

      await api.ingestSource(source.id);

      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 600));

        if (cancelled.current.has(item.id)) {
          await api.cancelIngest(source.id).catch(() => undefined);
        }

        // A note from the upload itself — "named .ppt, actually a .pptx" —
        // belongs beside the file it is about, alongside anything ingestion
        // goes on to notice.
        const uploadNote = (source as { note?: string }).note;
        if (uploadNote) patch(item.id, { warnings: [uploadNote] });

        const job: IngestJob = await api.ingestStatus(source.id);
        patch(item.id, {
          message: job.message,
          progress: job.total > 0 ? { done: job.done, total: job.total } : undefined,
        });

        if (job.phase === 'done') {
          patch(item.id, {
            status: 'done',
            message: `${job.result?.chunks ?? 0} chunks · ${job.result?.figures ?? 0} figures`,
            scanned: job.result?.likelyScanned ?? false,
            warnings: [
              ...(uploadNote ? [uploadNote] : []),
              ...(job.result?.warnings ?? []),
            ],
          });
          return;
        }
        if (job.phase === 'cancelled') {
          patch(item.id, { status: 'cancelled', message: 'Cancelled' });
          return;
        }
        if (job.phase === 'failed') {
          patch(item.id, { status: 'failed', message: job.error ?? 'Failed' });
          return;
        }
      }
    },
    [moduleId, onChanged, patch],
  );

  const add = useCallback(
    async (files: File[], type: SourceType) => {
      if (!moduleId || files.length === 0) return;

      const queued: QueueItem[] = files.map((file, index) => ({
        id: `${Date.now()}-${index}-${file.name}`,
        file,
        status: 'waiting',
        message: 'Waiting',
      }));
      setItems((current) => [...current, ...queued]);

      if (running) return; // The loop below will pick these up.
      setRunning(true);

      let pending = queued;
      while (pending.length > 0) {
        for (const item of pending) {
          if (cancelled.current.has(item.id)) {
            patch(item.id, { status: 'cancelled', message: 'Cancelled' });
            continue;
          }
          try {
            await runOne(item, type);
          } catch (error) {
            patch(item.id, { status: 'failed', message: (error as Error).message });
          }
        }
        // Anything dropped in while the queue was running.
        pending = [];
        setItems((current) => {
          pending = current.filter((item) => item.status === 'waiting');
          return current;
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      setRunning(false);
      onChanged();

      setItems((current) => {
        const done = current.filter((item) => item.status === 'done').length;
        const failed = current.filter((item) => item.status === 'failed').length;
        const scans = current.filter((item) => item.scanned).length;
        if (done > 0) {
          toast.success(
            `Ingested ${done} file${done === 1 ? '' : 's'}`,
            [
              failed > 0 ? `${failed} failed.` : '',
              scans > 0 ? `${scans} appear to be scans and need OCR.` : '',
            ]
              .filter(Boolean)
              .join(' ') || undefined,
          );
        }
        return current;
      });
    },
    [moduleId, running, runOne, patch, onChanged, toast],
  );

  const cancel = useCallback((id: string) => {
    cancelled.current.add(id);
    setItems((current) =>
      current.map((item) =>
        item.id === id && item.status === 'waiting'
          ? { ...item, status: 'cancelled', message: 'Cancelled' }
          : item,
      ),
    );
  }, []);

  const clearFinished = useCallback(() => {
    setItems((current) =>
      current.filter((item) => !['done', 'failed', 'cancelled'].includes(item.status)),
    );
  }, []);

  return { items, running, add, cancel, clearFinished };
}

const STATUS_STYLE: Record<QueueStatus, string> = {
  waiting: 'bg-line/60 text-muted',
  uploading: 'bg-warn-soft text-warn',
  ingesting: 'bg-warn-soft text-warn',
  done: 'bg-accent-soft text-accent',
  failed: 'bg-flag-soft text-flag',
  cancelled: 'bg-line/60 text-muted',
};

export function UploadQueueList({
  items,
  onCancel,
  onClear,
}: {
  items: QueueItem[];
  onCancel: (id: string) => void;
  onClear: () => void;
}) {
  if (items.length === 0) return null;

  const finished = items.filter((item) =>
    ['done', 'failed', 'cancelled'].includes(item.status),
  ).length;

  return (
    <div className="mt-3 rounded-lg border border-line bg-canvas">
      <div className="flex items-center justify-between border-b border-line px-3 py-2">
        <span className="text-2xs font-semibold uppercase tracking-wider text-muted">
          {finished} of {items.length} done
        </span>
        {finished > 0 && (
          <button className="text-xs text-accent hover:underline" onClick={onClear}>
            Clear finished
          </button>
        )}
      </div>

      <ul className="max-h-72 divide-y divide-line overflow-y-auto">
        {items.map((item) => {
          const percent =
            item.progress && item.progress.total > 0
              ? Math.round((item.progress.done / item.progress.total) * 100)
              : null;
          const active = item.status === 'uploading' || item.status === 'ingesting';

          return (
            <li key={item.id} className="px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{item.file.name}</span>
                <span className={`chip shrink-0 ${STATUS_STYLE[item.status]}`}>{item.status}</span>
                {(item.status === 'waiting' || active) && (
                  <button
                    className="btn-icon h-6 w-6"
                    onClick={() => onCancel(item.id)}
                    aria-label={`Cancel ${item.file.name}`}
                    title="Cancel"
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>

              {/*
                A failure gets the whole message; everything else gets one
                clipped line. Progress text is repetitive and not worth the
                space, but truncating "raise MAX_UPLOAD_MB in .env" to its first
                few words leaves you knowing only that something went wrong.
              */}
              {item.status === 'failed' ? (
                <p className="mt-1 rounded border border-flag/30 bg-flag-soft px-2 py-1 text-2xs leading-relaxed text-flag">
                  {item.message}
                </p>
              ) : (
                <div className="mt-0.5 flex items-baseline gap-2 text-2xs text-muted">
                  <span className="truncate">{item.message}</span>
                  {percent !== null && <span className="tabular-nums">{percent}%</span>}
                </div>
              )}

              {active && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
                  <div
                    className={`h-full rounded-full bg-accent transition-[width] duration-300 ${
                      percent === null ? 'w-1/3 animate-pulse' : ''
                    }`}
                    style={percent === null ? undefined : { width: `${percent}%` }}
                  />
                </div>
              )}

              {item.scanned && (
                <p className="mt-1.5 rounded border border-flag/30 bg-flag-soft px-2 py-1 text-2xs leading-relaxed text-flag">
                  This looks like a scan — almost no text could be read, so notes and questions
                  will have nothing to work with. It needs OCR.
                </p>
              )}

              {/*
                Not errors — the file ingested. They are what the parser noticed
                about the material, and they are the difference between "the
                concepts are thin" and "the concepts are thin because this deck
                is forty bullet fragments with no speaker notes".
              */}
              {!item.scanned &&
                item.warnings?.map((warning) => (
                  <p
                    key={warning}
                    className="mt-1.5 rounded border border-line bg-panel px-2 py-1 text-2xs leading-relaxed text-muted"
                  >
                    {warning}
                  </p>
                ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
