import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Placeholder from '@tiptap/extension-placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { api, type NoteBlock, type NoteBlockType } from '../lib/api';

/**
 * The note editor.
 *
 * Notes render as one continuous document but are stored as individually
 * addressable blocks. That is what Phase 2 needs: "explain this further" and
 * "rewrite this" act on a selected block, and a block you wrote or edited is
 * marked as yours so regeneration can be made to leave it alone.
 *
 * Phase 1 ships the storage model, the editing surface and the lock, with the
 * per-block action toolbar stubbed to the actions that need no model call.
 */
export function NoteEditor({ sectionId }: { sectionId: string }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: blocks, isLoading } = useQuery({
    queryKey: ['notes', sectionId],
    queryFn: () => api.getNotes(sectionId),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notes', sectionId] });

  const create = useMutation({
    mutationFn: (input: { type: NoteBlockType; position?: number }) =>
      api.createNote(sectionId, input),
    onSuccess: (block) => {
      setSelectedId(block.id);
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; markdown?: string; type?: NoteBlockType; locked?: boolean }) =>
      api.updateNote(id, body),
    // Deliberately not invalidating on every keystroke-driven save: refetching
    // mid-typing would fight the editor for control of its own content.
    onSuccess: (updated) => {
      queryClient.setQueryData<NoteBlock[]>(['notes', sectionId], (previous) =>
        previous?.map((block) => (block.id === updated.id ? updated : block)),
      );
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteNote(id),
    onSuccess: invalidate,
  });

  if (isLoading) return <div className="p-4 text-sm text-muted">Loading notes…</div>;

  if (!blocks?.length) {
    return (
      <div className="card p-8 text-center">
        <p className="text-sm text-muted">
          No notes here yet. Write them yourself now, or wait for Phase 2 to generate them from
          this section&rsquo;s sources.
        </p>
        <div className="mt-4 flex justify-center gap-2">
          <button className="btn btn-primary" onClick={() => create.mutate({ type: 'heading' })}>
            Add a heading
          </button>
          <button className="btn" onClick={() => create.mutate({ type: 'prose' })}>
            Start writing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      {blocks.map((block, index) => (
        <BlockRow
          key={block.id}
          block={block}
          selected={selectedId === block.id}
          onSelect={() => setSelectedId(block.id)}
          onChange={(markdown) => update.mutate({ id: block.id, markdown })}
          onSetType={(type) => update.mutate({ id: block.id, type })}
          onToggleLock={() => update.mutate({ id: block.id, locked: !block.locked })}
          onDelete={() => remove.mutate(block.id)}
          onInsertAfter={() => create.mutate({ type: 'prose', position: index + 1 })}
        />
      ))}

      <div className="flex gap-2 pt-3">
        <button className="btn" onClick={() => create.mutate({ type: 'prose' })}>
          + Paragraph
        </button>
        <button className="btn" onClick={() => create.mutate({ type: 'heading' })}>
          + Heading
        </button>
        <button className="btn" onClick={() => create.mutate({ type: 'callout' })}>
          + Extra knowledge
        </button>
        <button className="btn" onClick={() => create.mutate({ type: 'summary' })}>
          + Summary
        </button>
      </div>
    </div>
  );
}

interface BlockRowProps {
  block: NoteBlock;
  selected: boolean;
  onSelect: () => void;
  onChange: (markdown: string) => void;
  onSetType: (type: NoteBlockType) => void;
  onToggleLock: () => void;
  onDelete: () => void;
  onInsertAfter: () => void;
}

function BlockRow({
  block,
  selected,
  onSelect,
  onChange,
  onSetType,
  onToggleLock,
  onDelete,
  onInsertAfter,
}: BlockRowProps) {
  return (
    <div
      onFocusCapture={onSelect}
      onClick={onSelect}
      className={`group relative rounded-md border px-3 py-2 transition-colors ${
        selected ? 'border-accent/40 bg-panel' : 'border-transparent hover:border-line'
      } ${block.type === 'callout' ? 'border-l-4 border-l-flag bg-flag-soft/40' : ''} ${
        block.type === 'summary' ? 'bg-accent-soft/40' : ''
      }`}
    >
      {(block.type === 'callout' || block.type === 'summary') && (
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
          {block.type === 'callout' ? 'Extra knowledge — beyond the lecture' : 'Summary'}
        </div>
      )}

      <BlockBody block={block} onChange={onChange} />

      <div
        className={`mt-1 flex items-center gap-2 text-[11px] text-muted ${
          selected ? '' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        <OriginBadge origin={block.origin} />
        {block.locked && <span title="Regeneration will never touch this block">🔒 locked</span>}

        <span className="flex-1" />

        <select
          value={block.type}
          onChange={(event) => onSetType(event.target.value as NoteBlockType)}
          className="rounded border border-line bg-panel px-1 py-0.5 text-[11px]"
          aria-label="Block type"
        >
          {(['heading', 'prose', 'list', 'callout', 'summary', 'table', 'diagram'] as const).map(
            (type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ),
          )}
        </select>

        <button className="hover:text-ink" onClick={onToggleLock}>
          {block.locked ? 'Unlock' : 'Lock'}
        </button>
        <button className="hover:text-ink" onClick={onInsertAfter}>
          Insert below
        </button>
        <button className="hover:text-flag" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * One TipTap instance per block. Heavier than a single editor, but it is what
 * makes a block a real unit — selectable, lockable and independently
 * regenerable — which is the whole reason notes are stored this way.
 */
function BlockBody({ block, onChange }: { block: NoteBlock; onChange: (markdown: string) => void }) {
  const saveTimer = useRef<number | null>(null);
  const latest = useRef(block.markdown);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
        Placeholder.configure({ placeholder: PLACEHOLDERS[block.type] ?? 'Write…' }),
      ],
      content: toHtml(block),
      editable: !block.locked,
      onUpdate: ({ editor: instance }) => {
        latest.current = fromHtml(instance.getHTML());
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        // Debounced so a paragraph of typing is one write, not thirty.
        saveTimer.current = window.setTimeout(() => onChange(latest.current), 600);
      },
    },
    [block.id],
  );

  // A lock toggled from the toolbar has to reach the editor instance itself,
  // otherwise a "locked" block stays typable.
  useEffect(() => {
    editor?.setEditable(!block.locked);
  }, [editor, block.locked]);

  // Flush a pending save when the block unmounts, so navigating away mid-edit
  // does not silently drop the last few hundred milliseconds of typing.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        if (latest.current !== block.markdown) onChange(latest.current);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return (
    <div className={`note-block ${block.locked ? 'opacity-70' : ''}`}>
      <EditorContent editor={editor} />
    </div>
  );
}

function OriginBadge({ origin }: { origin: NoteBlock['origin'] }) {
  const labels: Record<NoteBlock['origin'], string> = {
    ai_generated: 'generated',
    user_written: 'yours',
    user_edited: 'yours (edited)',
  };
  return <span title={`Origin: ${origin}`}>{labels[origin]}</span>;
}

const PLACEHOLDERS: Partial<Record<NoteBlockType, string>> = {
  heading: 'Heading…',
  prose: 'Write…',
  list: 'A bulleted point…',
  callout: 'Beyond the lecture…',
  summary: 'The three things that matter…',
  diagram: 'Mermaid diagram source…',
  table: 'Table…',
};

/**
 * Blocks are stored as markdown-ish text and edited as rich text. The
 * conversion is deliberately minimal for Phase 1 — headings, lists, emphasis
 * and paragraphs — because the storage format has to stay readable to the
 * models that will read and write it in Phase 2.
 */
function toHtml(block: NoteBlock): string {
  const text = block.markdown;
  if (!text.trim()) return '';

  if (block.type === 'heading') {
    return `<h2>${escapeHtml(text.replace(/^#+\s*/, ''))}</h2>`;
  }

  const lines = text.split('\n');
  const html: string[] = [];
  let listBuffer: string[] = [];

  const flushList = () => {
    if (!listBuffer.length) return;
    html.push(`<ul>${listBuffer.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`);
    listBuffer = [];
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      listBuffer.push(bullet[1] ?? '');
      continue;
    }
    flushList();
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      html.push(`<h${heading[1]!.length}>${inline(heading[2] ?? '')}</h${heading[1]!.length}>`);
    } else if (line.trim()) {
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  flushList();

  return html.join('');
}

function fromHtml(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<\/(p|ul|ol|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
