import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, flattenSections } from '../lib/api';

/**
 * Module overview, and the place to type a hierarchy out by hand.
 *
 * The spec's default flow is an LLM proposing the tree from lecture titles and
 * learning outcomes, which arrives in Phase 2. Until then this covers the other
 * two supported routes: paste a handbook outline, or grow the tree as you go.
 */
export function ModulePage() {
  const { moduleId } = useParams<{ moduleId: string }>();
  const queryClient = useQueryClient();
  const [outline, setOutline] = useState('');
  const [showOutline, setShowOutline] = useState(false);

  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });

  const { data: sources } = useQuery({
    queryKey: ['sources', moduleId],
    queryFn: () => api.listSources(moduleId!),
    enabled: Boolean(moduleId),
  });

  const applyOutline = useMutation({
    mutationFn: () => api.replaceTree(moduleId!, parseOutline(outline)),
    onSuccess: () => {
      setOutline('');
      setShowOutline(false);
      queryClient.invalidateQueries({ queryKey: ['sections', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
    },
  });

  if (!module) return <div className="p-8 text-sm text-muted">Loading…</div>;

  const sections = flattenSections(module.sections);
  const ingested = sources?.filter((source) => source.status === 'ingested').length ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">
        {module.code && <span className="mr-2 font-mono text-lg text-muted">{module.code}</span>}
        {module.title}
      </h1>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat label="Sections" value={sections.length} />
        <Stat label="Sources" value={sources?.length ?? 0} />
        <Stat label="Ingested" value={ingested} />
      </div>

      <div className="mt-8 flex gap-2">
        <Link className="btn" to={`/modules/${moduleId}/sources`}>
          Add sources
        </Link>
        <button className="btn" onClick={() => setShowOutline((previous) => !previous)}>
          {showOutline ? 'Cancel' : 'Paste an outline'}
        </button>
      </div>

      {showOutline && (
        <div className="card mt-4 p-4">
          <label className="label" htmlFor="outline">
            Section outline
          </label>
          <p className="mb-2 text-xs text-muted">
            One section per line. Indent with two spaces or a tab to nest. Any leading numbering
            is ignored, because numbers are derived from position rather than stored.
          </p>
          <textarea
            id="outline"
            className="input h-56 font-mono text-xs"
            value={outline}
            onChange={(event) => setOutline(event.target.value)}
            placeholder={EXAMPLE_OUTLINE}
          />
          <div className="mt-3 flex items-center gap-3">
            <button
              className="btn btn-primary"
              disabled={!outline.trim() || applyOutline.isPending}
              onClick={() => applyOutline.mutate()}
            >
              Replace hierarchy
            </button>
            <span className="text-xs text-muted">
              Sections not in the outline are removed, along with their notes.
            </span>
          </div>
          {applyOutline.error && (
            <p className="mt-2 text-sm text-flag">{(applyOutline.error as Error).message}</p>
          )}
        </div>
      )}

      <h2 className="mt-10 text-sm font-semibold uppercase tracking-wide text-muted">Hierarchy</h2>
      {sections.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          Nothing here yet. Paste an outline above, or add sections in the sidebar.
        </p>
      ) : (
        <ul className="mt-2">
          {sections.map((section) => (
            <li key={section.id} style={{ paddingLeft: `${(section.depth - 1) * 16}px` }}>
              <Link
                to={`/modules/${moduleId}/sections/${section.id}`}
                className="flex items-baseline gap-2 rounded px-2 py-1 hover:bg-panel"
              >
                <span className="font-mono text-xs text-muted">{section.number}</span>
                <span>{section.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs uppercase tracking-wide text-muted">{label}</div>
    </div>
  );
}

const EXAMPLE_OUTLINE = `The Brain
  Gross anatomy and organisation
  The cerebral cortex
    Cortical layers
    Functional areas
The Spinal Cord
  Structure and tracts`;

interface OutlineNode {
  title: string;
  children: OutlineNode[];
}

/** Indentation-based outline into a nested tree. */
export function parseOutline(text: string): OutlineNode[] {
  const roots: OutlineNode[] = [];
  // Stack of open ancestors, indexed by their indent depth.
  const stack: Array<{ indent: number; node: OutlineNode }> = [];

  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;

    const leading = raw.match(/^[\t ]*/)?.[0] ?? '';
    // A tab counts as one level; spaces count in pairs.
    const indent = leading.replace(/\t/g, '  ').length >> 1;
    const title = raw.trim().replace(/^[\d.]+\s+/, '');
    if (!title) continue;

    const node: OutlineNode = { title, children: [] };
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();

    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(node);
    else roots.push(node);

    stack.push({ indent, node });
  }

  return roots;
}
