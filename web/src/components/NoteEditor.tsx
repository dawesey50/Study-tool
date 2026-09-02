import { useQuery, useQueryClient } from '@tanstack/react-query';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import { BubbleMenu, EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, type NoteBlock } from '../lib/api';
import {
  blocksToDoc,
  docToBlocks,
  type BlockType,
  type DocBlock,
  type PmNode,
} from '../lib/blockMarkdown';
import {
  BlockId,
  createLockGuard,
  TrailingParagraph,
  VariantBlockquote,
} from './editor/extensions';
import { GenerateNotes } from './GenerateNotes';
import { CrossrefBlock, FigureBlock } from './editor/nodes';
import { CrossrefPicker, FigurePicker } from './editor/pickers';
import { Icon, type IconName } from './ui/Icon';
import { useToast } from './ui/Toast';

/**
 * The note editor.
 *
 * You write in one continuous document, the way you would in any word
 * processor: type, press Enter, use "# " for a heading or "- " for a bullet,
 * select text to format it. There is no block type to choose up front.
 *
 * Underneath, the document is still stored as an ordered list of addressable
 * blocks. That is not an implementation detail that leaked into the design — it
 * is the point. A block has an identity, an origin and a lock, which is what
 * lets a model later be told to expand this paragraph, rewrite that one, and
 * leave the two you wrote yourself completely alone. Exposing that machinery in
 * the interface was the mistake; keeping it in storage was not.
 */
export function NoteEditor({ sectionId }: { sectionId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();

  const { moduleId } = useParams<{ moduleId: string }>();

  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [picker, setPicker] = useState<'figure' | 'crossref' | null>(null);
  const [, forceRender] = useState(0);

  /** Last known server state, used to work out what actually changed. */
  const serverBlocks = useRef<NoteBlock[]>([]);
  const lockedIds = useRef<Set<string>>(new Set());
  const saveTimer = useRef<number | null>(null);
  const loadedSection = useRef<string | null>(null);

  const { data: blocks, isLoading } = useQuery({
    queryKey: ['notes', sectionId],
    queryFn: () => api.getNotes(sectionId),
  });

  const lockGuard = useMemo(() => createLockGuard(() => lockedIds.current), []);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          blockquote: false,
          codeBlock: { HTMLAttributes: { class: 'font-mono text-xs' } },
        }),
        VariantBlockquote,
        FigureBlock,
        CrossrefBlock,
        Table.configure({ resizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        BlockId,
        TrailingParagraph,
        lockGuard,
        Placeholder.configure({
          placeholder: ({ node }) =>
            node.type.name === 'heading'
              ? 'Heading'
              : 'Write your notes. Try "# " for a heading, "- " for a bullet, or "/" to insert.',
          showOnlyWhenEditable: true,
        }),
      ],
      editorProps: {
        attributes: {
          class: 'prose-notes focus:outline-none',
          spellcheck: 'true',
        },
      },
      onUpdate: () => {
        scheduleSave();
        forceRender((n) => n + 1);
      },
      onSelectionUpdate: () => forceRender((n) => n + 1),
    },
    [sectionId],
  );

  /**
   * Load this section's blocks into the document exactly once.
   *
   * The guard is doing real work. Saving writes the fresh server state back
   * into the query cache, which makes `blocks` a new value and re-runs this
   * effect — and reloading the content there would reset the document under a
   * cursor that is still typing. Only a change of section should reload.
   *
   * There is deliberately no separate effect resetting the marker on section
   * change: effects run in declaration order, so one would fire *after* this on
   * mount and re-arm the reload for every subsequent save.
   */
  useEffect(() => {
    if (!editor || !blocks) return;
    if (loadedSection.current === sectionId) return;

    serverBlocks.current = blocks;
    lockedIds.current = new Set(blocks.filter((block) => block.locked).map((block) => block.id));
    editor.commands.setContent(
      blocksToDoc(
        blocks.map((block) => ({
          id: block.id,
          type: block.type as BlockType,
          markdown: block.markdown,
          figureId: block.figureId,
        })),
      ) as never,
      false,
    );
    loadedSection.current = sectionId;
    setStatus('idle');
  }, [editor, blocks, sectionId]);

  const save = useCallback(async () => {
    if (!editor) return;
    const desired = docToBlocks(editor.getJSON() as PmNode);
    const current = serverBlocks.current;

    const desiredIds = new Set(desired.map((block) => block.blockId).filter(Boolean) as string[]);
    const byId = new Map(current.map((block) => [block.id, block]));

    const removed = current.filter((block) => !desiredIds.has(block.id));
    const created = desired.filter((block) => !block.blockId || !byId.has(block.blockId));
    const changed = desired.filter((block) => {
      if (!block.blockId) return false;
      const existing = byId.get(block.blockId);
      if (!existing) return false;
      return (
        existing.markdown !== block.markdown ||
        existing.type !== block.type ||
        // The reference columns are part of the block, so a figure swapped for
        // a different one is a change even when the caption happens to match.
        (existing.figureId ?? null) !== (block.figureId ?? null) ||
        (existing.targetSectionId ?? null) !== (block.targetSectionId ?? null)
      );
    });

    const orderChanged =
      desired.length !== current.length ||
      desired.some((block, index) => block.blockId !== current[index]?.id);

    if (!removed.length && !created.length && !changed.length && !orderChanged) {
      setStatus('saved');
      return;
    }

    setStatus('saving');
    try {
      for (const block of removed) {
        // Never delete a locked block as a side effect of an edit elsewhere.
        if (block.locked) continue;
        await api.deleteNote(block.id);
      }

      for (const block of created) {
        await api.createNote(sectionId, {
          ...(block.blockId ? { id: block.blockId } : {}),
          type: block.type,
          markdown: block.markdown,
          figureId: block.figureId ?? null,
          targetSectionId: block.targetSectionId ?? null,
        });
      }

      for (const block of changed) {
        await api.updateNote(block.blockId!, {
          markdown: block.markdown,
          type: block.type,
          figureId: block.figureId ?? null,
          targetSectionId: block.targetSectionId ?? null,
        });
      }

      const ordered = desired.map((block) => block.blockId).filter(Boolean) as string[];
      if (orderChanged && ordered.length) await api.reorderNotes(sectionId, ordered);

      const fresh = await api.getNotes(sectionId);
      serverBlocks.current = fresh;
      lockedIds.current = new Set(fresh.filter((block) => block.locked).map((block) => block.id));
      queryClient.setQueryData(['notes', sectionId], fresh);
      queryClient.invalidateQueries({ queryKey: ['sections'] });
      setStatus('saved');
    } catch (error) {
      setStatus('error');
      toast.error('Could not save your notes', (error as Error).message);
    }
  }, [editor, sectionId, queryClient, toast]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    setStatus('saving');
    saveTimer.current = window.setTimeout(() => void save(), 800);
  }, [save]);

  // Flush on unmount, so navigating away mid-sentence does not lose the tail.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        void save();
      }
    },
    [save],
  );

  const activeBlock = useActiveBlock(editor, serverBlocks.current);

  const toggleLock = async () => {
    if (!activeBlock) return;
    try {
      const updated = await api.updateNote(activeBlock.id, { locked: !activeBlock.locked });
      serverBlocks.current = serverBlocks.current.map((block) =>
        block.id === updated.id ? updated : block,
      );
      lockedIds.current = new Set(
        serverBlocks.current.filter((block) => block.locked).map((block) => block.id),
      );
      forceRender((n) => n + 1);
      toast.success(updated.locked ? 'Block locked' : 'Block unlocked');
    } catch (error) {
      toast.error('Could not change the lock', (error as Error).message);
    }
  };

  if (isLoading || !editor) {
    return (
      <div className="space-y-2">
        <div className="skeleton h-9" />
        <div className="skeleton h-40" />
      </div>
    );
  }

  return (
    <div>
      <GenerateNotes sectionId={sectionId} />
      <Toolbar editor={editor} status={status} />

      <BubbleMenu
        editor={editor}
        tippyOptions={{ duration: 100 }}
        className="flex items-center gap-0.5 rounded-lg border border-line bg-raised p-1 shadow-overlay"
      >
        <MarkButton editor={editor} mark="bold" icon="edit" label="Bold" text="B" />
        <MarkButton editor={editor} mark="italic" icon="edit" label="Italic" text="I" />
        <MarkButton editor={editor} mark="code" icon="edit" label="Code" text="<>" />
        <span className="mx-0.5 h-4 w-px bg-line" />
        {([1, 2, 3] as const).map((level) => (
          <button
            key={level}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
            className={`h-7 min-w-7 rounded px-1.5 text-xs font-semibold transition hover:bg-line/60 ${
              editor.isActive('heading', { level }) ? 'bg-accent-soft text-accent' : ''
            }`}
            title={`Heading ${level}`}
          >
            H{level}
          </button>
        ))}
      </BubbleMenu>

      {/*
        The slash menu is positioned from the editor's own bounding box, so it
        has to live inside the same positioned container as the editor —
        outside it, the offsets are measured against a different ancestor and
        the menu lands somewhere else entirely.
      */}
      <div className="relative mt-3">
        <SlashMenu editor={editor} onPicker={setPicker} />
        <EditorContent editor={editor} />
      </div>

      <FigurePicker
        open={picker === 'figure'}
        onClose={() => setPicker(null)}
        sectionId={sectionId}
        onChoose={(figure) => editor.commands.insertFigure(figure)}
      />
      {moduleId && (
        <CrossrefPicker
          open={picker === 'crossref'}
          onClose={() => setPicker(null)}
          moduleId={moduleId}
          exceptSectionId={sectionId}
          onChoose={(target) => editor.commands.insertCrossref(target)}
        />
      )}

      <div className="mt-6 flex items-center justify-between border-t border-line pt-3 text-2xs text-muted">
        <span>
          {activeBlock ? (
            <>
              <span className="chip bg-line/50">{ORIGIN_LABEL[activeBlock.origin]}</span>
              {activeBlock.locked && (
                <span className="chip ml-1 bg-line/50">
                  <Icon name="lock" size={10} />
                  locked
                </span>
              )}
            </>
          ) : (
            <span className="text-faint">Place the cursor in a paragraph to lock it.</span>
          )}
        </span>

        <button
          className="btn btn-sm"
          onClick={toggleLock}
          disabled={!activeBlock}
          title="A locked block is never touched by regeneration"
        >
          <Icon name={activeBlock?.locked ? 'unlock' : 'lock'} size={12} />
          {activeBlock?.locked ? 'Unlock' : 'Lock'} this block
        </button>
      </div>
    </div>
  );
}

const ORIGIN_LABEL: Record<NoteBlock['origin'], string> = {
  ai_generated: 'generated',
  user_written: 'yours',
  user_edited: 'yours · edited',
};

/** Which stored block the cursor is currently sitting in. */
function useActiveBlock(editor: Editor | null, blocks: NoteBlock[]): NoteBlock | null {
  if (!editor) return null;
  const { $from } = editor.state.selection;
  const top = $from.depth === 0 ? $from.nodeAfter : $from.node(1);
  const id = top?.attrs?.blockId as string | undefined;
  if (!id) return null;
  return blocks.find((block) => block.id === id) ?? null;
}

// ---------------------------------------------------------------------------

function Toolbar({ editor, status }: { editor: Editor; status: string }) {
  const blockLabel = editor.isActive('heading', { level: 1 })
    ? 'Heading 1'
    : editor.isActive('heading', { level: 2 })
      ? 'Heading 2'
      : editor.isActive('heading', { level: 3 })
        ? 'Heading 3'
        : editor.isActive('bulletList')
          ? 'Bulleted list'
          : editor.isActive('orderedList')
            ? 'Numbered list'
            : editor.isActive('blockquote')
              ? editor.getAttributes('blockquote').variant === 'summary'
                ? 'Summary'
                : 'Extra knowledge'
              : editor.isActive('codeBlock')
                ? 'Diagram'
                : 'Paragraph';

  return (
    <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-0.5 rounded-lg border border-line bg-panel/95 px-1.5 py-1 backdrop-blur">
      <select
        value={blockLabel}
        onChange={(event) => {
          const chain = editor.chain().focus();
          switch (event.target.value) {
            case 'Heading 1':
              chain.setNode('heading', { level: 1 }).run();
              break;
            case 'Heading 2':
              chain.setNode('heading', { level: 2 }).run();
              break;
            case 'Heading 3':
              chain.setNode('heading', { level: 3 }).run();
              break;
            case 'Bulleted list':
              chain.toggleBulletList().run();
              break;
            case 'Numbered list':
              chain.toggleOrderedList().run();
              break;
            default:
              chain.setParagraph().run();
          }
        }}
        className="rounded-md border border-line bg-panel px-2 py-1 text-xs"
        aria-label="Paragraph style"
      >
        {['Paragraph', 'Heading 1', 'Heading 2', 'Heading 3', 'Bulleted list', 'Numbered list'].map(
          (option) => (
            <option key={option}>{option}</option>
          ),
        )}
        {['Extra knowledge', 'Summary', 'Diagram'].includes(blockLabel) && (
          <option>{blockLabel}</option>
        )}
      </select>

      <Divider />
      <ToolButton
        active={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        label="Bold"
        text="B"
        bold
      />
      <ToolButton
        active={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        label="Italic"
        text="I"
        italic
      />
      <ToolButton
        active={editor.isActive('code')}
        onClick={() => editor.chain().focus().toggleCode().run()}
        label="Inline code"
        text="<>"
      />

      <Divider />
      <IconTool
        icon="notes"
        active={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        label="Bulleted list"
      />
      <IconTool
        icon="layers"
        active={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        label="Numbered list"
      />
      <IconTool
        icon="sparkle"
        active={editor.isActive('blockquote', { variant: 'callout' })}
        onClick={() =>
          editor.chain().focus().toggleBlockquote().updateAttributes('blockquote', { variant: 'callout' }).run()
        }
        label="Extra knowledge — beyond the lecture"
      />
      <IconTool
        icon="check"
        active={editor.isActive('blockquote', { variant: 'summary' })}
        onClick={() =>
          editor.chain().focus().toggleBlockquote().updateAttributes('blockquote', { variant: 'summary' }).run()
        }
        label="Summary"
      />
      <IconTool
        icon="file"
        active={editor.isActive('codeBlock')}
        onClick={() => editor.chain().focus().toggleCodeBlock().run()}
        label="Diagram or code block"
      />

      <Divider />
      <IconTool
        icon="chevronLeft"
        onClick={() => editor.chain().focus().undo().run()}
        label="Undo"
        disabled={!editor.can().undo()}
      />
      <IconTool
        icon="chevronRight"
        onClick={() => editor.chain().focus().redo().run()}
        label="Redo"
        disabled={!editor.can().redo()}
      />

      <span className="ml-auto pr-1 text-2xs text-faint" aria-live="polite">
        {status === 'saving' ? 'Saving…' : status === 'saved' ? 'Saved' : status === 'error' ? 'Not saved' : ''}
      </span>
    </div>
  );
}

const Divider = () => <span className="mx-1 h-5 w-px bg-line" />;

function ToolButton({
  active,
  onClick,
  label,
  text,
  bold,
  italic,
}: {
  active?: boolean;
  onClick: () => void;
  label: string;
  text: string;
  bold?: boolean;
  italic?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`h-7 min-w-7 rounded-md px-1.5 text-xs transition hover:bg-line/60 ${
        active ? 'bg-accent-soft text-accent' : 'text-muted'
      } ${bold ? 'font-bold' : ''} ${italic ? 'italic' : ''}`}
    >
      {text}
    </button>
  );
}

function IconTool({
  icon,
  active,
  onClick,
  label,
  disabled,
}: {
  icon: IconName;
  active?: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      className={`flex h-7 w-7 items-center justify-center rounded-md transition hover:bg-line/60 disabled:opacity-40 ${
        active ? 'bg-accent-soft text-accent' : 'text-muted'
      }`}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function MarkButton({
  editor,
  mark,
  label,
  text,
}: {
  editor: Editor;
  mark: 'bold' | 'italic' | 'code';
  icon: IconName;
  label: string;
  text: string;
}) {
  return (
    <button
      onClick={() => {
        const chain = editor.chain().focus();
        if (mark === 'bold') chain.toggleBold().run();
        else if (mark === 'italic') chain.toggleItalic().run();
        else chain.toggleCode().run();
      }}
      title={label}
      aria-label={label}
      className={`h-7 min-w-7 rounded px-1.5 text-xs transition hover:bg-line/60 ${
        editor.isActive(mark) ? 'bg-accent-soft text-accent' : ''
      } ${mark === 'bold' ? 'font-bold' : ''} ${mark === 'italic' ? 'italic' : ''}`}
    >
      {text}
    </button>
  );
}

/**
 * Typing "/" on an empty line opens an insert menu, the shortcut people now
 * expect from a document editor. Built directly on editor state rather than
 * pulling in a suggestion library for one menu.
 */
interface SlashItem {
  label: string;
  hint: string;
  icon: IconName;
  /** Inserts straight away. Omitted when the item has to ask something first. */
  run?: (editor: Editor) => void;
  /** Opens a picker instead, because the block needs a target to be worth anything. */
  picker?: 'figure' | 'crossref';
}

const SLASH_ITEMS: SlashItem[] = [
  { label: 'Heading 1', hint: '# ', icon: 'edit', run: (e) => e.chain().focus().setNode('heading', { level: 1 }).run() },
  { label: 'Heading 2', hint: '## ', icon: 'edit', run: (e) => e.chain().focus().setNode('heading', { level: 2 }).run() },
  { label: 'Heading 3', hint: '### ', icon: 'edit', run: (e) => e.chain().focus().setNode('heading', { level: 3 }).run() },
  { label: 'Bulleted list', hint: '- ', icon: 'notes', run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: 'Numbered list', hint: '1. ', icon: 'layers', run: (e) => e.chain().focus().toggleOrderedList().run() },
  {
    label: 'Extra knowledge',
    hint: 'beyond the lecture',
    icon: 'sparkle',
    run: (e) =>
      e.chain().focus().toggleBlockquote().updateAttributes('blockquote', { variant: 'callout' }).run(),
  },
  {
    label: 'Summary',
    hint: 'the three things that matter',
    icon: 'check',
    run: (e) =>
      e.chain().focus().toggleBlockquote().updateAttributes('blockquote', { variant: 'summary' }).run(),
  },
  { label: 'Diagram', hint: 'mermaid or code', icon: 'file', run: (e) => e.chain().focus().toggleCodeBlock().run() },
  {
    label: 'Table',
    hint: '3 × 3 to start',
    icon: 'layers',
    run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { label: 'Figure', hint: 'from this section', icon: 'image', picker: 'figure' },
  { label: 'Cross-reference', hint: 'point, do not repeat', icon: 'chevronRight', picker: 'crossref' },
  { label: 'Divider', hint: '---', icon: 'close', run: (e) => e.chain().focus().setHorizontalRule().run() },
];

function SlashMenu({
  editor,
  onPicker,
}: {
  editor: Editor;
  onPicker: (kind: 'figure' | 'crossref') => void;
}) {
  const [state, setState] = useState<{ query: string; top: number; left: number } | null>(null);
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    const update = () => {
      const { $from, empty } = editor.state.selection;
      if (!empty || $from.parent.type.name !== 'paragraph') return setState(null);

      const text = $from.parent.textContent;
      if (!text.startsWith('/')) return setState(null);

      const query = text.slice(1);
      // A space means they are writing a sentence that opens with a slash.
      if (query.includes(' ')) return setState(null);

      const coords = editor.view.coordsAtPos($from.pos);
      const parent = editor.view.dom.getBoundingClientRect();
      setState({ query, top: coords.bottom - parent.top + 6, left: coords.left - parent.left });
      setHighlighted(0);
    };

    editor.on('update', update);
    editor.on('selectionUpdate', update);
    return () => {
      editor.off('update', update);
      editor.off('selectionUpdate', update);
    };
  }, [editor]);

  const items = useMemo(
    () =>
      state
        ? SLASH_ITEMS.filter((item) =>
            item.label.toLowerCase().includes(state.query.toLowerCase()),
          )
        : [],
    [state],
  );

  const choose = useCallback(
    (item: SlashItem) => {
      const { $from } = editor.state.selection;
      // Remove the "/query" the user typed before applying the change.
      editor
        .chain()
        .focus()
        .deleteRange({ from: $from.start(), to: $from.pos })
        .run();
      if (item.picker) onPicker(item.picker);
      else item.run?.(editor);
      setState(null);
    },
    [editor, onPicker],
  );

  useEffect(() => {
    if (!state || items.length === 0) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((index) => (index + 1) % items.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((index) => (index - 1 + items.length) % items.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const item = items[highlighted];
        if (item) choose(item);
      } else if (event.key === 'Escape') {
        setState(null);
      }
    };

    // Capture, so the editor does not consume Enter first.
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [state, items, highlighted, choose]);

  if (!state || items.length === 0) return null;

  return (
    <div
      className="absolute z-20 w-64 overflow-hidden rounded-xl border border-line bg-raised p-1 shadow-overlay animate-scale-in"
      style={{ top: state.top, left: state.left }}
    >
      {items.map((item, index) => (
        <button
          key={item.label}
          onMouseEnter={() => setHighlighted(index)}
          onClick={() => choose(item)}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition ${
            index === highlighted ? 'bg-accent-soft text-accent' : ''
          }`}
        >
          <Icon name={item.icon} size={14} className={index === highlighted ? '' : 'text-faint'} />
          <span className="flex-1">{item.label}</span>
          <span className="font-mono text-2xs text-faint">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}

export type { DocBlock };
