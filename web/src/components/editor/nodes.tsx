import { Node, mergeAttributes } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, flattenSections } from '../../lib/api';
import { Icon } from '../ui/Icon';

/**
 * The three block types the database has always had and the editor could not
 * draw: a figure, a cross-reference, and a table.
 *
 * Until now they fell through to plain prose, which meant a generated crossref
 * block would have rendered as the literal text of its own markup. These need
 * to exist *before* generation writes them, not after — a note format the
 * editor cannot display is not a format.
 *
 * Both custom nodes hold their caption or note as ordinary editable content
 * rather than in an attribute, so writing in them behaves like writing
 * anywhere else in the document: undo works, selection works, and there is no
 * separate dialog to open.
 */

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    figureBlock: {
      insertFigure: (attributes: {
        src: string;
        alt?: string;
        figureId?: string | null;
        caption?: string;
      }) => ReturnType;
    };
    crossrefBlock: {
      insertCrossref: (attributes: {
        targetSectionId: string;
        label: string;
        note?: string;
      }) => ReturnType;
    };
  }
}

// ---------------------------------------------------------------------------
// Figure
// ---------------------------------------------------------------------------

export const FigureBlock = Node.create({
  name: 'figure',
  group: 'block',
  // The caption is the node's content, so it is edited in place.
  content: 'inline*',
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      /** The extracted figure this came from, kept so the citation survives. */
      figureId: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'figure[data-src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(HTMLAttributes, { 'data-src': HTMLAttributes.src }), 0];
  },

  addCommands() {
    return {
      insertFigure:
        (attributes) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContent({
              type: 'figure',
              attrs: {
                src: attributes.src,
                alt: attributes.alt ?? '',
                figureId: attributes.figureId ?? null,
              },
              content: attributes.caption ? [{ type: 'text', text: attributes.caption }] : [],
            })
            .run(),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(FigureView);
  },
});

/**
 * A React node view draws its own DOM, so `renderHTML` above never runs here.
 * The identifying attributes therefore have to be put on the wrapper by hand —
 * without them the block is invisible to the stylesheet's locked-block rule
 * and to anything selecting on the document.
 */
function FigureView({ node }: { node: { attrs: Record<string, unknown> } }) {
  const src = String(node.attrs.src ?? '');
  const alt = String(node.attrs.alt ?? '');
  const blockId = node.attrs.blockId ? String(node.attrs.blockId) : undefined;

  return (
    <NodeViewWrapper
      as="figure"
      data-src={src}
      data-block-id={blockId}
      className="my-4 overflow-hidden rounded-xl border border-line bg-panel"
    >
      {src ? (
        <img src={src} alt={alt} className="mx-auto block max-h-96 w-auto max-w-full" />
      ) : (
        <div className="flex h-24 items-center justify-center text-xs text-faint">
          This figure has no image
        </div>
      )}
      <NodeViewContent
        as="figcaption"
        className="border-t border-line px-3 py-2 text-xs leading-relaxed text-muted"
      />
    </NodeViewWrapper>
  );
}

// ---------------------------------------------------------------------------
// Cross-reference
// ---------------------------------------------------------------------------

export const CrossrefBlock = Node.create({
  name: 'crossref',
  group: 'block',
  /** The note saying why you are being sent there. */
  content: 'inline*',
  draggable: true,
  isolating: true,

  addAttributes() {
    return {
      targetSectionId: { default: null },
      /**
       * The section's title as it was when the reference was written. Only a
       * fallback: the live title and number are looked up on every render,
       * because a number is derived from tree position and moving a branch
       * must not leave stale references behind.
       */
      label: { default: '' },
    };
  },

  parseHTML() {
    return [{ tag: 'aside[data-crossref]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'aside',
      mergeAttributes(HTMLAttributes, { 'data-crossref': HTMLAttributes.targetSectionId }),
      0,
    ];
  },

  addCommands() {
    return {
      insertCrossref:
        (attributes) =>
        ({ chain }) =>
          chain()
            .focus()
            .insertContent({
              type: 'crossref',
              attrs: {
                targetSectionId: attributes.targetSectionId,
                label: attributes.label,
              },
              content: attributes.note ? [{ type: 'text', text: attributes.note }] : [],
            })
            .run(),
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(CrossrefView);
  },
});

function CrossrefView({ node }: { node: { attrs: Record<string, unknown> } }) {
  const { moduleId } = useParams<{ moduleId: string }>();
  const targetId = node.attrs.targetSectionId ? String(node.attrs.targetSectionId) : null;
  const storedLabel = String(node.attrs.label ?? '');

  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });

  const target = module
    ? flattenSections(module.sections).find((section) => section.id === targetId)
    : undefined;

  return (
    <NodeViewWrapper
      as="aside"
      data-crossref={targetId ?? ''}
      data-block-id={node.attrs.blockId ? String(node.attrs.blockId) : undefined}
      className="my-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-2"
    >
      <div className="flex items-baseline gap-2 text-xs" contentEditable={false}>
        <Icon name="chevronRight" size={13} className="translate-y-0.5 text-accent" />
        {target && moduleId ? (
          <Link
            to={`/modules/${moduleId}/sections/${target.id}`}
            className="font-medium text-accent hover:underline"
          >
            <span className="font-mono tabular-nums">{target.number}</span> {target.title}
          </Link>
        ) : (
          <span className="text-muted">
            {storedLabel || 'a section'}
            <span className="ml-1.5 text-flag">
              {module ? '· no longer in this module' : '· looking it up'}
            </span>
          </span>
        )}
      </div>
      <NodeViewContent className="mt-1 text-sm leading-relaxed" />
    </NodeViewWrapper>
  );
}

/** The list a picker shows: every section except the one being written in. */
export function useCrossrefTargets(moduleId: string | undefined, exceptSectionId: string) {
  const { data: module } = useQuery({
    queryKey: ['module', moduleId],
    queryFn: () => api.getModule(moduleId!),
    enabled: Boolean(moduleId),
  });
  return (module ? flattenSections(module.sections) : []).filter(
    (section) => section.id !== exceptSectionId,
  );
}
