import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type HierarchyProposal as Proposal, type ProposedSection } from '../lib/api';
import { Icon } from './ui/Icon';
import { Modal } from './ui/Modal';
import { useConfirm } from './ui/Confirm';
import { useToast } from './ui/Toast';

/**
 * The hierarchy a model proposes from your material — §4's default flow.
 *
 * Proposing and applying are two steps, and the gap between them is the whole
 * design. Applying deletes any section the proposal leaves out, along with
 * every note inside it, so a hierarchy that arrived and rearranged a term's
 * work by itself would be the most destructive thing in the system — worse
 * than a bad generation run, because a restore point is taken before
 * generation and nothing would be taken before this.
 *
 * So the proposal is shown, with the reason for each section, with sections
 * that already exist marked as staying, and with anything that would be lost
 * named before you can press the button.
 */
export function HierarchyProposal({
  moduleId,
  open,
  onClose,
}: {
  moduleId: string;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  const [proposal, setProposal] = useState<Proposal | null>(null);

  const propose = useMutation({
    mutationFn: () => api.proposeHierarchy(moduleId),
    onSuccess: setProposal,
    onError: (error: Error) => toast.error('Could not propose a hierarchy', error.message),
  });

  const apply = useMutation({
    mutationFn: (sections: ProposedSection[]) => api.applyHierarchy(moduleId, sections),
    onSuccess: (tree) => {
      queryClient.invalidateQueries({ queryKey: ['sections', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['modules'] });
      toast.success(`Hierarchy applied — ${count(tree)} sections`);
      setProposal(null);
      onClose();
    },
    onError: (error: Error) => toast.error('Could not apply that hierarchy', error.message),
  });

  const onApply = async () => {
    if (!proposal) return;

    // Asked fresh rather than reusing what the proposal reported: notes may
    // have been written since, and this is the last point at which it is
    // cheap to find out.
    const { atRisk } = await api.previewHierarchy(moduleId, proposal.sections);

    if (atRisk.length > 0) {
      const total = atRisk.reduce((sum, entry) => sum + entry.blocks, 0);
      const go = await confirm({
        title: `Delete ${total} block${total === 1 ? '' : 's'} of notes?`,
        message:
          `These sections are not in the proposal and would be deleted with everything in ` +
          `them:\n\n${atRisk
            .map((entry) => `· ${entry.sectionPath} — ${entry.blocks} blocks`)
            .join('\n')}\n\nThere is no restore point for this.`,
        confirmLabel: 'Apply anyway',
        tone: 'danger',
      });
      if (!go) return;
    }

    apply.mutate(proposal.sections);
  };

  return (
    <Modal open={open} onClose={onClose} title="Propose a hierarchy">
      {!proposal ? (
        <div>
          <p className="text-sm leading-relaxed text-muted">
            Reads the titles and opening slides of this module’s material and proposes the
            structure it actually has. Past papers are left out — they say what was examined, not
            how the module was taught.
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted">
            Nothing is changed until you accept it. One cheap model call: it is sent an outline,
            not the whole of every document.
          </p>
          <button
            className="btn btn-primary mt-4"
            onClick={() => propose.mutate()}
            disabled={propose.isPending}
          >
            <Icon name="sparkle" size={14} className="mr-1" />
            {propose.isPending ? 'Reading the material…' : 'Propose'}
          </button>
        </div>
      ) : (
        <div>
          <p className="text-xs text-muted">
            From {proposal.sourcesConsidered.length} source
            {proposal.sourcesConsidered.length === 1 ? '' : 's'}
            {proposal.costUsd > 0 ? ` · $${proposal.costUsd.toFixed(4)}` : ''}
          </p>

          <ul className="mt-3 space-y-1.5">
            {proposal.sections.map((section) => (
              <ProposedRow key={section.title} section={section} depth={0} />
            ))}
          </ul>

          {proposal.wouldRemove.length > 0 && (
            <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
              <p className="text-xs font-medium">
                These sections are not in the proposal and would be deleted:
              </p>
              <ul className="mt-1 text-xs text-muted">
                {proposal.wouldRemove.map((title) => (
                  <li key={title}>· {title}</li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-muted">
                Anything written in them goes too, and there is no restore point for this.
              </p>
            </div>
          )}

          <div className="mt-5 flex gap-2">
            <button className="btn btn-primary" onClick={onApply} disabled={apply.isPending}>
              {apply.isPending ? 'Applying…' : 'Apply this hierarchy'}
            </button>
            <button className="btn" onClick={() => propose.mutate()} disabled={propose.isPending}>
              Propose again
            </button>
            <button className="btn" onClick={() => setProposal(null)}>
              Back
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ProposedRow({ section, depth }: { section: ProposedSection; depth: number }) {
  return (
    <>
      <li className="text-sm" style={{ marginLeft: `${depth * 18}px` }}>
        <span className="font-medium">{section.title}</span>
        {section.existing && (
          <span className="ml-2 rounded bg-line px-1.5 py-0.5 text-[11px] text-muted">
            already exists — kept, with its notes
          </span>
        )}
        {section.rationale && (
          <span className="mt-0.5 block text-xs text-muted">{section.rationale}</span>
        )}
      </li>
      {section.children?.map((child) => (
        <ProposedRow key={child.title} section={child} depth={depth + 1} />
      ))}
    </>
  );
}

function count(nodes: Array<{ children: unknown[] }>): number {
  return nodes.reduce(
    (total, node) => total + 1 + count(node.children as Array<{ children: unknown[] }>),
    0,
  );
}
