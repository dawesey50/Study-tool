import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, flattenSections } from '../lib/api';
import { HierarchyProposal } from '../components/HierarchyProposal';
import { RestorePoints } from '../components/RestorePoints';
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
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const [outline, setOutline] = useState('');
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [proposeOpen, setProposeOpen] = useState(false);

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

  /**
   * One section, straight away.
   *
   * Notes live inside a section, so a module with none has nowhere to write —
   * and offering only "paste an outline" made the first note conditional on
   * having your handbook to hand. It lands you in the new section's editor,
   * because adding it was never the thing you wanted.
   */
  const addSection = useMutation({
    mutationFn: () => api.createSection({ moduleId: moduleId!, title: 'Untitled section' }),
    onSuccess: (section) => {
      queryClient.invalidateQueries({ queryKey: ['sections', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['modules'] });
      navigate(`/modules/${moduleId}/sections/${section.id}`);
    },
    onError: (error: Error) => toast.error('Could not add a section', error.message),
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
        <div className="flex shrink-0 gap-2">
          <a
            className="btn"
            href={api.exportModuleUrl(moduleId!)}
            title="Download this module — rows, embeddings and every file — as one zip"
          >
            <Icon name="file" size={15} />
            Back up
          </a>
          <Link className="btn btn-primary" to={`/modules/${moduleId}/sources`}>
            <Icon name="upload" size={15} />
            Add sources
          </Link>
        </div>
      </header>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <Stat icon="layers" label="Sections" value={sections.length} />
        <Stat icon="file" label="Sources" value={sources?.length ?? 0} />
        <Stat icon="check" label="Ingested" value={ingested} />
      </div>

      <section className="mt-10">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">Hierarchy</h2>
          <div className="flex gap-2">
            <button
              className="btn btn-sm"
              onClick={() => setProposeOpen(true)}
              disabled={ingested === 0}
              title={
                ingested === 0
                  ? 'Upload and ingest the lecture material first — the structure is read off it'
                  : 'Propose a hierarchy from this module’s material'
              }
            >
              <Icon name="sparkle" size={13} />
              Propose from material
            </button>
            <button className="btn btn-sm" onClick={() => setOutlineOpen(true)}>
              <Icon name="edit" size={13} />
              Paste an outline
            </button>
          </div>
        </div>

        {sections.length === 0 ? (
          <div className="card mt-3 px-6 py-10 text-center">
            <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
              <Icon name="layers" size={20} />
            </span>
            <h3 className="mt-3 font-medium">No sections yet</h3>
            <p className="mx-auto mt-1 max-w-sm text-sm leading-relaxed text-muted">
              Sections are the organising unit — a place in the syllabus, rather than one
              lecture. <strong className="font-medium text-ink">Your notes live inside a
              section</strong>, so you need at least one before you can write anything.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              {ingested > 0 && (
                <button className="btn btn-primary" onClick={() => setProposeOpen(true)}>
                  <Icon name="sparkle" size={15} />
                  Propose from material
                </button>
              )}
              <button
                className={ingested > 0 ? 'btn' : 'btn btn-primary'}
                onClick={() => addSection.mutate()}
                disabled={addSection.isPending}
              >
                <Icon name="plus" size={15} />
                {addSection.isPending ? 'Adding…' : 'Add a section'}
              </button>
              <button className="btn" onClick={() => setOutlineOpen(true)}>
                <Icon name="edit" size={14} />
                Paste an outline
              </button>
            </div>
            <p className="mx-auto mt-3 max-w-sm text-xs leading-relaxed text-muted">
              {ingested > 0
                ? 'Proposing reads the titles and opening slides of what you have uploaded and ' +
                  'suggests a structure — nothing changes until you accept it. Or paste your ' +
                  'handbook outline, or add one section and grow the tree as you go.'
                : 'One section is enough to start. Paste your handbook outline instead if you ' +
                  'want the whole tree in one go — you can rename, add and drag sections at any ' +
                  'time.'}
            </p>
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

      <RestorePoints moduleId={moduleId!} />

      <HierarchyProposal
        moduleId={moduleId!}
        open={proposeOpen}
        onClose={() => setProposeOpen(false)}
      />

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
