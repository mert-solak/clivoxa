// clivoxa: two-way consultation bridge between Claude Code and Codex CLI (the caller picks the model), MCP over stdio.
//   CLIVOXA_EXPOSE=codex  -> list_models, ask_codex, get_job, list_jobs, cancel_job   (Claude Code / Claude Desktop)
//   CLIVOXA_EXPOSE=claude -> list_models, ask_claude, get_job, list_jobs, cancel_job  (Codex)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, layout, withCanonicalHome } from '../config/config.js';
import { ensureDir0700 } from '../system/fs.js';
import { startupGuards } from '../security/guards.js';
import { log, setLogLevel } from '../shared/log.js';
import { msg } from '../shared/messages.js';
import { VERSION } from '../shared/version.js';
import { askToolName } from '../domain/ids.js';
import type { ToolContext } from './context.js';
import { toolDescriptions } from './descriptions.js';
import { askShape, cancelJobShape, getJobShape, listJobsShape, listModelsShape, type AskArgs } from './schemas.js';
import { handleAsk } from './handlers/ask.js';
import { handleListModels } from './handlers/models.js';
import { handleCancelJob, handleGetJob, handleListJobs } from './handlers/jobs.js';

async function main(): Promise<void> {
  let cfg = loadConfig(process.env);
  setLogLevel(cfg.logLevel);
  let lay = layout(cfg);
  const refusal = cfg.expose ? startupGuards(cfg) : msg('expose_missing');
  if (!refusal) {
    for (const d of [lay.home, lay.jobs, lay.sessions, lay.locks, lay.scratch, lay.tmp, lay.caps]) ensureDir0700(d);
    cfg = withCanonicalHome(cfg);
    lay = layout(cfg);
  }
  const target = cfg.expose;
  const ctx: ToolContext | null = target && !refusal ? { cfg, lay, target } : null;
  const desc = ctx ? toolDescriptions(ctx) : null;
  // A refusing server still tells the host's model why it offers nothing (e.g. a constrained PowerShell),
  // instead of an unexplained empty tool list.
  const instructions = desc ? desc.instructions : refusal ? msg('server_refused', { reason: refusal }) : undefined;
  const server = new McpServer({ name: 'clivoxa', version: VERSION }, instructions ? { instructions } : {});

  if (ctx && desc) {
    server.registerTool(
      'list_models',
      {
        title: 'Karşı CLI modellerini ve effort seçeneklerini keşfet',
        description: desc.listModels,
        inputSchema: listModelsShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args) => handleListModels(ctx, args as { refresh?: boolean }),
    );
    const askName = askToolName(ctx.target);
    const who = ctx.target === 'codex' ? 'Codex' : 'Claude';
    server.registerTool(
      askName,
      {
        title: ctx.target === 'codex' ? 'Codex ile çalış (model seçilebilir)' : 'Claude ile çalış (model seçilebilir)',
        description: desc.ask,
        inputSchema: askShape(ctx.target),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        _meta: { 'anthropic/alwaysLoad': true, 'anthropic/searchHint': `${who} danış ikinci görüş tartış yaptır consult second opinion delegate`, 'anthropic/maxResultSizeChars': 200_000 },
      },
      async (args: Record<string, unknown>, extra: unknown) => {
        const m = (extra as { _meta?: Record<string, unknown> })._meta ?? {};
        const ci = server.server.getClientVersion();
        return handleAsk(ctx, args as unknown as AskArgs, extra as never, {
          client: ci?.name, client_version: ci?.version,
          thread_id: typeof m.threadId === 'string' ? m.threadId : undefined,
          session_id: typeof m.sessionId === 'string' ? m.sessionId : undefined,
        });
      },
    );
    server.registerTool(
      'get_job',
      {
        title: 'İş sonucunu bekle/oku',
        description: desc.getJob,
        inputSchema: getJobShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        _meta: { 'anthropic/alwaysLoad': true, 'anthropic/maxResultSizeChars': 200_000 },
      },
      async (args, extra) => handleGetJob(ctx, args as { job_id: string; wait_seconds?: number; answer_offset?: number }, extra as never),
    );
    server.registerTool(
      'list_jobs',
      {
        title: 'Son işleri listele',
        description: desc.listJobs,
        inputSchema: listJobsShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args) => handleListJobs(ctx, args as { limit?: number }),
    );
    server.registerTool(
      'cancel_job',
      {
        title: 'İşi iptal et',
        description: desc.cancelJob,
        inputSchema: cancelJobShape,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args) => handleCancelJob(ctx, args as { job_id: string }),
    );
  } else {
    log(`araç sunulmuyor: ${refusal}`);
    // Advertise the tools capability so clients still get a well-formed (empty) tools/list.
    server.server.registerCapabilities({ tools: { listChanged: false } });
    server.server.setRequestHandler((await import('@modelcontextprotocol/sdk/types.js')).ListToolsRequestSchema, async () => ({ tools: [] }));
  }

  const transport = new StdioServerTransport();
  const shutdown = (): void => {
    // Jobs are detached and keep running; only this server exits.
    void server.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code === 'EPIPE') process.exit(0);
  });
  await server.connect(transport);
  log(`hazır: rol=${target ?? '-'} host=${cfg.host} sürüm=${VERSION}${refusal ? ` (reddedildi: ${refusal})` : ''}`);
}

main().catch((e) => {
  log(`başlatma hatası: ${(e as Error)?.stack ?? String(e)}`);
  process.exit(1);
});
