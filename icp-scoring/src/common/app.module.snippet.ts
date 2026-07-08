// ─────────────────────────────────────────────────────────────
//  app.module.ts  —  Integration Snippet
//
//  Drop this into your main NestJS AppModule to wire up the
//  ICP Scoring Engine alongside your existing modules.
//
//  Steps:
//    1. Copy ICPScoringModule import into your imports[]
//    2. Call registerICPScoringWorker() in your bootstrap fn
//    3. Set required .env vars (see config.ts)
// ─────────────────────────────────────────────────────────────

import { Module }             from '@nestjs/common';
import { ICPScoringModule }   from '../icp-scoring/icp-scoring.module';
import {
  registerICPScoringWorker,
}                             from '../icp-scoring/icp-scoring.worker';
import { getRedisConfig }     from './config';

// ── Your existing modules ────────────────────────────────────
// import { WorkspacesModule }  from './workspaces/workspaces.module';
// import { CampaignsModule }   from './campaigns/campaigns.module';
// import { LeadsModule }       from './leads/leads.module';

@Module({
  imports: [
    // ── Existing modules ──────────────────────────────────
    // WorkspacesModule,
    // CampaignsModule,
    // LeadsModule,

    // ── Story 3.2: ICP Scoring Engine ─────────────────────
    // Registers these REST endpoints automatically:
    //   POST /icp-scoring/batch
    //   POST /icp-scoring/single
    //   GET  /icp-scoring/leads/:campaignId
    //   POST /icp-scoring/workspace/icp
    //   GET  /icp-scoring/workspace/icp/:workspaceId
    ICPScoringModule,
  ],
})
export class AppModule {}

// ─────────────────────────────────────────────────────────────
//  Bootstrap function  (main.ts)
//
//  Add the worker registration call AFTER app.listen() so
//  the worker runs as a background daemon alongside the API.
// ─────────────────────────────────────────────────────────────

async function bootstrap() {
  // const app = await NestFactory.create(AppModule);
  // await app.listen(3000);

  // ── Spin up the ICP scoring BullMQ worker ────────────────
  // Runs in the same process, separate execution context.
  // In production, consider running workers in a separate
  // Dockerfile CMD so they scale independently.
  registerICPScoringWorker(getRedisConfig());

  console.log('[Bootstrap] ICP Scoring Worker registered');
}

bootstrap();

// ─────────────────────────────────────────────────────────────
//  Story 3.1 Scraper → Story 3.2 Scoring Hand-off
//
//  At the END of your scraper BullMQ worker job handler,
//  add this call to hand extracted leads off for scoring:
// ─────────────────────────────────────────────────────────────

/*
import { enqueueICPScoringJob } from './icp-scoring/icp-scoring.worker';
import { getRedisConfig }       from './common/config';
import { fetchWorkspaceICP }    from './icp-scoring/icp-scoring.repository';

// Inside your scraper worker job handler:
async function handleScraperJob(job) {
  const { campaign_id, workspace_id } = job.data;

  // ... your existing scraping logic ...
  const extractedLeads = await scrapeLinkedInSearch(job.data.search_url);

  // Fetch the workspace ICP once (cached by DB connection pool)
  const icp_criteria = await fetchWorkspaceICP(workspace_id);

  if (!icp_criteria) {
    console.warn(`[Scraper] No ICP configured for workspace ${workspace_id} — skipping scoring`);
    return;
  }

  // Hand off to scoring engine
  await enqueueICPScoringJob(getRedisConfig(), {
    campaign_id,
    workspace_id,
    leads: extractedLeads,
    icp_criteria,             // inline for speed — avoids second DB round-trip in worker
  });
}
*/
