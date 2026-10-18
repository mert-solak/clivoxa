import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { listModels } from '../../providers/models.js';
import { cheapGuards } from '../../security/guards.js';
import { msg } from '../../shared/messages.js';
import { type ToolContext, textResult } from '../context.js';

export async function handleListModels(ctx: ToolContext, a: { refresh?: boolean }): Promise<CallToolResult> {
  const refusal = cheapGuards(ctx.cfg);
  if (refusal) return textResult(msg('models_refused', { reason: refusal }), true);
  try {
    return textResult(JSON.stringify(await listModels(ctx.cfg, ctx.target, a.refresh), null, 2));
  } catch (error) {
    return textResult((error as Error).message, true);
  }
}
