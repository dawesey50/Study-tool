import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useParams } from 'react-router-dom';
import { api } from './lib/api';
import { SectionTree } from './components/SectionTree';
import { GlobalSearch } from './components/GlobalSearch';

export function App() {
  const { moduleId } = useParams<{ moduleId: string }>();

  const { data: health } = useQuery({ queryKey: ['health'], queryFn: api.health });
  const { data: modules } = useQuery({ queryKey: ['modules'], queryFn: api.listModules });

  const activeModule = modules?.find((module) => module.id === moduleId);

  return (
    <div className="flex h-full">
      <aside className="flex w-80 shrink-0 flex-col border-r border-line bg-panel">
        <div className="border-b border-line px-4 py-3">
          <Link to="/" className="block">
            <div className="font-semibold tracking-tight">Processor</div>
            <div className="text-xs text-muted">
              {activeModule
                ? [activeModule.code, activeModule.title].filter(Boolean).join(' · ')
                : 'Local-first study system'}
            </div>
          </Link>
        </div>

        <div className="border-b border-line p-3">
          <GlobalSearch moduleId={moduleId} />
        </div>

        {moduleId ? (
          <>
            <nav className="flex gap-1 border-b border-line px-3 py-2 text-sm">
              <Link
                to={`/modules/${moduleId}`}
                className="rounded px-2 py-1 hover:bg-canvas"
              >
                Sections
              </Link>
              <Link
                to={`/modules/${moduleId}/sources`}
                className="rounded px-2 py-1 hover:bg-canvas"
              >
                Sources
              </Link>
            </nav>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <SectionTree moduleId={moduleId} />
            </div>
          </>
        ) : (
          <div className="flex-1 p-4 text-sm text-muted">
            Choose a module to see its section hierarchy.
          </div>
        )}

        <StatusBar health={health} />
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The embedding provider is the one piece of infrastructure whose state
 * genuinely changes what the app can do — without vectors, search is
 * keyword-only and section mapping cannot run — so it is always visible
 * rather than buried in a settings page.
 */
function StatusBar({ health }: { health: Awaited<ReturnType<typeof api.health>> | undefined }) {
  if (!health) return null;

  const { embeddings } = health;

  if (embeddings.state === 'unavailable') {
    return (
      <div
        className="border-t border-flag/30 bg-flag-soft px-4 py-2 text-xs text-flag"
        title={embeddings.reason}
      >
        <div className="font-medium">Embeddings unavailable</div>
        <div className="mt-0.5 leading-snug">
          Material still ingests and keyword search still works. Run a backfill from the Sources
          page once the model can be reached.
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted">
      <span>{embeddings.provider}</span>
      <span>{health.vectorIndex}</span>
    </div>
  );
}
