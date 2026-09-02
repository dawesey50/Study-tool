/**
 * The bridge between one continuous editor document and the blocks stored in
 * the database.
 *
 * You write in a single document, the way you would in any word processor. The
 * database still keeps an ordered list of addressable blocks, because that is
 * what lets a model be told "rewrite this block, leave that one alone" and what
 * lets a block be locked, attributed and traced back to its sources. This file
 * is the only place that knows both shapes.
 *
 * Storage is markdown rather than the editor's own JSON on purpose: it stays
 * readable to a human, diffable in git, and — the point for later phases —
 * directly usable as both input and output for a language model.
 */

export type BlockType =
  | 'heading'
  | 'prose'
  | 'list'
  | 'table'
  | 'diagram'
  | 'figure'
  | 'callout'
  | 'summary'
  | 'crossref';

/** A top-level node in the editor document, paired with the block it maps to. */
export interface DocBlock {
  blockId: string | null;
  type: BlockType;
  markdown: string;
  /**
   * The two references the database keeps in their own columns as well as in
   * the markdown, so "which blocks point at this section?" and "where is this
   * figure used?" are queries rather than a scan of every note's text.
   *
   * The markdown stays authoritative for what is rendered; these are the index
   * kept in step with it on every save.
   */
  figureId?: string | null;
  targetSectionId?: string | null;
}

// Minimal structural types for the ProseMirror JSON actually handled here.
export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: PmMark[];
}

// ---------------------------------------------------------------------------
// Editor document  ->  stored blocks
// ---------------------------------------------------------------------------

export function docToBlocks(doc: PmNode): DocBlock[] {
  return (doc.content ?? [])
    .map((node) => ({
      blockId: (node.attrs?.blockId as string | undefined) ?? null,
      type: blockTypeOf(node),
      markdown: nodeToMarkdown(node).trimEnd(),
      figureId: (node.attrs?.figureId as string | undefined) ?? null,
      targetSectionId: (node.attrs?.targetSectionId as string | undefined) ?? null,
    }))
    // A wholly empty paragraph is the cursor resting on a blank line, not
    // content worth a database row.
    .filter((block) => block.markdown.length > 0);
}

function blockTypeOf(node: PmNode): BlockType {
  switch (node.type) {
    case 'heading':
      return 'heading';
    case 'bulletList':
    case 'orderedList':
      return 'list';
    case 'codeBlock':
      return 'diagram';
    case 'table':
      return 'table';
    case 'figure':
      return 'figure';
    case 'crossref':
      return 'crossref';
    case 'blockquote':
      return node.attrs?.variant === 'summary' ? 'summary' : 'callout';
    default:
      return 'prose';
  }
}

function nodeToMarkdown(node: PmNode, depth = 0): string {
  switch (node.type) {
    case 'heading': {
      const level = Math.min(Number(node.attrs?.level ?? 1), 6);
      return `${'#'.repeat(level)} ${inlineToMarkdown(node.content)}`;
    }

    case 'paragraph':
      return inlineToMarkdown(node.content);

    case 'bulletList':
    case 'orderedList': {
      const ordered = node.type === 'orderedList';
      const start = Number(node.attrs?.start ?? 1);
      return (node.content ?? [])
        .map((item, index) => listItemToMarkdown(item, depth, ordered ? start + index : null))
        .join('\n');
    }

    case 'blockquote':
      return (node.content ?? [])
        .map((child) => nodeToMarkdown(child, depth))
        .join('\n')
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n');

    case 'codeBlock': {
      const language = (node.attrs?.language as string | undefined) ?? '';
      return `\`\`\`${language}\n${textOf(node.content)}\n\`\`\``;
    }

    case 'horizontalRule':
      return '---';

    // A figure is one line: the image, then its caption as the title. Keeping
    // it to a single line means a caption can never be mistaken for the prose
    // that follows it.
    case 'figure': {
      const src = String(node.attrs?.src ?? '');
      const alt = String(node.attrs?.alt ?? '');
      const caption = inlineToMarkdown(node.content).replace(/\n/g, ' ').trim();
      return caption
        ? `![${alt}](${src} "${caption.replace(/"/g, '\\"')}")`
        : `![${alt}](${src})`;
    }

    // "→ [Cortical layers](section:uuid) how the six layers differ". The title
    // is written down as well as the id so the line still reads on its own in
    // a diff or a prompt, but only the id is authoritative.
    case 'crossref': {
      const target = String(node.attrs?.targetSectionId ?? '');
      const label = String(node.attrs?.label ?? '').replace(/[[\]]/g, '');
      const note = inlineToMarkdown(node.content).replace(/\n/g, ' ').trim();
      return `→ [${label}](section:${target})${note ? ` ${note}` : ''}`;
    }

    case 'table':
      return tableToMarkdown(node);

    default:
      return inlineToMarkdown(node.content);
  }
}

/**
 * A GitHub-flavoured pipe table. The first row is treated as the header
 * whether or not the editor marked it as one, because a table stored without a
 * header row is not valid GFM and would come back as prose.
 */
function tableToMarkdown(node: PmNode): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) =>
      (cell.content ?? [])
        .map((child) => nodeToMarkdown(child))
        .join(' ')
        .replace(/\n/g, ' ')
        // A literal pipe would split the cell it lives in.
        .replace(/\|/g, '\\|')
        .trim(),
    ),
  );
  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]): string[] =>
    Array.from({ length: width }, (_, index) => row[index] ?? '');

  const [header, ...body] = rows;
  const lines = [
    `| ${pad(header!).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...body.map((row) => `| ${pad(row).join(' | ')} |`),
  ];
  return lines.join('\n');
}

function listItemToMarkdown(item: PmNode, depth: number, ordinal: number | null): string {
  const indent = '  '.repeat(depth);
  const marker = ordinal === null ? '-' : `${ordinal}.`;
  const lines: string[] = [];

  for (const child of item.content ?? []) {
    if (child.type === 'bulletList' || child.type === 'orderedList') {
      lines.push(nodeToMarkdown(child, depth + 1));
    } else if (lines.length === 0) {
      lines.push(`${indent}${marker} ${nodeToMarkdown(child, depth)}`);
    } else {
      // A second paragraph inside one bullet, indented to stay part of it.
      lines.push(`${indent}  ${nodeToMarkdown(child, depth)}`);
    }
  }

  return lines.length ? lines.join('\n') : `${indent}${marker} `;
}

function inlineToMarkdown(content: PmNode[] | undefined): string {
  if (!content) return '';
  return content
    .map((node) => {
      if (node.type === 'hardBreak') return '\n';
      // An equation is stored as the LaTeX it was written as, so the notes
      // stay readable markdown and a model can both read and write them.
      if (node.type === 'math') return `$${String(node.attrs?.latex ?? '')}$`;
      if (node.type !== 'text' || !node.text) return '';

      let text = node.text;
      const marks = new Set((node.marks ?? []).map((mark) => mark.type));
      // Code first: its content is literal, so wrapping it last would let the
      // other markers end up inside the backticks.
      if (marks.has('code')) text = `\`${text}\``;
      if (marks.has('bold')) text = `**${text}**`;
      if (marks.has('italic')) text = `*${text}*`;
      if (marks.has('strike')) text = `~~${text}~~`;
      return text;
    })
    .join('');
}

function textOf(content: PmNode[] | undefined): string {
  return (content ?? []).map((node) => node.text ?? '').join('');
}

// ---------------------------------------------------------------------------
// Stored blocks  ->  editor document
// ---------------------------------------------------------------------------

export interface StoredBlock {
  id: string;
  type: BlockType;
  markdown: string;
  /**
   * Which extracted figure this block placed. Unlike the section id in a
   * cross-reference, this one is not recoverable from the markdown, so it has
   * to travel back into the document — otherwise every reload would clear the
   * column on the next save and the figure would quietly stop being traceable.
   */
  figureId?: string | null;
}

export function blocksToDoc(blocks: StoredBlock[]): PmNode {
  const content = blocks.flatMap((block) => blockToNodes(block));
  // ProseMirror will not accept a document with no content.
  return {
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph', attrs: { blockId: null } }],
  };
}

function blockToNodes(block: StoredBlock): PmNode[] {
  const attrs = { blockId: block.id };
  const lines = block.markdown.split('\n');

  switch (block.type) {
    case 'heading': {
      const match = block.markdown.match(/^(#{1,6})\s*(.*)$/s);
      const level = match ? match[1]!.length : 2;
      const text = match ? match[2]! : block.markdown;
      return [{ type: 'heading', attrs: { ...attrs, level }, content: parseInline(text) }];
    }

    case 'list':
      return [parseList(lines, 0, attrs)];

    case 'diagram': {
      const fenced = block.markdown.match(/^```(\w*)\n([\s\S]*?)\n?```$/);
      const language = fenced?.[1] || null;
      const code = fenced ? fenced[2]! : block.markdown;
      return [
        {
          type: 'codeBlock',
          attrs: { ...attrs, language },
          content: code ? [{ type: 'text', text: code }] : [],
        },
      ];
    }

    case 'figure': {
      const match = block.markdown.match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"((?:[^"\\]|\\.)*)")?\)/);
      if (!match) break;
      const caption = (match[3] ?? '').replace(/\\"/g, '"');
      return [
        {
          type: 'figure',
          attrs: { ...attrs, src: match[2]!, alt: match[1]!, figureId: block.figureId ?? null },
          content: caption ? parseInline(caption) : [],
        },
      ];
    }

    case 'crossref': {
      const match = block.markdown.match(/^→\s*\[([^\]]*)\]\(section:([^)]*)\)\s*([\s\S]*)$/);
      if (!match) break;
      return [
        {
          type: 'crossref',
          attrs: { ...attrs, targetSectionId: match[2]! || null, label: match[1]! },
          content: match[3]!.trim() ? parseInline(match[3]!.trim()) : [],
        },
      ];
    }

    case 'table': {
      const table = parseTable(lines, attrs);
      if (!table) break;
      return [table];
    }

    case 'callout':
    case 'summary': {
      const inner = lines.map((line) => line.replace(/^>\s?/, ''));
      return [
        {
          type: 'blockquote',
          attrs: { ...attrs, variant: block.type },
          content: paragraphsFrom(inner),
        },
      ];
    }

    default:
      break;
  }

  // Prose, and anything else: a block whose type promises more structure than
  // its text actually carries is shown as the text it really is, rather than
  // discarded or rendered as an empty shell.
  const paragraphs = paragraphsFrom(lines);
  const [first, ...rest] = paragraphs;
  if (!first) return [{ type: 'paragraph', attrs, content: [] }];
  // Only the first node carries the block id; the rest become new blocks on
  // the next save, which is the correct reading of "you split this".
  return [{ ...first, attrs: { ...first.attrs, ...attrs } }, ...rest];
}

const TABLE_ROW = /^\s*\|(.*)\|\s*$/;

/** Split a pipe row into cells, respecting an escaped pipe inside one. */
function splitRow(line: string): string[] {
  const inner = line.match(TABLE_ROW)?.[1] ?? '';
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < inner.length; index++) {
    const char = inner[index]!;
    if (char === '\\' && inner[index + 1] === '|') {
      current += '|';
      index++;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseTable(lines: string[], attrs: Record<string, unknown>): PmNode | null {
  const rows = lines.filter((line) => TABLE_ROW.test(line));
  if (rows.length === 0) return null;

  const cellRows = rows
    // The |---|---| divider carries alignment, which this editor does not
    // offer, so it is dropped rather than turned into a row of dashes.
    .filter((line) => !isDivider(line))
    .map((line) => splitRow(line));
  if (cellRows.length === 0) return null;

  const width = Math.max(...cellRows.map((row) => row.length));
  const toRow = (cells: string[], header: boolean): PmNode => ({
    type: 'tableRow',
    content: Array.from({ length: width }, (_, index) => ({
      type: header ? 'tableHeader' : 'tableCell',
      content: [{ type: 'paragraph', content: parseInline(cells[index] ?? '') }],
    })),
  });

  const [head, ...body] = cellRows;
  return {
    type: 'table',
    attrs,
    content: [toRow(head!, true), ...body.map((row) => toRow(row, false))],
  };
}

function isDivider(line: string): boolean {
  return splitRow(line).every((cell) => /^:?-{2,}:?$/.test(cell));
}

function paragraphsFrom(lines: string[]): PmNode[] {
  const nodes: PmNode[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    nodes.push({ type: 'paragraph', attrs: { blockId: null }, content: parseInline(line) });
  }
  return nodes.length ? nodes : [{ type: 'paragraph', attrs: { blockId: null }, content: [] }];
}

const LIST_LINE = /^(\s*)([-*]|\d+\.)\s+(.*)$/;

/**
 * Build a list node from indented markdown lines, recursing wherever the
 * indentation deepens so nested bullets survive the round trip.
 */
function parseList(lines: string[], depth: number, attrs: Record<string, unknown>): PmNode {
  const items: PmNode[] = [];
  let ordered = false;
  let index = 0;

  while (index < lines.length) {
    const match = lines[index]!.match(LIST_LINE);
    if (!match) {
      index++;
      continue;
    }

    const indent = Math.floor(match[1]!.length / 2);
    if (indent < depth) break;

    if (indent > depth) {
      // Deeper lines belong to the item just added.
      const nested: string[] = [];
      while (index < lines.length) {
        const next = lines[index]!.match(LIST_LINE);
        if (!next || Math.floor(next[1]!.length / 2) <= depth) break;
        nested.push(lines[index]!);
        index++;
      }
      const parent = items[items.length - 1];
      if (parent) parent.content = [...(parent.content ?? []), parseList(nested, depth + 1, {})];
      continue;
    }

    if (/^\d+\.$/.test(match[2]!)) ordered = true;
    items.push({
      type: 'listItem',
      content: [{ type: 'paragraph', content: parseInline(match[3]!) }],
    });
    index++;
  }

  return {
    type: ordered ? 'orderedList' : 'bulletList',
    attrs,
    content: items.length ? items : [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
  };
}

/**
 * Inline markdown to text nodes with marks. Deliberately a small subset —
 * bold, italic, strike and code — matching exactly what the editor can produce,
 * so nothing is lost in one direction and invented in the other.
 */
export function parseInline(text: string): PmNode[] {
  if (!text) return [];

  // Maths comes first in the alternation so a $...$ containing an asterisk is
  // not shredded into emphasis before it is recognised as an equation.
  const pattern = /(\$[^$\n]+\$|`[^`]+`|\*\*[^*]+\*\*|~~[^~]+~~|\*[^*]+\*)/g;
  const nodes: PmNode[] = [];
  let cursor = 0;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) nodes.push({ type: 'text', text: text.slice(cursor, start) });

    const token = match[0];
    if (token.startsWith('$')) {
      nodes.push({ type: 'math', attrs: { latex: token.slice(1, -1) } });
    } else if (token.startsWith('`')) {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'code' }] });
    } else if (token.startsWith('**')) {
      nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'bold' }] });
    } else if (token.startsWith('~~')) {
      nodes.push({ type: 'text', text: token.slice(2, -2), marks: [{ type: 'strike' }] });
    } else {
      nodes.push({ type: 'text', text: token.slice(1, -1), marks: [{ type: 'italic' }] });
    }
    cursor = start + token.length;
  }

  if (cursor < text.length) nodes.push({ type: 'text', text: text.slice(cursor) });
  return nodes;
}
