-- ─────────────────────────────────────────────────────────────
--  Migration 001: ICP Scoring Engine Columns
--  Sprint 3  /  Story 3.2
--
--  Run after Sprint 1 DDL has been applied.
--  Safe to re-run (IF NOT EXISTS guards throughout).
--
--  Changes:
--    1. workspaces   – add metadata JSONB column to store ICP config
--    2. leads        – add metadata JSONB column for sub-scores + rationale
--    3. leads        – add account_warmup_day INT for warm-up curve tracking
--    4. linkedin_accounts – add connected_at TIMESTAMP for warm-up calc
--    5. New index    – GIN on leads.metadata for fast JSONB querying
-- ─────────────────────────────────────────────────────────────

BEGIN;

-- ── 1. workspaces: metadata column ───────────────────────────
--
--  Stores the workspace ICP definition as a JSONB blob.
--  Shape (set by POST /icp-scoring/workspace/icp):
--  {
--    "icp_criteria": {
--      "target_titles":        ["Founder", "VP of Sales"],
--      "target_industries":    ["SaaS"],
--      "company_headcount":    { "min": 11, "max": 200 },
--      "target_locations":     ["Pune", "San Francisco"],
--      "icp_description":      "B2B SaaS founders...",
--      "minimum_score_threshold": 65
--    }
--  }

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN workspaces.metadata IS
  'Stores workspace-level config blobs, including icp_criteria for the AI scoring engine.';

-- ── 2. leads: metadata column ────────────────────────────────
--
--  Stores scraper output + ICP sub-scores written back by the
--  scoring engine after batchScoreLeads() completes.
--  Shape:
--  {
--    "job_title":            "VP of Sales",
--    "company":              "Apex Scale",
--    "company_headcount":    "51-200",
--    "industry":             "SaaS",
--    "location":             "Pune, India",
--    "bio":                  "Building...",
--    "icp_rationale":        "Strong ICP match — title and industry align.",
--    "sub_score_title":      25,
--    "sub_score_industry":   20,
--    "sub_score_location":   15,
--    "sub_score_headcount":  15,
--    "sub_score_semantic":   18
--  }

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN leads.metadata IS
  'Scraper output + ICP sub-scores (title, industry, location, headcount, semantic) written by the scoring engine.';

-- ── 3. leads: account warm-up day tracker ────────────────────
--
--  Records which warm-up day the sending account was on when
--  this lead entered the campaign — used for retrospective
--  analysis of delivery rates vs account maturity.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS account_warmup_day INT NOT NULL DEFAULT 0
  CHECK (account_warmup_day >= 0);

COMMENT ON COLUMN leads.account_warmup_day IS
  'Warm-up day (0-indexed) of the sender account at the time this lead was injected into the campaign.';

-- ── 4. linkedin_accounts: connected_at timestamp ─────────────
--
--  Needed by getAccountCaps() to compute elapsed days for
--  the warm-up formula: Wₙ = BaseCap × (1 + n/14).
--  Defaults to created_at so existing rows are not broken.

ALTER TABLE linkedin_accounts
  ADD COLUMN IF NOT EXISTS connected_at TIMESTAMP WITH TIME ZONE
  DEFAULT CURRENT_TIMESTAMP;

UPDATE linkedin_accounts
   SET connected_at = created_at
 WHERE connected_at IS NULL;

COMMENT ON COLUMN linkedin_accounts.connected_at IS
  'Timestamp when the account was first successfully authenticated. Used to compute warm-up day n for daily cap enforcement.';

-- ── 5. Performance indexes ────────────────────────────────────

-- Fast JSONB sub-score queries on the leads table
CREATE INDEX IF NOT EXISTS idx_leads_metadata_gin
  ON leads USING gin (metadata);

-- Fast ICP config lookup on workspaces
CREATE INDEX IF NOT EXISTS idx_workspaces_metadata_gin
  ON workspaces USING gin (metadata);

-- Fast warm-up day filtering for Sprint 5 rotation logic
CREATE INDEX IF NOT EXISTS idx_linkedin_accounts_connected_at
  ON linkedin_accounts (connected_at);

-- ── 6. Convenience view: scored leads  ───────────────────────
--
--  Used by GET /icp-scoring/leads/:campaignId to avoid
--  repetitive JSONB extraction in application code.

CREATE OR REPLACE VIEW v_scored_leads AS
SELECT
  l.id,
  l.campaign_id,
  l.linkedin_url,
  l.full_name,
  l.icp_score,
  l.pipeline_state,
  l.account_warmup_day,
  l.created_at,
  l.updated_at,
  -- Flattened scraper fields
  l.metadata->>'job_title'            AS job_title,
  l.metadata->>'company'              AS company,
  l.metadata->>'industry'             AS industry,
  l.metadata->>'location'             AS location,
  l.metadata->>'company_headcount'    AS company_headcount,
  -- ICP scoring output
  l.metadata->>'icp_rationale'                        AS icp_rationale,
  (l.metadata->>'sub_score_title')::INT               AS sub_score_title,
  (l.metadata->>'sub_score_industry')::INT            AS sub_score_industry,
  (l.metadata->>'sub_score_location')::INT            AS sub_score_location,
  (l.metadata->>'sub_score_headcount')::INT           AS sub_score_headcount,
  (l.metadata->>'sub_score_semantic')::INT            AS sub_score_semantic
FROM leads l;

COMMENT ON VIEW v_scored_leads IS
  'Flattened view of leads with ICP sub-scores extracted from JSONB metadata. Used by FE lead grid (Story 3.3).';

COMMIT;
