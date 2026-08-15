import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type LlmStatus, type LlmUsage } from '../lib/api';
import { Icon } from './ui/Icon';
import { useToast } from './ui/Toast';

/**
 * Models and spend.
 *
 * The spec budgets about £7 a module, and a budget nobody can see is not a
 * budget — this is where it becomes visible. Two things it deliberately does
 * not do: it never presents a converted pound figure as though the bill came
 * in pounds (the rate is stated next to it), and it never folds calls with no
 * price on file into the total as zero. A comfortable number would be worse
 * than an honest one with a caveat attached.
 */

const TASK_LABELS: Record<string, string> = {
  hierarchy_proposal: 'Proposing a section hierarchy',
  concept_extraction: 'Extracting concepts',
  transcript_cleanup: 'Cleaning up transcripts',
  figure_caption: 'Captioning figures',
  note_generation: 'Writing notes',
  section_rewrite: 'Rewriting a section',
  question_generation: 'Writing questions',
  examiner: 'Checking questions',
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Claude',
  gemini: 'Gemini',
  groq: 'Groq',
  stub: 'Offline stub',
};

const money = (value: number): string => `£${value.toFixed(2)}`;

export function LlmPanel() {
  const toast = useToast();
  const queryClient = useQueryClient();

  const { data: status } = useQuery({ queryKey: ['llm-status'], queryFn: api.llmStatus });
  const { data: usage } = useQuery({ queryKey: ['llm-usage'], queryFn: api.llmUsage });

  const test = useMutation({
    mutationFn: api.llmTest,
    onSuccess: (result) => {
      if (result.ok) {
        toast.success(
          `${PROVIDER_LABELS[result.provider ?? ''] ?? result.provider} answered`,
          `${result.model} · ${result.text}`,
        );
      } else {
        toast.error('That call did not go through', result.error ?? 'No reason given');
      }
      queryClient.invalidateQueries({ queryKey: ['llm-usage'] });
    },
    onError: (error: Error) => toast.error('That call did not go through', error.message),
  });

  const clear = useMutation({
    mutationFn: api.clearLlmCache,
    onSuccess: (result) => {
      toast.success(
        result.cleared > 0
          ? `Cleared ${result.cleared} saved answer${result.cleared === 1 ? '' : 's'}`
          : 'There was nothing cached',
        'The next run pays for fresh answers.',
      );
      queryClient.invalidateQueries({ queryKey: ['llm-usage'] });
    },
    onError: (error: Error) => toast.error('Could not clear the cache', error.message),
  });

  const configured = status?.providers.filter((provider) => provider.configured) ?? [];
  const nothingConfigured = Boolean(status) && configured.length === 0;

  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <h3 className="label mb-0">Models and spend</h3>
        <button
          className="btn btn-sm"
          onClick={() => test.mutate()}
          disabled={test.isPending || nothingConfigured}
        >
          <Icon name="sparkle" size={13} />
          {test.isPending ? 'Trying…' : 'Test connection'}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {status?.providers.map((provider) => (
          <span
            key={provider.name}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
              provider.configured
                ? 'border-accent/40 bg-accent-soft text-accent'
                : 'border-line text-faint'
            }`}
          >
            <Icon name={provider.configured ? 'check' : 'close'} size={11} />
            {PROVIDER_LABELS[provider.name] ?? provider.name}
          </span>
        ))}
      </div>

      {nothingConfigured && (
        <p className="mt-2 rounded-lg border border-flag/30 bg-flag-soft px-3 py-2 text-xs leading-relaxed text-flag">
          No API key is set, so nothing can be generated yet. Put one in the{' '}
          <code className="font-mono">.env</code> file as{' '}
          <code className="font-mono">ANTHROPIC_API_KEY</code> and restart. Everything already
          ingested keeps working without one — searching and your own notes need no model at all.
        </p>
      )}

      <Spend usage={usage} />
      <Routing status={status} />

      {status && (
        <div className="mt-3 flex items-start justify-between gap-4 rounded-lg border border-line px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium">Limits that stop a runaway</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {status.caps.maxTokensPerRun.toLocaleString()} tokens in any one job ·{' '}
              {money(status.caps.monthlyCapGbpPerModule)} a module a month ·{' '}
              {status.caps.maxIterations} passes round any loop that regenerates until something
              is right. Each one stops and says why rather than quietly using a cheaper model.
            </p>
          </div>
          {status.cache && (
            <button
              className="btn btn-sm shrink-0"
              onClick={() => clear.mutate()}
              disabled={clear.isPending}
            >
              <Icon name="trash" size={13} />
              Clear cache
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function Spend({ usage }: { usage: LlmUsage | undefined }) {
  if (!usage) return <div className="skeleton mt-3 h-16" />;

  if (usage.calls === 0) {
    return (
      <p className="mt-3 rounded-lg border border-line px-3 py-2 text-xs leading-relaxed text-muted">
        Nothing has been spent this month. Costs appear here per module as soon as anything is
        generated.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted">Spent in {usage.month}</span>
        <span className="text-lg font-semibold tabular-nums">{money(usage.totalGbp)}</span>
      </div>

      <ul className="mt-2 space-y-2">
        {usage.modules.map((row) => {
          const fraction = row.capGbp > 0 ? Math.min(1, row.costGbp / row.capGbp) : 0;
          return (
            <li key={row.moduleId || 'unattached'}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate">{row.title}</span>
                <span className="shrink-0 tabular-nums">
                  {money(row.costGbp)}
                  {row.capGbp > 0 && (
                    <span className="text-faint"> / {money(row.capGbp)}</span>
                  )}
                </span>
              </div>
              {row.capGbp > 0 && (
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line">
                  <div
                    className={`h-full rounded-full ${fraction > 0.9 ? 'bg-flag' : 'bg-accent'}`}
                    style={{ width: `${Math.max(2, fraction * 100)}%` }}
                  />
                </div>
              )}
              <p className="mt-0.5 text-2xs text-muted">
                {row.calls} call{row.calls === 1 ? '' : 's'}
                {row.cachedCalls > 0 &&
                  ` · ${row.cachedCalls} reused, saving ${money(row.savedGbp)}`}
                {row.failedCalls > 0 && ` · ${row.failedCalls} failed`}
                {row.unpricedCalls > 0 &&
                  ` · ${row.unpricedCalls} with no price on file, not counted above`}
              </p>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-2xs leading-relaxed text-muted">
        Billed in US dollars and shown at {usage.usdToGbp} to the dollar, which is a rate you set
        in <code className="font-mono">.env</code>, not a live one.
        {usage.unpricedCalls > 0 &&
          ' Calls to a model with no price on file are counted but not costed — add its rates to data/model-prices.json.'}
      </p>
    </div>
  );
}

function Routing({ status }: { status: LlmStatus | undefined }) {
  if (!status) return null;
  const substitutions = status.routing.filter((row) => row.substituted).length;

  return (
    <details className="mt-3 rounded-lg border border-line">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
        Which model runs what
        {substitutions > 0 && (
          <span className="ml-1.5 font-normal text-flag">
            · {substitutions} standing in
          </span>
        )}
      </summary>
      <dl className="divide-y divide-line border-t border-line text-xs">
        {status.routing.map((row) => (
          <div key={row.task} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
            <dt className="truncate text-muted">{TASK_LABELS[row.task] ?? row.task}</dt>
            <dd className="shrink-0 text-right">
              {row.available ? (
                <>
                  <span className="font-mono">{row.effectiveModel}</span>
                  {row.substituted && (
                    <span
                      className="block text-2xs text-flag"
                      title={`No API key for ${PROVIDER_LABELS[row.configuredProvider] ?? row.configuredProvider}`}
                    >
                      standing in for {row.configuredModel}
                    </span>
                  )}
                </>
              ) : (
                <span className="font-mono text-faint line-through">{row.configuredModel}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      <p className="border-t border-line px-3 py-2 text-2xs leading-relaxed text-muted">
        Set by <code className="font-mono">LLM_MODEL_*</code> in{' '}
        <code className="font-mono">.env</code>. Nothing in the code names a model, so changing one
        here is a restart rather than an edit. Where a model is standing in, its own provider has
        no key — add one and the task moves back to what you asked for.
      </p>
    </details>
  );
}
