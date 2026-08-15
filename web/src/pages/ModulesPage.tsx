import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { Icon } from '../components/ui/Icon';
import { useToast } from '../components/ui/Toast';

/**
 * The home screen.
 *
 * Modules live in the sidebar now, so this is a landing page rather than the
 * only way in: an overview of everything, and the place to create the first
 * module when the sidebar is still empty.
 */
export function ModulesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');

  const { data: modules, isLoading } = useQuery({ queryKey: ['modules'], queryFn: api.listModules });

  const restoreRef = useRef<HTMLInputElement>(null);

  const restore = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.importModule(form);
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries();
      toast.success(
        result.remapped ? `Restored as "${result.title} (restored)"` : `Restored ${result.title}`,
        [
          `${result.sections} sections, ${result.sources} sources, ${result.noteBlocks} note blocks.`,
          result.missingFiles.length
            ? `${result.missingFiles.length} file(s) were missing from the archive.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
      navigate(`/modules/${result.moduleId}`);
    },
    onError: (error: Error) => toast.error('Could not restore that backup', error.message),
  });

  const create = useMutation({
    mutationFn: () =>
      api.createModule({ title: title.trim(), ...(code.trim() ? { code: code.trim() } : {}) }),
    onSuccess: (module) => {
      setTitle('');
      setCode('');
      queryClient.invalidateQueries({ queryKey: ['modules'] });
      toast.success(`Added ${module.title}`);
      navigate(`/modules/${module.id}`);
    },
    onError: (error: Error) => toast.error('Could not add the module', error.message),
  });

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Modules</h1>
        <p className="mt-1 text-sm text-muted">
          A module holds a section hierarchy and the sources that feed it.
        </p>
      </header>

      <form
        className="card mt-6 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <div className="flex items-end gap-3">
          <div className="w-36">
            <label className="label" htmlFor="module-code">
              Code
            </label>
            <input
              id="module-code"
              className="input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="PA20345"
            />
          </div>
          <div className="flex-1">
            <label className="label" htmlFor="module-title">
              Title
            </label>
            <input
              id="module-title"
              className="input"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Neuroscience"
            />
          </div>
          <button className="btn btn-primary" disabled={!title.trim() || create.isPending}>
            <Icon name="plus" size={15} />
            Add module
          </button>
        </div>
      </form>

      <div className="mt-3 flex items-center gap-3">
        <input
          ref={restoreRef}
          type="file"
          accept=".zip"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) restore.mutate(file);
            if (restoreRef.current) restoreRef.current.value = '';
          }}
        />
        <button
          className="btn"
          onClick={() => restoreRef.current?.click()}
          disabled={restore.isPending}
        >
          <Icon name="refresh" size={14} />
          {restore.isPending ? 'Restoring…' : 'Restore from a backup'}
        </button>
        <span className="text-xs text-muted">
          Back up any module from its own page. A backup is one zip holding everything.
        </span>
      </div>

      <div className="mt-8 space-y-2">
        {isLoading && (
          <>
            <div className="skeleton h-[4.5rem]" />
            <div className="skeleton h-[4.5rem]" />
          </>
        )}

        {modules?.length === 0 && (
          <div className="card px-6 py-12 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name="book" size={20} />
            </span>
            <h2 className="mt-3 font-medium">No modules yet</h2>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
              Add one above. Then give it a section hierarchy and start feeding in lecture
              slides, transcripts and textbook pages.
            </p>
          </div>
        )}

        {modules?.map((module) => (
          <Link
            key={module.id}
            to={`/modules/${module.id}`}
            className="card group flex items-center gap-4 p-4 transition hover:border-accent/40 hover:shadow-raised"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name="book" size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                {module.code && (
                  <span className="font-mono text-xs text-muted">{module.code}</span>
                )}
                <span className="truncate font-medium">{module.title}</span>
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {module.sectionCount ?? 0} sections · {module.sourceCount ?? 0} sources
              </div>
            </div>
            <Icon
              name="chevronRight"
              size={16}
              className="text-faint transition group-hover:translate-x-0.5 group-hover:text-accent"
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
