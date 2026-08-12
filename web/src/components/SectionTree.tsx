import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import { api, flattenSections, type SectionNode } from '../lib/api';

/**
 * The section hierarchy, always visible.
 *
 * Drag and drop moves a section; the numbers you see are recomputed by the
 * server from tree position on every read, so a move renumbers everything
 * below it without touching a single stored identifier.
 */
export function SectionTree({ moduleId }: { moduleId: string }) {
  const queryClient = useQueryClient();
  const { sectionId: activeId } = useParams<{ sectionId: string }>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Which section is being dragged is a ref rather than state: it is read
  // inside the drop handler and never rendered, and holding it in state would
  // make the drop depend on a re-render having already committed.
  const dragId = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; where: DropWhere } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: sections, isLoading } = useQuery({
    queryKey: ['sections', moduleId],
    queryFn: () => api.getSections(moduleId),
  });

  const move = useMutation({
    mutationFn: ({ id, parentId, position }: { id: string; parentId: string | null; position: number }) =>
      api.moveSection(id, parentId, position),
    onSuccess: (tree) => {
      setError(null);
      queryClient.setQueryData(['sections', moduleId], tree);
      queryClient.invalidateQueries({ queryKey: ['module', moduleId] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const create = useMutation({
    mutationFn: (parentId: string | null) =>
      api.createSection({ moduleId, title: 'New section', parentId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['sections', moduleId] }),
  });

  if (isLoading) return <div className="p-2 text-sm text-muted">Loading…</div>;
  if (!sections?.length) {
    return (
      <div className="space-y-3 p-2">
        <p className="text-sm text-muted">
          No sections yet. Build the hierarchy by hand, or add sources and let the tree grow
          around them.
        </p>
        <button className="btn w-full" onClick={() => create.mutate(null)}>
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
    <div className="space-y-1">
      {error && (
        <div className="rounded border border-flag/30 bg-flag-soft px-2 py-1 text-xs text-flag">
          {error}
        </div>
      )}
      {rows(sections)}
      <button
        className="mt-2 w-full rounded px-2 py-1 text-left text-xs text-muted hover:bg-canvas"
        onClick={() => create.mutate(null)}
      >
        + Add top-level section
      </button>
      <div className="px-2 pt-1 text-[11px] text-muted">
        {flattenSections(sections).length} sections · drag to reorder
      </div>
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
        'group relative rounded',
        dropTarget === 'into' ? 'bg-accent-soft ring-1 ring-accent' : '',
        dropTarget === 'before' ? 'border-t-2 border-accent' : '',
        dropTarget === 'after' ? 'border-b-2 border-accent' : '',
      ].join(' ')}
      style={{ paddingLeft: `${(node.depth - 1) * 12}px` }}
    >
      <div
        className={`flex items-center gap-1 rounded px-1 py-1 text-sm ${
          active ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-canvas'
        }`}
      >
        <button
          onClick={onToggle}
          className={`w-4 shrink-0 text-xs text-muted ${hasChildren ? '' : 'invisible'}`}
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? '▸' : '▾'}
        </button>

        <NavLink
          to={`/modules/${moduleId}/sections/${node.id}`}
          className="flex min-w-0 flex-1 items-baseline gap-2"
          title={node.title}
        >
          <span className="shrink-0 font-mono text-xs text-muted">{node.number}</span>
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
    empty: 'bg-line',
    drafted: 'bg-amber-400',
    edited: 'bg-accent',
    complete: 'bg-accent',
  };
  return (
    <span
      className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles[status]}`}
      title={`Status: ${status}`}
    />
  );
}
