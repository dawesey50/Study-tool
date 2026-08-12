import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

export function ModulesPage() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');

  const { data: modules, isLoading } = useQuery({ queryKey: ['modules'], queryFn: api.listModules });

  const create = useMutation({
    mutationFn: () =>
      api.createModule({ title: title.trim(), ...(code.trim() ? { code: code.trim() } : {}) }),
    onSuccess: () => {
      setTitle('');
      setCode('');
      queryClient.invalidateQueries({ queryKey: ['modules'] });
    },
  });

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Modules</h1>
      <p className="mt-1 text-sm text-muted">
        A module holds a section hierarchy and the sources that feed it.
      </p>

      <form
        className="card mt-6 flex items-end gap-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <div className="w-32">
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
          Add module
        </button>
      </form>

      {create.error && (
        <p className="mt-2 text-sm text-flag">{(create.error as Error).message}</p>
      )}

      <div className="mt-8 space-y-2">
        {isLoading && <p className="text-sm text-muted">Loading…</p>}
        {modules?.length === 0 && (
          <p className="text-sm text-muted">No modules yet. Add your first one above.</p>
        )}
        {modules?.map((module) => (
          <Link
            key={module.id}
            to={`/modules/${module.id}`}
            className="card flex items-center justify-between p-4 transition-colors hover:border-accent/40"
          >
            <div>
              <div className="font-medium">
                {module.code && <span className="mr-2 font-mono text-sm text-muted">{module.code}</span>}
                {module.title}
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {module.sectionCount ?? 0} sections · {module.sourceCount ?? 0} sources
              </div>
            </div>
            <span className="text-muted">→</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
