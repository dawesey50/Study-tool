import Blockquote from '@tiptap/extension-blockquote';
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Editor extensions that keep a free-form document and an addressable block
 * list in step with each other.
 */

const BLOCK_NODES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
];

/**
 * Gives every top-level node a stable id.
 *
 * This is what makes the whole design work: you type in one document, but each
 * paragraph carries an identity that survives editing, so the database keeps
 * real blocks — lockable, attributable, and individually addressable by a model
 * later. Ids are minted here rather than by the server because a block created
 * mid-sentence needs identity immediately, not after a round trip.
 */
export const BlockId = Extension.create({
  name: 'blockId',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_NODES,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attributes) =>
              attributes.blockId ? { 'data-block-id': attributes.blockId } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('blockIdAssign'),

        appendTransaction: (_transactions, _oldState, newState) => {
          const seen = new Set<string>();
          const fixes: Array<{ pos: number; id: string }> = [];
          let position = 0;

          newState.doc.forEach((node) => {
            const id = node.attrs?.blockId as string | null | undefined;
            // Splitting a paragraph copies its attributes, so the new half
            // arrives wearing the original's id. Duplicates get a fresh one.
            if (!id || seen.has(id)) {
              fixes.push({ pos: position, id: crypto.randomUUID() });
            } else {
              seen.add(id);
            }
            position += node.nodeSize;
          });

          if (fixes.length === 0) return null;

          const tr = newState.tr;
          for (const fix of fixes) {
            const node = newState.doc.nodeAt(fix.pos);
            if (!node) continue;
            tr.setNodeMarkup(fix.pos, undefined, { ...node.attrs, blockId: fix.id });
          }
          // Not an edit the user made, so it should not consume an undo step.
          return tr.setMeta('addToHistory', false);
        },
      }),
    ];
  },
});

/**
 * Stops edits landing inside a locked block.
 *
 * A locked block is a promise that regeneration will not touch it, and that
 * promise is worth nothing if a stray keystroke can. Rejecting the transaction
 * outright is the only reliable way to enforce it in a single shared document.
 */
export function createLockGuard(getLockedIds: () => Set<string>) {
  return Extension.create({
    name: 'lockGuard',

    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: new PluginKey('lockGuard'),

          filterTransaction: (tr, state) => {
            if (!tr.docChanged) return true;
            const locked = getLockedIds();
            if (locked.size === 0) return true;

            const ranges: Array<[number, number]> = [];
            let position = 0;
            state.doc.forEach((node) => {
              const id = node.attrs?.blockId as string | undefined;
              if (id && locked.has(id)) ranges.push([position, position + node.nodeSize]);
              position += node.nodeSize;
            });
            if (ranges.length === 0) return true;

            for (const step of tr.steps) {
              const { from, to } = step as unknown as { from?: number; to?: number };
              if (from === undefined || to === undefined) continue;
              for (const [start, end] of ranges) {
                // Touching the boundary is fine; overlapping the body is not.
                if (from < end - 1 && to > start + 1) return false;
              }
            }
            return true;
          },
        }),
      ];
    },
  });
}

/**
 * Blockquotes carry a variant so "extra knowledge" and "summary" stay distinct
 * both visually and in storage. The spec is explicit that beyond-the-lecture
 * material must be marked as such, so it can never be mistaken for examinable
 * content.
 */
export const VariantBlockquote = Blockquote.extend({
  /**
   * Paragraphs only.
   *
   * By default a blockquote accepts any block content, which meant a heading or
   * a list could end up nested inside one. Nested structure does not survive
   * the trip through storage — a callout is stored as its "> " prefixed lines
   * and read back as paragraphs — so a heading written inside one came back as
   * the literal text "## Ionic basis". Restricting the schema makes the
   * round trip exact instead of nearly right, and a callout is an aside rather
   * than a document in its own right.
   */
  content: 'paragraph+',

  addAttributes() {
    return {
      ...this.parent?.(),
      variant: {
        default: 'callout',
        parseHTML: (element) => element.getAttribute('data-variant') ?? 'callout',
        renderHTML: (attributes) => ({ 'data-variant': attributes.variant ?? 'callout' }),
      },
    };
  },
});

/**
 * Keeps a plain paragraph at the end of the document.
 *
 * Without it, a section whose last block is a callout, a list or a diagram has
 * nowhere to click to carry on writing — the cursor has no empty line to land
 * on and the only way out is keyboard gymnastics. The trailing paragraph is
 * never stored, because empty blocks are dropped on save.
 */
export const TrailingParagraph = Extension.create({
  name: 'trailingParagraph',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('trailingParagraph'),

        appendTransaction: (_transactions, _oldState, newState) => {
          const last = newState.doc.lastChild;
          if (last && last.type.name === 'paragraph') return null;

          const paragraph = newState.schema.nodes.paragraph;
          if (!paragraph) return null;

          return newState.tr
            .insert(newState.doc.content.size, paragraph.create())
            .setMeta('addToHistory', false);
        },
      }),
    ];
  },
});
