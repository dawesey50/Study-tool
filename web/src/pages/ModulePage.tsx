import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, flattenSections } from '../lib/api';
import { Icon } from '../components/ui/Icon';
import { Modal } from '../components/ui/Modal';
import { useConfirm } from '../components/ui/Confirm';
import { useToast } from '../components/ui/Toast';

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
  const toast = useToast();
  const confirm = useConfirm();
  const [outline, setOutline] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(false);

  const { data: module, isLoading } = useQuery({
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
    onSuccess: (tree) => {
      setOutline('');
      setOutlineOpen(false);
      queryClient.invalidateQueries({ queryKey: ['sections', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['modules'] });
      toast.success(`Hierarchy saved — ${flattenSections(tree).length} sections`);
    },
    onError: (error: Error) => toast.error('Could not save the hierarchy', error.message),
  });

  const submitOutline = async () => {
    const existing = module ? flattenSections(module.sections).length : 0;
    if (existing > 0) {
      const confirmed = await confirm({
        title: 'Replace the whole hierarchy?',
        message:
          `This module has ${existing} section${existing === 1 ? '' : 's'}. Any not present in ` +
          'your outline will be deleted, along with the notes inside them.',
        confirmLabel: 'Replace hierarchy',
        tone: 'danger',
      });
      if (!confirmed) return;
    }
    applyOutline.mutate();
  };

  if (isLoading || !module) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 px-8 py-12">
        <div className="skeleton h-8 w-1/2" />
        <div className="skeleton h-24" />
      </div>
    );
  }

  const sections = flattenSections(module.sections);
  const ingested = sources?.filter((source) => source.status === 'ingested').length ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-8 py-12">
      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{module.title}</h1>
          <p className="mt-1 text-sm text-muted">
            {module.code && <span className="font-mono">{module.code}</span>}
            {module.code && module.year ? ' · ' : ''}
            {module.year ? `Year ${module.year}` : ''}
          </p>
        </div>
        <Link className="btn btn-primary shrink-0" to={`/modules/${moduleId}/sources`}>
          <Icon name="upload" size={15} />
          Add sources
        </Link>
      </header>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat icon="layers" label="Sections" value={sections.length} />
        <Stat icon="file" label="Sources" value={sources?.length ?? 0} />
        <Stat icon="check" label="Ingested" value={ingested} />
      </div>

      <section className="mt-10">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Hierarchy</h2>
          <button className="btn btn-sm" onClick={() => setOutlineOpen(true)}>
            <Icon name="edit" size={13} />
            Paste an outline
          </button>
        </div>

        {sections.length === 0 ? (
          <div className="card mt-3 px-6 py-10 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name="layers" size={20} />
            </span>
            <h3 className="mt-3 font-medium">No sections yet</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
              Sections are the organising unit — a place in the syllabus, rather than one
              lecture. Paste your module handbook outline to build the tree in one go.
            </p>
            <button className="btn btn-primary mt-4" onClick={() => setOutlineOpen(true)}>
              Paste an outline
            </button>
          </div>
        ) : (
          <ul className="mt-3 overflow-hidden rounded-xl border border-line bg-panel">
            {sections.map((section) => (
              <li key={section.id} className="border-b border-line last:border-b-0">
                <Link
                  to={`/modules/${moduleId}/sections/${section.id}`}
                  className="flex items-baseline gap-3 px-3 py-2 transition hover:bg-canvas"
                  style={{ paddingLeft: `${12 + (section.depth - 1) * 18}px` }}
                >
                  <span className="shrink-0 font-mono text-xs tabular-nums text-faint">
                    {section.number}
                  </span>
                  <span className="truncate text-sm">{section.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal
        open={outlineOpen}
        onClose={() => setOutlineOpen(false)}
        title="Paste a section outline"
        description="One section per line. Indent with two spaces or a tab to nest."
        width="max-w-2xl"
        footer={
          <>
            <button className="btn" onClick={() => setOutlineOpen(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={!outline.trim() || applyOutline.isPending}
              onClick={submitOutline}
            >
              {applyOutline.isPending ? 'Saving…' : 'Replace hierarchy'}
            </button>
          </>
        }
      >
        <textarea
          id="outline"
          className="input h-64 resize-none font-mono text-xs leading-relaxed"
          value={outline}
          onChange={(event) => setOutline(event.target.value)}
          placeholder={EXAMPLE_OUTLINE}
        />
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Leading numbering is ignored — numbers are derived from position, so reordering the
          tree later renumbers everything automatically without breaking any links.
        </p>
      </Modal>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: 'layers' | 'file' | 'check';
  label: string;
  value: number;
}) {
  return (
    <div className="card p-4">
      <span className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted">
        <Icon name={icon} size={13} />
        {label}
      </span>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
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
