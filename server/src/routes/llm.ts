import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { clearCache, complete, routingTable, startRun } from '../llm/index.js';
import { PROVIDERS } from '../llm/routing.js';
import { usageSummary } from '../llm/usage.js';

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  /** What is configured, what each task will run, and where the caps sit. */
  app.get('/api/llm/status', async () => ({
    providers: Object.values(PROVIDERS)
      .filter((provider) => provider.name !== 'stub' || config.llm.forceProvider === 'stub')
      .map((provider) => ({ name: provider.name, configured: provider.configured() })),
    forced: config.llm.forceProvider || null,
    routing: routingTable(),
    caps: {
      maxTokensPerRun: config.llm.maxTokensPerRun,
      monthlyCapGbpPerModule: config.llm.monthlyCapGbpPerModule,
      maxIterations: config.llm.maxIterations,
    },
    cache: config.llm.cache,
    usdToGbp: config.llm.usdToGbp,
  }));

  app.get('/api/llm/usage', async () => usageSummary());

  /**
   * Prove the key works before a long job leans on it. One short call on the
   * cheapest configured route, charged to no module and never cached.
   */
  app.post('/api/llm/test', async (request, reply) => {
    const body = z.object({ moduleId: z.string().optional() }).parse(request.body ?? {});
    try {
      const result = await complete({
        task: 'examiner',
        prompt: 'Reply with the single word: ready.',
        maxTokens: 32,
        fresh: true,
        run: startRun({ label: 'connection test', ...(body.moduleId ? { moduleId: body.moduleId } : {}) }),
      });
      return {
        ok: true,
        provider: result.provider,
        model: result.model,
        text: result.text.trim().slice(0, 200),
        costGbp: result.costUsd === null ? null : result.costUsd * config.llm.usdToGbp,
      };
    } catch (error) {
      return reply.code(200).send({ ok: false, error: (error as Error).message });
    }
  });

  /** Forces the next run to pay for fresh answers everywhere. */
  app.post('/api/llm/cache/clear', async () => ({ cleared: clearCache() }));
}
