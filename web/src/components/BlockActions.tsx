import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type BlockActionResult, type NoteBlock } from '../lib/api';
import { Icon } from './ui/Icon';
import { useToast } from './ui/Toast';

/**
 * "Explain further", "go deeper", "simplify" on one block — §6.6.
 *
 * The point is that notes stop being take-it-or-leave-it. Before this, a
 * paragraph that did not land could only be fixed by regenerating the whole
 * section and losing everything else in it.
 *
 * Nothing is written until you accept. The result appears beside the original
 * rather than in place of it, because the reason you pressed the button is
 * that you were dissatisfied with this paragraph — not that you wanted it
 * swapped for something you have not read. Accepting goes through the ordinary
 * edit path, so the block ends up marked as yours and generation leaves it
 * alone from then on, exactly as if you had rewritten it by hand.
 */

const ACTIONS: Array<{ id: BlockActionId; label: string; hint: string }> = [
  {
    id: 'explain_further',
    label: 'Explain further',
    hint: 'Fill in the step that is missing, rather than restating it at greater length',
  },
  {
    id: 'go_deeper',
    label: 'Go deeper',
    hint: 'Take the mechanism further, towards what a harder question would ask',
  },
  {
    id: 'simplify',
    label: 'Simplify',
    hint: 'Say the same thing more plainly, losing nothing',
  },
  {
    id: 'add_example',
    label: 'Add an example',
    hint: 'A tissue, a presentation, a number — something for it to stand on',
  },
];

type BlockActionId = 'explain_further' | 'go_deeper' | 'simplify' | 'add_example' | 'rewrite';

export function BlockActions({
  block,
  onAccept,
}: {
  block: NoteBlock;
  onAccept: (markdown: string) => void;
}) {
  const toast = useToast();
  const [result, setResult] = useState<BlockActionResult | null>(null);
  const [custom, setCustom] = useState('');
  const [customOpen, setCustomOpen] = useState(false);

  const run = useMutation({
    mutationFn: ({ action, instruction }: { action: BlockActionId; instruction?: string }) =>
      api.runBlockAction(block.id, action, instruction),
    onSuccess: setResult,
    onError: (error: Error) => toast.error('Could not revise that block', error.message),
  });

  if (block.locked) {
    return (
      <p className="text-xs text-muted">
        <Icon name="lock" size={12} className="mr-1 inline" />
        Locked. Unlock this block to revise it — a lock means nothing rewrites it.
      </p>
    );
  }

  return (
    <div>
      {!result && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {ACTIONS.map((action) => (
              <button
                key={action.id}
                className="btn btn-sm"
                title={action.hint}
                disabled={run.isPending}
                onClick={() => run.mutate({ action: action.id })}
              >
                {run.isPending && run.variables?.action === action.id ? 'Thinking…' : action.label}
              </button>
            ))}
            <button
              className="btn btn-sm"
              onClick={() => setCustomOpen((previous) => !previous)}
              title="Say what you want done to this block"
            >
              <Icon name="edit" size={13} className="mr-1" />
              Ask for something
            </button>
          </div>

          {customOpen && (
            <div className="mt-2 flex gap-2">
              <input
                className="input flex-1 text-sm"
                placeholder="Rewrite this as a numbered sequence of steps"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && custom.trim()) {
                    run.mutate({ action: 'rewrite', instruction: custom.trim() });
                  }
                }}
              />
              <button
                className="btn btn-sm"
                disabled={!custom.trim() || run.isPending}
                onClick={() => run.mutate({ action: 'rewrite', instruction: custom.trim() })}
              >
                Go
              </button>
            </div>
          )}

          <p className="mt-2 text-xs text-muted">
            Answered only from this section’s own sources. Nothing is changed until you accept it.
          </p>
        </>
      )}

      {result && (
        <div>
          {result.limitedBySources && (
            <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs leading-relaxed">
              The material does not go that far, so this went as far as it could.{' '}
              {result.note ?? ''} An honest stop is better than an invention you would then revise
              from.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted">Now</p>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-line p-2.5 text-sm leading-relaxed">
                {result.original}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wider text-accent">Proposed</p>
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-accent/40 bg-accent/5 p-2.5 text-sm leading-relaxed">
                {result.proposed}
              </p>
            </div>
          </div>

          {result.note && !result.limitedBySources && (
            <p className="mt-2 text-xs italic text-muted">{result.note}</p>
          )}

          <div className="mt-3 flex gap-2">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => {
                onAccept(result.proposed);
                setResult(null);
              }}
            >
              <Icon name="check" size={13} className="mr-1" />
              Use this
            </button>
            <button
              className="btn btn-sm"
              disabled={run.isPending}
              onClick={() => run.mutate({ action: result.action as BlockActionId })}
            >
              Try again
            </button>
            <button className="btn btn-sm" onClick={() => setResult(null)}>
              Keep what I have
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
