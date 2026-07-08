// ─────────────────────────────────────────────────────────────
//  Story 3.2 – AI-Powered Lead Matching & Scoring Engine
//  Database Persistence Layer  (icp-scoring.repository.ts)
//
//  Handles writing icp_score and pipeline_state back to the
//  `leads` table after batch scoring completes.
//
//  Uses raw `pg` (node-postgres) matching the Sprint 1 DDL.
//  Swap Pool import for your TypeORM/Knex instance if preferred.
// ─────────────────────────────────────────────────────────────

import { Pool, PoolClient } from 'pg';
import { ScoredLead } from './icp-scoring.types';

// ─── Connection Pool ──────────────────────────────────────────
// Reads DATABASE_URL from environment: postgresql://user:pass@host:5432/db
let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    _pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    _pool.on('error', (err) => {
      console.error('[ICPRepository] Unexpected pool error:', err);
    });
  }
  return _pool;
}

// ─────────────────────────────────────────────────────────────
//  1. PERSIST SCORED LEADS (qualified + disqualified together)
// ─────────────────────────────────────────────────────────────

/**
 * Upserts icp_score and pipeline_state for every scored lead.
 *
 * Qualified leads  → pipeline_state stays 'DISCOVERED' (or 'IN_PROGRESS' if already set)
 * Disqualified     → pipeline_state forced to 'STOPPED'
 *
 * Uses a single transaction with batched UPDATE statements
 * to minimise round-trips on large lead sets (up to 100 rows).
 */
export async function persistScoredLeads(
  qualifiedLeads: ScoredLead[],
  disqualifiedLeads: ScoredLead[],
): Promise<void> {
  const pool   = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // ── Qualified leads: write score, keep pipeline moving ──
    if (qualifiedLeads.length > 0) {
      await batchUpdateScores(client, qualifiedLeads, 'DISCOVERED');
    }

    // ── Disqualified leads: write score, halt pipeline ───────
    if (disqualifiedLeads.length > 0) {
      await batchUpdateScores(client, disqualifiedLeads, 'STOPPED');
    }

    await client.query('COMMIT');

    console.log(
      `[ICPRepository] Persisted ${qualifiedLeads.length} qualified, ` +
        `${disqualifiedLeads.length} disqualified leads.`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[ICPRepository] Transaction rolled back:', err);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Executes batched UPDATE using PostgreSQL's unnest() for efficiency.
 * Single query regardless of lead count – avoids N+1 problem.
 */
async function batchUpdateScores(
  client: PoolClient,
  scored: ScoredLead[],
  pipelineState: 'DISCOVERED' | 'STOPPED',
): Promise<void> {
  // Build parallel arrays for unnest
  const ids         = scored.map(sl => sl.lead.id);
  const scores      = scored.map(sl => sl.icp_score);
  const rationales  = scored.map(sl => sl.score_rationale);
  const titleScores = scored.map(sl => sl.sub_scores.title_match);
  const indScores   = scored.map(sl => sl.sub_scores.industry_match);
  const locScores   = scored.map(sl => sl.sub_scores.location_match);
  const hcScores    = scored.map(sl => sl.sub_scores.headcount_match);
  const semScores   = scored.map(sl => sl.sub_scores.semantic_bio);

  // Merge sub-scores into the metadata JSONB column so they're
  // queryable without a separate table – matches the DDL's JSONB
  // metadata column on the leads table.
  await client.query(
    `
    UPDATE leads AS l
    SET
      icp_score      = v.score::INT,
      pipeline_state = $1::pipeline_status,
      metadata       = COALESCE(l.metadata, '{}'::jsonb) || jsonb_build_object(
                         'icp_rationale',      v.rationale,
                         'sub_score_title',    v.title_score::INT,
                         'sub_score_industry', v.ind_score::INT,
                         'sub_score_location', v.loc_score::INT,
                         'sub_score_headcount',v.hc_score::INT,
                         'sub_score_semantic', v.sem_score::INT
                       ),
      updated_at     = NOW()
    FROM (
      SELECT
        UNNEST($2::uuid[])   AS id,
        UNNEST($3::int[])    AS score,
        UNNEST($4::text[])   AS rationale,
        UNNEST($5::int[])    AS title_score,
        UNNEST($6::int[])    AS ind_score,
        UNNEST($7::int[])    AS loc_score,
        UNNEST($8::int[])    AS hc_score,
        UNNEST($9::int[])    AS sem_score
    ) AS v
    WHERE l.id = v.id
    `,
    [
      pipelineState,
      ids,
      scores,
      rationales,
      titleScores,
      indScores,
      locScores,
      hcScores,
      semScores,
    ],
  );
}

// ─────────────────────────────────────────────────────────────
//  2. FETCH ICP CRITERIA FOR A WORKSPACE
// ─────────────────────────────────────────────────────────────
//  The scraper worker calls this before enqueuing a scoring job
//  so it doesn't need to pass the full ICP object through Redis.

import { ICPCriteria } from './icp-scoring.types';

/**
 * Reads the ICP definition stored in the workspace's metadata JSONB column.
 * Returns null if the workspace has no ICP configured yet.
 */
export async function fetchWorkspaceICP(
  workspaceId: string,
): Promise<ICPCriteria | null> {
  const pool = getPool();

  const { rows } = await pool.query<{ icp_criteria: ICPCriteria }>(
    `SELECT metadata->>'icp_criteria' AS icp_criteria
       FROM workspaces
      WHERE id = $1`,
    [workspaceId],
  );

  if (!rows[0]?.icp_criteria) return null;

  // metadata stores it as a JSON string inside JSONB
  const raw = rows[0].icp_criteria;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/**
 * Saves (or overwrites) the ICP criteria for a workspace.
 * Called from the workspace settings API when an admin updates their ICP.
 */
export async function saveWorkspaceICP(
  workspaceId: string,
  icp: ICPCriteria,
): Promise<void> {
  const pool = getPool();

  await pool.query(
    `UPDATE workspaces
        SET metadata   = COALESCE(metadata, '{}'::jsonb)
                         || jsonb_build_object('icp_criteria', $2::jsonb),
            updated_at = NOW()
      WHERE id = $1`,
    [workspaceId, JSON.stringify(icp)],
  );
}

// ─────────────────────────────────────────────────────────────
//  3. READ-BACK HELPERS  (used by FE lead grid – Story 3.3)
// ─────────────────────────────────────────────────────────────

export interface LeadScoreRow {
  id: string;
  full_name: string;
  job_title: string;
  icp_score: number;
  pipeline_state: string;
  icp_rationale: string;
  sub_scores: {
    title: number;
    industry: number;
    location: number;
    headcount: number;
    semantic: number;
  };
}

/**
 * Returns all leads for a campaign sorted by icp_score DESC.
 * Supports the sortable lead grid in the FE (Story 3.3).
 */
export async function fetchCampaignLeadScores(
  campaignId: string,
  minScore = 0,
): Promise<LeadScoreRow[]> {
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT
       id,
       full_name,
       metadata->>'job_title'          AS job_title,
       icp_score,
       pipeline_state,
       metadata->>'icp_rationale'      AS icp_rationale,
       (metadata->>'sub_score_title')::int    AS sub_title,
       (metadata->>'sub_score_industry')::int AS sub_industry,
       (metadata->>'sub_score_location')::int AS sub_location,
       (metadata->>'sub_score_headcount')::int AS sub_headcount,
       (metadata->>'sub_score_semantic')::int AS sub_semantic
     FROM leads
    WHERE campaign_id = $1
      AND icp_score  >= $2
    ORDER BY icp_score DESC`,
    [campaignId, minScore],
  );

  return rows.map(r => ({
    id:             r.id,
    full_name:      r.full_name,
    job_title:      r.job_title ?? '',
    icp_score:      r.icp_score,
    pipeline_state: r.pipeline_state,
    icp_rationale:  r.icp_rationale ?? '',
    sub_scores: {
      title:     r.sub_title     ?? 0,
      industry:  r.sub_industry  ?? 0,
      location:  r.sub_location  ?? 0,
      headcount: r.sub_headcount ?? 0,
      semantic:  r.sub_semantic  ?? 0,
    },
  }));
}
