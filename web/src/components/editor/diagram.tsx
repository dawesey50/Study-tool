import CodeBlock from '@tiptap/extension-code-block';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';

/**
 * Mermaid diagrams, rendered where they are written.
 *
 * This was deferred deliberately. Mermaid has been a dependency since Phase 1
 * and rendered nothing, which is the worst of both — the download cost without
 * the feature — but wiring a renderer to content that did not exist yet would
 * have been speculative. Generation can now write a diagram block, so it
 * exists, so it renders.
 *
 * A pathway written as `graph TD; A-->B` is worth more than the same pathway
 * as three sentences, and biochemistry is full of them. That is the whole case
 * for keeping it.
 *
 * The library is loaded on demand rather than in the bundle: it is around
 * 800KB, and a module with no diagrams in it should not pay for that.
 */

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

async function getMermaid(dark: boolean) {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((module) => module.default);
  }
  const mermaid = await mermaidPromise;
  mermaid.initialize({
    startOnLoad: false,
    // Diagrams have to be legible in both themes, and a diagram that renders
    // black-on-black at night is the same as no diagram.
    theme: dark ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'inherit',
  });
  return mermaid;
}

function isDarkNow(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** Mermaid needs a unique element id per render or diagrams overwrite each other. */
let renderCounter = 0;

export const DiagramBlock = CodeBlock.extend({
  addNodeView() {
    return ReactNodeViewRenderer(DiagramView);
  },
});

function DiagramView({ node }: { node: { attrs: Record<string, unknown>; textContent: string } }) {
  const language = String(node.attrs.language ?? '');
  const source = node.textContent;
  const isMermaid = language === 'mermaid' || /^\s*(graph|flowchart|sequenceDiagram|stateDiagram|classDiagram|erDiagram|journey|gantt|pie|mindmap)\b/.test(source);

  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    if (!isMermaid || !source.trim()) {
      setSvg(null);
      return;
    }

    let cancelled = false;
    const id = `mermaid-${++renderCounter}`;

    void (async () => {
      try {
        const mermaid = await getMermaid(isDarkNow());
        const { svg: rendered } = await mermaid.render(id, source);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (caught) {
        if (cancelled) return;
        setSvg(null);
        // A half-written diagram is the normal state while typing one, so this
        // is a note rather than an alarm.
        setError((caught as Error).message.split('\n')[0] ?? 'Could not draw that diagram');
      }
    })();

    return () => {
      cancelled = true;
      document.getElementById(id)?.remove();
    };
  }, [isMermaid, source]);

  const blockId = node.attrs.blockId ? String(node.attrs.blockId) : undefined;

  // Plain code blocks keep their old behaviour entirely.
  if (!isMermaid) {
    return (
      <NodeViewWrapper as="pre" data-block-id={blockId}>
        <NodeViewContent as="code" />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      as="div"
      data-block-id={blockId}
      data-diagram="mermaid"
      className="my-4 overflow-hidden rounded-xl border border-line bg-panel"
    >
      {svg && !showSource && (
        <div
          contentEditable={false}
          className="mermaid-rendered overflow-x-auto px-3 py-4"
          // Mermaid output is SVG it generated from text this document already
          // holds, with securityLevel 'strict' so embedded HTML is not honoured.
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}

      {error && !showSource && (
        <p className="px-3 py-2 text-2xs leading-relaxed text-muted" contentEditable={false}>
          Not a complete diagram yet — {error}
        </p>
      )}

      <div
        className={showSource || !svg ? '' : 'hidden'}
        // The source stays in the document at all times; hiding it visually
        // rather than unmounting keeps the editor's own model intact.
      >
        <NodeViewContent as="pre" className="!my-0 !rounded-none !border-0" />
      </div>

      <button
        contentEditable={false}
        onClick={() => setShowSource((value) => !value)}
        className="flex w-full items-center gap-1.5 border-t border-line px-3 py-1.5 text-2xs text-muted transition hover:text-ink"
        type="button"
      >
        <Icon name={showSource ? 'image' : 'edit'} size={11} />
        {showSource ? 'Show the diagram' : 'Edit the diagram'}
      </button>
    </NodeViewWrapper>
  );
}
