import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, type Module } from '../lib/api';
import { Icon } from './ui/Icon';
import { useConfirm } from './ui/Confirm';
import { useToast } from './ui/Toast';

/**
 * Your modules, always in the sidebar.
 *
 * Switching module used to mean navigating back to a list page in the middle of
 * the screen, which is a strange thing to have to do for the top level of your
 * own degree. They live here now, so any module is one click away from
 * anywhere, and the active one stays visible above its section tree.
 */
export function ModuleList({ collapsed }: { collapsed: boolean }) {
  const { moduleId } = useParams<{ moduleId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');

  const { data: modules, isLoading } = useQuery({ queryKey: ['modules'], queryFn: api.listModules });

  const create = useMutation({
    mutationFn: () =>
      api.createModule({ title: title.trim(), ...(code.trim() ? { code: code.trim() } : {}) }),
    onSuccess: (module) => {
      setTitle('');
      setCode('');
      setAdding(false);
      queryClient.invalidateQueries({ queryKey: ['modules'] });
      toast.success(`Added ${module.title}`);
      navigate(`/modules/${module.id}`);
    },
    onError: (error: Error) => toast.error('Could not add the module', error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteModule(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['modules'] });
      if (id === moduleId) navigate('/');
      toast.success('Module deleted');
    },
    onError: (error: Error) => toast.error('Could not delete the module', error.message),
  });

  const askThenDelete = async (module: Module) => {
    const confirmed = await confirm({
      title: `Delete ${module.title}?`,
      message:
        'This removes the module, its whole section hierarchy, every note in it and all ' +
        'ingested sources. It cannot be undone.',
      confirmLabel: 'Delete module',
      tone: 'danger',
    });
    if (confirmed) remove.mutate(module.id);
  };

  if (collapsed) {
    // Rail mode: initials only, still switchable.
    return (
      <div className="flex flex-col items-center gap-1 py-2">
        {modules?.map((module) => (
          <button
            key={module.id}
            onClick={() => navigate(`/modules/${module.id}`)}
            title={[module.code, module.title].filter(Boolean).join(' · ')}
            className={`flex h-9 w-9 items-center justify-center rounded-lg text-2xs font-semibold transition ${
              module.id === moduleId
                ? 'bg-accent text-accent-ink'
                : 'text-muted hover:bg-line/50 hover:text-ink'
            }`}
          >
            {initials(module)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="pb-1">
      <div className="rail-heading">
        <span>Modules</span>
        <button
          className="btn-icon h-6 w-6"
          onClick={() => setAdding((previous) => !previous)}
          aria-label={adding ? 'Cancel' : 'Add a module'}
          title={adding ? 'Cancel' : 'Add a module'}
        >
          <Icon name={adding ? 'close' : 'plus'} size={15} />
        </button>
      </div>

      {adding && (
        <form
          className="mx-2 mb-2 space-y-1.5 rounded-lg border border-line bg-canvas p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (title.trim()) create.mutate();
          }}
        >
          <input
            autoFocus
            className="input py-1 text-xs"
            placeholder="Code (optional)"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <input
            className="input py-1 text-xs"
            placeholder="Module title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <button
            className="btn btn-primary btn-sm w-full"
            disabled={!title.trim() || create.isPending}
          >
            {create.isPending ? 'Adding…' : 'Add module'}
          </button>
        </form>
      )}

      {isLoading && (
        <div className="space-y-1 px-2">
          <div className="skeleton h-7" />
          <div className="skeleton h-7 w-4/5" />
        </div>
      )}

      {modules?.length === 0 && !adding && (
        <p className="px-3 pb-2 text-xs leading-relaxed text-muted">
          No modules yet. Add your first one with the + above.
        </p>
      )}

      <ul className="space-y-0.5 px-2">
        {modules?.map((module) => {
          const active = module.id === moduleId;
          return (
            <li key={module.id} className="group/module relative">
              <button
                onClick={() => navigate(`/modules/${module.id}`)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                  active ? 'bg-accent-soft text-accent' : 'hover:bg-line/40'
                }`}
              >
                <Icon
                  name="book"
                  size={15}
                  className={active ? 'text-accent' : 'text-faint'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium leading-tight">
                    {module.title}
                  </span>
                  <span className="mt-0.5 block truncate text-2xs text-muted">
                    {module.code ? `${module.code} · ` : ''}
                    {module.sectionCount ?? 0} sections · {module.sourceCount ?? 0} sources
                  </span>
                </span>
              </button>

              <button
                onClick={() => askThenDelete(module)}
                className="btn-icon absolute right-1 top-1.5 h-6 w-6 opacity-0 transition group-hover/module:opacity-100 hover:text-flag focus-visible:opacity-100"
                aria-label={`Delete ${module.title}`}
                title="Delete module"
              >
                <Icon name="trash" size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function initials(module: Module): string {
  if (module.code) return module.code.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
  return module.title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}
