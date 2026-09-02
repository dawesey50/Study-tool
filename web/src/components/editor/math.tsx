import { Node, mergeAttributes, InputRule } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useRef, useState } from 'react';

/**
 * Inline equations, written as `$...$`.
 *
 * The other half of the deferred P0-4 decision. This course has real equations
 * in it — Nernst, Goldman, Michaelis-Menten, Henderson-Hasselbalch — and
 * "E = (RT/zF) ln([K]o/[K]i)" as plain text is materially harder to read than
 * the same thing set properly. That is the case for keeping KaTeX; the case
 * against was that it rendered nothing at all, which is now fixed rather than
 * deferred a third time.
 *
 * An atom node rather than a mark, so the LaTeX is never half-edited by a
 * cursor wandering into the middle of it. Click it and you get the source
 * back; press Escape or click away and it renders again. Storage is the
 * original `$...$`, so notes stay readable as markdown and a model can both
 * read and write them.
 *
 * KaTeX is loaded on demand: a module with no equations should not pay for it.
 */

let katexPromise: Promise<typeof import('katex').default> | null = null;

async function getKatex() {
  if (!katexPromise) {
    katexPromise = Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
      ([module]) => module.default,
    );
  }
  return katexPromise;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    mathInline: {
      insertMath: (latex: string) => ReturnType;
    };
  }
}

export const MathInline = Node.create({
  name: 'math',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return { latex: { default: '' } };
  },

  parseHTML() {
    return [{ tag: 'span[data-math]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-math': HTMLAttributes.latex })];
  },

  addCommands() {
    return {
      insertMath:
        (latex) =>
        ({ chain }) =>
          chain().focus().insertContent({ type: 'math', attrs: { latex } }).run(),
    };
  },

  /** Typing `$E = mc^2$ ` turns it into an equation, the way `- ` makes a bullet. */
  addInputRules() {
    return [
      new InputRule({
        find: /\$([^$]+)\$$/,
        handler: ({ state, range, match }) => {
          const latex = match[1]?.trim();
          if (!latex) return;
          state.tr.replaceWith(
            range.from,
            range.to,
            this.type.create({ latex }),
          );
        },
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathView);
  },
});

function MathView({
  node,
  updateAttributes,
  selected,
}: {
  node: { attrs: Record<string, unknown> };
  updateAttributes: (attrs: Record<string, unknown>) => void;
  selected: boolean;
}) {
  const latex = String(node.attrs.latex ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latex);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const katex = await getKatex();
        const rendered = katex.renderToString(latex, { throwOnError: true, displayMode: false });
        if (!cancelled) {
          setHtml(rendered);
          setFailed(false);
        }
      } catch {
        // Malformed LaTeX shows as the source it came from rather than an
        // error box: you can see what you typed and fix it.
        if (!cancelled) {
          setHtml(null);
          setFailed(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [latex]);

  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const commit = () => {
    updateAttributes({ latex: draft.trim() });
    setEditing(false);
  };

  if (editing) {
    return (
      <NodeViewWrapper as="span" className="inline-block">
        <input
          ref={input}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraft(latex);
              setEditing(false);
            }
          }}
          className="rounded border border-accent bg-canvas px-1 font-mono text-xs"
          size={Math.max(draft.length, 8)}
        />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="span"
      data-math={latex}
      className={`inline-block cursor-text rounded px-0.5 ${selected ? 'bg-accent-soft' : ''}`}
      onClick={() => {
        setDraft(latex);
        setEditing(true);
      }}
      title="Click to edit the equation"
    >
      {html ? (
        <span contentEditable={false} dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <span contentEditable={false} className={failed ? 'font-mono text-xs text-flag' : ''}>
          ${latex}$
        </span>
      )}
    </NodeViewWrapper>
  );
}
