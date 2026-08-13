import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { api, flattenSections, type SectionNode } from '../lib/api';
import { Icon } from './ui/Icon';
import { useToast } from './ui/Toast';

/**
 * The section hierarchy, always visible.
 *
 * Drag and drop moves a section; the numbers you see are recomputed by the
 * server from tree position on every read, so a move renumbers everything
 * below it without touching a single stored identifier.
 */
export function SectionTree({ moduleId }: { moduleId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { sectionId: activeId } = useParams<{ sectionId: string }>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Which section is being dragged is a ref rather than state: it is read
  // inside the drop handler and never rendered, and holding it in state would
  // make the drop depend on a re-render having already committed.
  const dragId = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; where: DropWhere } | null>(null);

  const { data: sections, isLoading } = useQuery({
    queryKey: ['sections', moduleId],
    queryFn: () => api.getSections(moduleId),
  });

  const move = useMutation({
    mutationFn: ({ id, parentId, position }: { id: string; parentId: string | null; position: number }) =>
      api.moveSection(id, parentId, position),
    onSuccess: (tree) => {
      queryClient.setQueryData(['sections', moduleId], tree);
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
    },
    onError: (error: Error) => toast.error('Could not move that section', error.message),
  });

  const create = useMutation({
    mutationFn: (parentId: string | null) =>
      api.createSection({ moduleId, title: 'New section', parentId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['sections', moduleId] });
      queryClient.invalidateQueries({ queryKey: ['modules'] });
    },
    onError: (error: Error) => toast.error('Could not add a section', error.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-1 px-2 py-1">
        <div className="skeleton h-6" />
        <div className="skeleton ml-3 h-6" />
        <div className="skeleton ml-3 h-6 w-4/5" />
      </div>
    );
  }

  if (!sections?.length) {
    return (
      <div className="space-y-2 px-2 py-1">
        <p className="text-xs leading-relaxed text-muted">
          No sections yet. Paste an outline on the module page, or start one here.
        </p>
        <button className="btn btn-sm w-full" onClick={() => create.mutate(null)}>
          <Icon name="plus" size={13} />
          Add first section
        </button>
      </div>
    );
  }

  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleDrop = (target: SectionNode, where: DropWhere) => {
    const id = dragId.current;
    dragId.current = null;
    setDropTarget(null);
    if (!id || id === target.id) return;

    // Dropping onto a section makes it the first child; dropping on the edges
    // places it before or after that section among its siblings.
    const parentId = where === 'into' ? target.id : target.parentId;
    const position = where === 'into' ? 0 : target.position + (where === 'after' ? 1 : 0);
    move.mutate({ id, parentId, position });
  };

  const rows = (nodes: SectionNode[]): JSX.Element[] =>
    nodes.flatMap((node) => {
      const isCollapsed = collapsed.has(node.id);
      const row = (
        <TreeRow
          key={node.id}
          node={node}
          moduleId={moduleId}
          active={node.id === activeId}
          collapsed={isCollapsed}
          dropTarget={dropTarget?.id === node.id ? dropTarget.where : null}
          onToggle={() => toggle(node.id)}
          onDragStart={() => {
            dragId.current = node.id;
          }}
          onDragEnd={() => {
            dragId.current = null;
            setDropTarget(null);
          }}
          onDragOver={(where) => setDropTarget({ id: node.id, where })}
          onDrop={(where) => handleDrop(node, where)}
        />
      );
      return isCollapsed ? [row] : [row, ...rows(node.children)];
    });

  return (
    <div className="space-y-px">
      {rows(sections)}

      <button
        className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted transition hover:bg-line/40 hover:text-ink"
        onClick={() => create.mutate(null)}
      >
        <Icon name="plus" size={13} />
        Add section
      </button>

      <p className="px-2 pt-1 text-2xs text-faint">
        {flattenSections(sections).length} sections · drag to reorder
      </p>
    </div>
  );
}

type DropWhere = 'before' | 'into' | 'after';

interface TreeRowProps {
  node: SectionNode;
  moduleId: string;
  active: boolean;
  collapsed: boolean;
  dropTarget: DropWhere | null;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOver: (where: DropWhere) => void;
  onDrop: (where: DropWhere) => void;
}

function TreeRow({
  node,
  moduleId,
  active,
  collapsed,
  dropTarget,
  onToggle,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: TreeRowProps) {
  const hasChildren = node.children.length > 0;

  // Where in the row the pointer sits decides whether this is a reorder or a
  // reparent: the edges mean "beside", the middle means "inside".
  const whereFrom = (event: React.DragEvent<HTMLDivElement>): DropWhere => {
    const box = event.currentTarget.getBoundingClientRect();
    const offset = (event.clientY - box.top) / box.height;
    if (offset < 0.28) return 'before';
    if (offset > 0.72) return 'after';
    return 'into';
  };

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move';
        // Firefox refuses to start a drag without payload.
        event.dataTransfer.setData('text/plain', node.id);
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        onDragOver(whereFrom(event));
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop(whereFrom(event));
      }}
      className={[
        'group relative rounded-lg',
        dropTarget === 'into' ? 'bg-accent-soft ring-1 ring-inset ring-accent' : '',
        dropTarget === 'before' ? 'shadow-[inset_0_2px_0_0_rgb(var(--accent))]' : '',
        dropTarget === 'after' ? 'shadow-[inset_0_-2px_0_0_rgb(var(--accent))]' : '',
      ].join(' ')}
      style={{ paddingLeft: `${(node.depth - 1) * 11}px` }}
    >
      <div
        className={`flex items-center gap-0.5 rounded-lg pr-1.5 transition ${
          active ? 'bg-accent-soft' : 'hover:bg-line/40'
        }`}
      >
        <button
          onClick={onToggle}
          className={`flex h-6 w-5 shrink-0 items-center justify-center text-faint transition hover:text-ink ${
            hasChildren ? '' : 'pointer-events-none opacity-0'
          }`}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
          tabIndex={hasChildren ? 0 : -1}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={13} />
        </button>

        <NavLink
          to={`/modules/${moduleId}/sections/${node.id}`}
          className={`flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-sm ${
            active ? 'font-medium text-accent' : ''
          }`}
          title={`${node.number} ${node.title}`}
        >
          <span
            className={`shrink-0 font-mono text-2xs tabular-nums ${active ? 'text-accent' : 'text-faint'}`}
          >
            {node.number}
          </span>
          <span className="truncate">{node.title}</span>
        </NavLink>

        <StatusDot status={node.status} />
      </div>
    </div>
  );
}

/**
 * Phase 1 shows the section's own status. Phase 2 replaces this with the
 * coverage badge and Phase 4 adds mastery, both of which roll up the tree.
 */
function StatusDot({ status }: { status: SectionNode['status'] }) {
  const styles: Record<SectionNode['status'], string> = {
    empty: 'bg-transparent ring-1 ring-line',
    drafted: 'bg-warn',
    edited: 'bg-accent',
    complete: 'bg-accent',
  };
  const labels: Record<SectionNode['status'], string> = {
    empty: 'Nothing written yet',
    drafted: 'Draft notes',
    edited: 'You have edited these notes',
    complete: 'Marked complete',
  };
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles[status]}`}
      title={labels[status]}
    />
  );
}
