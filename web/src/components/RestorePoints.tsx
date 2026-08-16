import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, flattenSections, type Snapshot } from '../lib/api';
import { Icon } from './ui/Icon';
import { useConfirm } from './ui/Confirm';
import { useToast } from './ui/Toast';

/**
 * Restore points for a module's notes.
 *
 * One is taken automatically before anything rewrites notes in bulk, and you
 * can take one by hand before doing something you are unsure about. Restoring
 * is exact — it puts the notes back as they were — which means it can delete
 * work done since, so the confirmation says how much and how much of it you
 * wrote yourself before it does anything.
 */

function when(seconds: number): string {
  const date = new Date(seconds * 1000);
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return 'just now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} h ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function RestorePoints({ moduleId }: { moduleId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const { data: snapshots, isLoading } = useQuery({
    queryKey: ['snapshots', moduleId],
    queryFn: () => api.listSnapshots(moduleId),
  });
  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId),
  });

  const sectionName = (sectionId: string | null): string => {
    if (!sectionId) return 'Whole module';
    const section = module
      ? flattenSections(module.sections).find((row) => row.id === sectionId)
      : undefined;
    return section ? `${section.number} ${section.title}` : 'A deleted section';
  };

  const take = useMutation({
    mutationFn: () => api.takeSnapshot(moduleId, { label: 'Taken by hand' }),
    onSuccess: (snapshot) => {
      queryClient.invalidateQueries({ queryKey: ['snapshots', moduleId] });
      toast.success(
        `Restore point saved — ${snapshot.blockCount} block${snapshot.blockCount === 1 ? '' : 's'}`,
        'You can come back to exactly this at any time.',
      );
    },
    onError: (error: Error) => toast.error('Could not take a restore point', error.message),
  });

  const restore = useMutation({
    mutationFn: (id: string) => api.restoreSnapshot(id),
    onSuccess: (result) => {
      queryClient.invalidateQueries();
      toast.success(
        `Restored ${result.blocks} block${result.blocks === 1 ? '' : 's'}`,
        'The state you replaced was saved first, so this is undoable.',
      );
    },
    onError: (error: Error) => toast.error('Could not restore', error.message),
  });

  const askThenRestore = async (snapshot: Snapshot) => {
    let preview: Awaited<ReturnType<typeof api.previewRestore>>;
    try {
      preview = await api.previewRestore(snapshot.id);
    } catch (error) {
      toast.error('Could not read that restore point', (error as Error).message);
      return;
    }

    const losses: string[] = [];
    if (preview.removed > 0) {
      losses.push(
        `${preview.removed} block${preview.removed === 1 ? '' : 's'} written since will be deleted` +
          (preview.removedUserWritten > 0
            ? ` — ${preview.removedUserWritten} of them yours` +
              (preview.removedLocked > 0 ? `, ${preview.removedLocked} locked` : '')
            : ''),
      );
    }
    if (preview.changed > 0) {
      losses.push(`${preview.changed} edited block${preview.changed === 1 ? '' : 's'} go back`);
    }
    if (preview.restored > 0) {
      losses.push(`${preview.restored} deleted block${preview.restored === 1 ? '' : 's'} come back`);
    }

    const confirmed = await confirm({
      title: `Restore "${snapshot.label}"?`,
      message:
        (losses.length ? `${losses.join('. ')}.` : 'Nothing has changed since — this is a no-op.') +
        ' The state you are replacing is saved first, so you can undo this.',
      confirmLabel: 'Restore',
      tone: preview.removedUserWritten > 0 ? 'danger' : 'normal',
    });
    if (confirmed) restore.mutate(snapshot.id);
  };

  return (
    <section className="mt-10">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">
          Restore points
        </h2>
        <button className="btn btn-sm" onClick={() => take.mutate()} disabled={take.isPending}>
          <Icon name="check" size={13} />
          {take.isPending ? 'Saving…' : 'Take one now'}
        </button>
      </div>

      {isLoading && <div className="skeleton mt-3 h-20" />}

      {snapshots?.length === 0 && (
        <p className="mt-3 rounded-xl border border-line px-4 py-5 text-sm leading-relaxed text-muted">
          None yet. One is saved automatically before anything rewrites your notes in bulk, so
          there is always a way back from a generation run that went wrong. You can also take one
          by hand before doing something you are unsure about.
        </p>
      )}

      {snapshots && snapshots.length > 0 && (
        <ul className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
          {snapshots.map((snapshot) => (
            <li
              key={snapshot.id}
              className="flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{snapshot.label}</div>
                {/*
                  The reason is not repeated here: every label already says it
                  ("Before a generation run for 2.1", "Taken by hand"), so
                  printing both just makes the line longer.
                */}
                <div className="mt-0.5 text-2xs text-muted">
                  {when(snapshot.createdAt)} · {sectionName(snapshot.sectionId)} ·{' '}
                  {snapshot.blockCount} block{snapshot.blockCount === 1 ? '' : 's'}
                </div>
              </div>
              <button
                className="btn btn-sm shrink-0"
                onClick={() => askThenRestore(snapshot)}
                disabled={restore.isPending}
              >
                <Icon name="refresh" size={13} />
                Restore
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-xs leading-relaxed text-muted">
        A restore point holds this module's notes and nothing else — sources and figures are not at
        risk from a generation run. For everything, use <strong>Back up</strong> above.
      </p>
    </section>
  );
}
