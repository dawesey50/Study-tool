import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import { api } from './lib/api';
import { useTheme } from './lib/theme';
import { GlobalSearch } from './components/GlobalSearch';
import { ModuleList } from './components/ModuleList';
import { SectionTree } from './components/SectionTree';
import { SettingsModal } from './components/SettingsModal';
import { Icon } from './components/ui/Icon';

export function App() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const { resolved, setTheme } = useTheme();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('processor.sidebar') === 'collapsed',
  );

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    // Cheap, and it is the one thing that tells you the backend is alive.
    refetchInterval: 30_000,
  });

  useEffect(() => {
    localStorage.setItem('processor.sidebar', collapsed ? 'collapsed' : 'expanded');
  }, [collapsed]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if (event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setCollapsed((previous) => !previous);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-full">
      <aside
        className={`flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200 ${
          collapsed ? 'w-14' : 'w-72'
        }`}
      >
        <header
          className={`flex items-center gap-2 border-b border-line px-3 py-2.5 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          {!collapsed && (
            <Link to="/" className="flex min-w-0 flex-1 items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-ink">
                <Icon name="layers" size={16} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold tracking-tight">
                  Processor
                </span>
              </span>
            </Link>
          )}
          <button
            className="btn-icon"
            onClick={() => setCollapsed((previous) => !previous)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={`${collapsed ? 'Expand' : 'Collapse'} sidebar  (Ctrl/⌘ B)`}
          >
            <Icon name="sidebar" size={17} />
          </button>
        </header>

        {!collapsed && (
          <div className="border-b border-line p-2.5">
            <GlobalSearch moduleId={moduleId} />
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ModuleList collapsed={collapsed} />

          {!collapsed && moduleId && (
            <>
              <div className="mt-1 border-t border-line" />
              <nav className="grid grid-cols-3 gap-1 px-2 py-2">
                <Link
                  to={`/modules/${moduleId}/revision`}
                  className="btn btn-sm justify-center"
                  title="What is due, and how well this module is known"
                >
                  <Icon name="refresh" size={14} className="mr-1" />
                  Revise
                </Link>
                <Link
                  to={`/modules/${moduleId}/practice`}
                  className="btn btn-sm justify-center"
                  title="Work through questions from this module"
                >
                  <Icon name="question" size={14} className="mr-1" />
                  Practise
                </Link>
                <Link
                  to={`/modules/${moduleId}/questions`}
                  className="btn btn-sm justify-center"
                  title="The question bank for this module"
                >
                  <Icon name="layers" size={14} className="mr-1" />
                  Bank
                </Link>
              </nav>
              <div className="border-t border-line" />
              <div className="rail-heading">
                <span>Sections</span>
                <Link
                  to={`/modules/${moduleId}/sources`}
                  className="btn-icon h-6 w-6"
                  title="Sources for this module"
                  aria-label="Sources for this module"
                >
                  <Icon name="upload" size={14} />
                </Link>
              </div>
              <div className="px-1 pb-3">
                <SectionTree moduleId={moduleId} />
              </div>
            </>
          )}

          {!collapsed && !moduleId && (
            <p className="px-3 py-3 text-xs leading-relaxed text-muted">
              Pick a module to see its section hierarchy.
            </p>
          )}
        </div>

        <footer className="border-t border-line">
          <StatusBar health={health} collapsed={collapsed} />
          <div
            className={`flex items-center gap-1 px-2 py-1.5 ${collapsed ? 'flex-col' : 'justify-end'}`}
          >
            <button
              className="btn-icon"
              onClick={() => setTheme(resolved === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle dark mode"
              title="Toggle dark mode"
            >
              <Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={16} />
            </button>
            <button
              className="btn-icon"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings  (Ctrl/⌘ ,)"
            >
              <Icon name="settings" size={16} />
            </button>
          </div>
        </footer>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

/**
 * The embedding provider is the one piece of infrastructure whose state changes
 * what the app can do, so it stays visible rather than hiding in settings.
 */
function StatusBar({
  health,
  collapsed,
}: {
  health: Awaited<ReturnType<typeof api.health>> | undefined;
  collapsed: boolean;
}) {
  if (!health) {
    return collapsed ? null : (
      <div className="px-3 py-1.5 text-2xs text-faint">Connecting…</div>
    );
  }

  const { embeddings } = health;
  const degraded = embeddings.state === 'unavailable';

  if (collapsed) {
    return (
      <div
        className="flex justify-center py-1.5"
        title={degraded ? 'Embeddings unavailable' : `${embeddings.provider} · ready`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${degraded ? 'bg-flag' : 'bg-accent'}`} />
      </div>
    );
  }

  if (embeddings.state === 'unavailable') {
    return (
      <div
        className="bg-flag-soft px-3 py-2 text-2xs leading-snug text-flag"
        title={embeddings.reason}
      >
        <span className="font-semibold">Embeddings unavailable.</span> Material still ingests and
        keyword search still works. Run a backfill from Settings once the model can be reached.
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between px-3 py-1.5 text-2xs text-faint">
      <span className="truncate" title={`Embedding model: ${health.embeddings.provider}`}>
        {health.embeddings.provider}
      </span>
      <span className="shrink-0">{health.vectorIndex}</span>
    </div>
  );
}
