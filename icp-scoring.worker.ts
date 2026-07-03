// ─────────────────────────────────────────────────────────────
//  Story 3.2 – AI-Powered Lead Matching & Scoring Engine
//  BullMQ Worker  (icp-scoring.worker.ts)  — production build
//
//  Flow
//  ────
//  [Story 3.1 Scraper Job completes]
//       │
//       ▼  enqueueICPScoringJob()
//  'icp-scoring' BullMQ queue
//       │
//       ▼  registerICPScoringWorker() picks up job
//       ├─ batchScoreLeads()           LLM + deterministic
//       ├─ persistScoredLeads()        single DB transaction
//       └─ emits 'scoring.complete'    for downstream listeners
// ─────────────────────────────────────────────────────────────

import { Worker, Queue, Job } from 'bullmq';
import { batchScoreLeads }    from './icp-scoring.service';
import { persistScoredLeads, fetchWorkspaceICP } from './icp-scoring.repository';
import { LeadProfile, ICPCriteria }              from './icp-scoring.types';

// ─── Redis connection type ────────────────────────────────────

export interface RedisConnection {
  host: string;
  port: number;
  password?: string;
}

// ─── Job Payload ──────────────────────────────────────────────

export interface ICPScoringJobPayload {
  /** Campaign UUID – used for DB updates */
  campaign_id: string;

  /** Workspace UUID – used to fetch ICP if not inlined */
  workspace_id: string;

  /** Leads extracted by the Story 3.1 scraper worker */
  leads: LeadProfile[];

  /**
   * ICP criteria – inlined by the scraper for speed.
   * If omitted, worker fetches from workspaces.metadata.
   */
  icp_criteria?: ICPCriteria;
}

export interface ICPScoringJobResult {
  campaign_id:        string;
  total_processed:    number;
  total_qualified:    number;
  total_disqualified: number;
  average_score:      number;
  processing_time_ms: number;
}

// ─────────────────────────────────────────────────────────────
//  1. ENQUEUE HELPER
//  Called by the Story 3.1 scraper worker after extracting leads
// ─────────────────────────────────────────────────────────────

let _queue: Queue | null = null;

/**
 * Returns (or lazily creates) the shared BullMQ queue instance.
 */
export function getICPScoringQueue(redis: RedisConnection): Queue {
  if (!_queue) {
    _queue = new Queue<ICPScoringJobPayload>('icp-scoring', {
      connection: redis,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail:     { count: 50  },
      },
    });
  }
  return _queue;
}

/**
 * Enqueues a scoring job from the scraper worker.
 *
 * Usage (inside Story 3.1 scraper after extracting 100 leads):
 * ─────────────────────────────────────────────────────────────
 *   import { enqueueICPScoringJob } from './icp-scoring.worker';
 *
 *   await enqueueICPScoringJob(redis, {
 *     campaign_id:  job.data.campaign_id,
 *     workspace_id: job.data.workspace_id,
 *     leads:        extractedLeads,
 *     icp_criteria: workspaceICP,   // optional – fetched from DB if omitted
 *   });
 */
export async function enqueueICPScoringJob(
  redis: RedisConnection,
  payload: ICPScoringJobPayload,
): Promise<void> {
  const queue = getICPScoringQueue(redis);

  await queue.add(
    `score-campaign-${payload.campaign_id}`,
    payload,
    { jobId: `icp-${payload.campaign_id}-${Date.now()}` },
  );

  console.log(
    `[ICPQueue] Enqueued scoring job for campaign ${payload.campaign_id} ` +
      `(${payload.leads.length} leads)`,
  );
}

// ─────────────────────────────────────────────────────────────
//  2. WORKER REGISTRATION
// ─────────────────────────────────────────────────────────────

/**
 * Spins up the BullMQ worker that processes scoring jobs.
 * Call once during NestJS application bootstrap.
 *
 * Usage (in AppModule or a dedicated bootstrap file):
 * ─────────────────────────────────────────────────
 *   const redis = { host: 'localhost', port: 6379 };
 *   registerICPScoringWorker(redis);
 */
export function registerICPScoringWorker(redis: RedisConnection): Worker {
  const worker = new Worker<ICPScoringJobPayload, ICPScoringJobResult>(
    'icp-scoring',
    async (job: Job<ICPScoringJobPayload>) => {
      const { campaign_id, workspace_id, leads } = job.data;

      console.log(
        `[ICPWorker] ▶ Job ${job.id} started – ` +
          `${leads.length} leads | campaign: ${campaign_id}`,
      );

      // ── 1. Resolve ICP criteria ──────────────────────────────
      let icp = job.data.icp_criteria;

      if (!icp) {
        // Fallback: fetch from workspaces.metadata in DB
        const fetched = await fetchWorkspaceICP(workspace_id);

        if (!fetched) {
          throw new Error(
            `[ICPWorker] No ICP criteria found for workspace ${workspace_id}. ` +
              'Configure ICP in workspace settings before running campaigns.',
          );
        }
        icp = fetched;
      }

      // ── 2. Score all leads ───────────────────────────────────
      await job.updateProgress(5);

      const result = await batchScoreLeads(leads, icp);

      await job.updateProgress(80);

      // ── 3. Persist results to DB in a single transaction ─────
      await persistScoredLeads(
        result.qualified_leads,
        result.disqualified_leads,
      );

      await job.updateProgress(100);

      const summary: ICPScoringJobResult = {
        campaign_id,
        ...result.summary,
      };

      console.log(
        `[ICPWorker] ✓ Job ${job.id} complete – ` +
          `qualified: ${summary.total_qualified} | ` +
          `dropped: ${summary.total_disqualified} | ` +
          `avg: ${summary.average_score}/100 | ` +
          `${summary.processing_time_ms}ms`,
      );

      return summary;
    },
    {
      connection:  redis,
      concurrency: 3,   // 3 scoring jobs in parallel (each does 5 LLM calls concurrently)
    },
  );

  // ── Event listeners for observability ───────────────────────
  worker.on('failed', (job, err) => {
    console.error(
      `[ICPWorker] ✗ Job ${job?.id} failed (attempt ${job?.attemptsMade}):`,
      err.message,
    );
  });

  worker.on('stalled', (jobId) => {
    console.warn(`[ICPWorker] ⚠ Job ${jobId} stalled – will retry`);
  });

  console.log('[ICPWorker] Worker registered and listening on queue: icp-scoring');

  return worker;
}
