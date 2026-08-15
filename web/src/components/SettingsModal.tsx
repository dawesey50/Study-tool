import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useTheme, type Theme } from '../lib/theme';
import { LlmPanel } from './LlmPanel';
import { Icon } from './ui/Icon';
import { Modal } from './ui/Modal';
import { useToast } from './ui/Toast';

/**
 * Settings.
 *
 * Split deliberately: things you can change from here, and things that are
 * facts about this installation. Chunk size and the embedding provider live in
 * the .env file because they change what gets written to the database, and a
 * switch that silently invalidates everything already ingested would be a trap.
 * They are shown read-only with the file to edit.
 */
export function SettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health, enabled: open });

  const backfill = useMutation({
    mutationFn: api.backfillEmbeddings,
    onSuccess: (result) => {
      const total = result.chunks.embedded + result.noteBlocks.embedded;
      toast.success(
        total > 0 ? `Embedded ${total} item${total === 1 ? '' : 's'}` : 'Nothing needed embedding',
        `${result.chunks.pending} chunks and ${result.noteBlocks.pending} note blocks were waiting.`,
      );
      queryClient.invalidateQueries();
    },
    onError: (error: Error) => toast.error('Backfill failed', error.message),
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Settings"
      description="Preferences are saved on this machine."
      width="max-w-2xl"
      footer={
        <button className="btn" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="space-y-6">
        <section>
          <h3 className="label">Appearance</h3>
          <div className="flex gap-2">
            {(
              [
                ['light', 'sun', 'Light'],
                ['dark', 'moon', 'Dark'],
                ['system', 'settings', 'System'],
              ] as const
            ).map(([value, icon, label]) => (
              <button
                key={value}
                onClick={() => setTheme(value as Theme)}
                className={`btn flex-1 ${theme === value ? 'border-accent bg-accent-soft text-accent' : ''}`}
                aria-pressed={theme === value}
              >
                <Icon name={icon} size={15} />
                {label}
              </button>
            ))}
          </div>
        </section>

        <LlmPanel />

        <section>
          <h3 className="label">This installation</h3>
          <dl className="divide-y divide-line overflow-hidden rounded-lg border border-line text-sm">
            <Row label="Embeddings">
              {health ? (
                <span
                  className={
                    health.embeddings.state === 'ready' ? 'text-ink' : 'font-medium text-flag'
                  }
                >
                  {health.embeddings.provider}
                  {health.embeddings.state === 'ready'
                    ? ` · ${health.embeddings.dim} dimensions`
                    : ' · unavailable'}
                </span>
              ) : (
                <span className="text-faint">checking…</span>
              )}
            </Row>
            <Row label="Vector search">
              <span>{health?.vectorIndex ?? '…'}</span>
            </Row>
            <Row label="Your data">
              <span className="break-all font-mono text-xs">{health?.dataDir ?? '…'}</span>
            </Row>
          </dl>
          {health?.embeddings.state === 'unavailable' && (
            <p className="mt-2 rounded-lg border border-flag/30 bg-flag-soft px-3 py-2 text-xs leading-relaxed text-flag">
              {health.embeddings.reason}
            </p>
          )}
          <p className="mt-2 text-xs leading-relaxed text-muted">
            To change the embedding model, chunk size or port, edit the{' '}
            <code className="rounded bg-line/60 px-1 py-0.5 font-mono">.env</code> file in the
            project folder and restart. They are not switches here because changing them alters
            what gets written, and flipping one mid-term would leave your existing material
            inconsistent with everything ingested after it.
          </p>
        </section>

        <section>
          <h3 className="label">Maintenance</h3>
          <div className="rounded-lg border border-line p-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Backfill missing embeddings</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  Fills in vectors for anything ingested while the model could not be reached.
                  Safe to run at any time.
                </p>
              </div>
              <button
                className="btn shrink-0"
                onClick={() => backfill.mutate()}
                disabled={backfill.isPending}
              >
                <Icon name="refresh" size={15} />
                {backfill.isPending ? 'Working…' : 'Run'}
              </button>
            </div>
          </div>
        </section>

        <section>
          <h3 className="label">Keyboard</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            <Shortcut keys="Ctrl / ⌘ K" action="Search everything" />
            <Shortcut keys="Ctrl / ⌘ ," action="Open settings" />
            <Shortcut keys="Ctrl / ⌘ B" action="Show or hide the sidebar" />
            <Shortcut keys="Esc" action="Close this" />
          </dl>
        </section>
      </div>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 bg-panel px-3 py-2">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Shortcut({ keys, action }: { keys: string; action: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{action}</dt>
      <dd>
        <kbd className="whitespace-nowrap rounded border border-line bg-canvas px-1.5 py-0.5 font-mono text-2xs">
          {keys}
        </kbd>
      </dd>
    </div>
  );
}
