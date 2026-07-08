// ─────────────────────────────────────────────────────────────
//  Story 3.2 – AI-Powered Lead Matching & Scoring Engine
//  Core Scoring Utility  (icp-scoring.service.ts)
//
//  Architecture
//  ┌─────────────────────────────────────────────────┐
//  │  scoreLead(lead, icp)                           │
//  │   ├─ scoreTitle()        deterministic  0–25    │
//  │   ├─ scoreIndustry()     deterministic  0–20    │
//  │   ├─ scoreLocation()     deterministic  0–15    │
//  │   ├─ scoreHeadcount()    deterministic  0–15    │
//  │   └─ scoreSemanticBio()  LLM (Gemini)   0–25   │
//  │                                                  │
//  │  composite = Σ sub-scores   (max = 100)          │
//  └─────────────────────────────────────────────────┘
// ─────────────────────────────────────────────────────────────

import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  LeadProfile,
  ICPCriteria,
  ScoredLead,
  BatchScoringResult,
  LLMScoringResponse,
} from './icp-scoring.types';

// ─── Constants ────────────────────────────────────────────────
const MAX_TITLE_SCORE     = 25;
const MAX_INDUSTRY_SCORE  = 20;
const MAX_LOCATION_SCORE  = 15;
const MAX_HEADCOUNT_SCORE = 15;
const MAX_SEMANTIC_SCORE  = 25;

// gemini-2.0-flash: free tier, 15 req/min, 1M tokens/day
const LLM_MODEL           = 'gemini-2.0-flash';

// Keep concurrency under free-tier rate limit (15 req/min)
const BATCH_CONCURRENCY   = 5;

// ─── Gemini Client ────────────────────────────────────────────
// Reads GEMINI_API_KEY from environment.
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');
const geminiModel = genAI.getGenerativeModel({
  model: LLM_MODEL,
  generationConfig: {
    temperature:      0.1,  // low = consistent JSON output
    maxOutputTokens:  512,
    responseMimeType: 'application/json', // forces pure JSON, no markdown fences
  },
});

// ═════════════════════════════════════════════════════════════
//  1. DETERMINISTIC SUB-SCORERS  (no API calls – free)
// ═════════════════════════════════════════════════════════════

/**
 * Fuzzy title match.
 * Full points  → exact keyword hit in the lead's title.
 * Partial pts  → partial substring hit (e.g. "Sales" matches "VP of Sales").
 * Zero         → no match at all.
 */
function scoreTitle(lead: LeadProfile, icp: ICPCriteria): number {
  if (!lead.job_title) return 0;

  const title = lead.job_title.toLowerCase();

  for (const target of icp.target_titles) {
    const t = target.toLowerCase();
    if (title === t) return MAX_TITLE_SCORE;
    if (title.includes(t) || t.includes(title)) {
      return Math.round(MAX_TITLE_SCORE * 0.7);
    }
  }

  // Keyword-level partial – catch "Head of Sales" vs "VP Sales"
  const titleWords = new Set(title.split(/\s+/));
  const icpWords   = icp.target_titles.join(' ').toLowerCase().split(/\s+/);
  const overlap    = icpWords.filter(w => w.length > 3 && titleWords.has(w));

  if (overlap.length > 0) return Math.round(MAX_TITLE_SCORE * 0.4);

  return 0;
}

/** Industry match – case-insensitive, partial substring allowed. */
function scoreIndustry(lead: LeadProfile, icp: ICPCriteria): number {
  if (!lead.industry) return 0;

  const industry = lead.industry.toLowerCase();

  for (const target of icp.target_industries) {
    if (industry.includes(target.toLowerCase())) return MAX_INDUSTRY_SCORE;
  }

  return 0;
}

/** Location match – partial city / country string matching. */
function scoreLocation(lead: LeadProfile, icp: ICPCriteria): number {
  if (!lead.location) return 0;

  const location = lead.location.toLowerCase();

  for (const target of icp.target_locations) {
    if (location.includes(target.toLowerCase())) return MAX_LOCATION_SCORE;
  }

  return 0;
}

/**
 * Headcount match.
 * Parses LinkedIn headcount strings like "11-50", "201-500", "1,001-5,000".
 */
function scoreHeadcount(lead: LeadProfile, icp: ICPCriteria): number {
  if (!lead.company_headcount) return 0;

  const cleaned = lead.company_headcount.replace(/,/g, '');
  const numbers = cleaned.match(/\d+/g);

  if (!numbers || numbers.length === 0) return 0;

  const low  = parseInt(numbers[0], 10);
  const high = numbers[1] ? parseInt(numbers[1], 10) : low;
  const { min, max } = icp.company_headcount;

  if (low >= min && high <= max) return MAX_HEADCOUNT_SCORE;           // full overlap
  if (low <= max && high >= min) return Math.round(MAX_HEADCOUNT_SCORE * 0.5); // partial

  return 0;
}

// ═════════════════════════════════════════════════════════════
//  2. GEMINI SEMANTIC SCORER
// ═════════════════════════════════════════════════════════════

function buildScoringPrompt(lead: LeadProfile, icp: ICPCriteria): string {
  const leadContext = [
    `Name: ${lead.full_name}`,
    `Title: ${lead.job_title}`,
    `Company: ${lead.company}`,
    lead.industry          ? `Industry: ${lead.industry}`                : null,
    lead.location          ? `Location: ${lead.location}`                : null,
    lead.company_headcount ? `Company Size: ${lead.company_headcount}`   : null,
    lead.bio               ? `Bio:\n${lead.bio.slice(0, 800)}`           : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `You are an expert B2B sales qualifier. Evaluate how well a LinkedIn prospect matches an Ideal Customer Profile (ICP).

## ICP Definition
${icp.icp_description}

Target Titles    : ${icp.target_titles.join(', ')}
Target Industries: ${icp.target_industries.join(', ')}
Target Locations : ${icp.target_locations.join(', ')}
Headcount Range  : ${icp.company_headcount.min}–${icp.company_headcount.max} employees

## Lead Profile
${leadContext}

## Instructions
Score the prospect's semantic alignment with the ICP on a scale of 0 to 25:
- 0–5   : Poor fit – wrong persona, wrong stage, or wrong domain
- 6–12  : Partial fit – some signals but clear gaps
- 13–19 : Good fit – most criteria match
- 20–25 : Excellent fit – textbook ICP match

Focus on depth signals from the bio and role context only.

Respond with ONLY this JSON shape, nothing else:
{"semantic_score": <integer 0-25>, "rationale": "<max 2 sentences>"}`;
}

/**
 * Calls Gemini API for semantic bio scoring.
 * Falls back to score 0 gracefully if the API call fails.
 */
async function scoreSemanticBio(
  lead: LeadProfile,
  icp: ICPCriteria,
): Promise<{ score: number; rationale: string }> {
  if (!lead.bio && !lead.job_title) {
    return { score: 0, rationale: 'No bio or title available for semantic analysis.' };
  }

  let rawText = '';

  try {
    const result = await geminiModel.generateContent(buildScoringPrompt(lead, icp));
    rawText = result.response.text();

    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/```json|```/gi, '').trim();
    const parsed: LLMScoringResponse = JSON.parse(cleaned);

    const score = Math.min(
      MAX_SEMANTIC_SCORE,
      Math.max(0, Math.round(parsed.semantic_score)),
    );

    return { score, rationale: parsed.rationale ?? '' };

  } catch (err) {
    console.error(
      `[ICPScorer] Gemini error for lead ${lead.id}:`,
      (err as Error).message,
      '| Raw:', rawText,
    );
    return {
      score: 0,
      rationale: 'LLM scoring unavailable; using deterministic signals only.',
    };
  }
}

// ═════════════════════════════════════════════════════════════
//  3. COMPOSITE SCORER
// ═════════════════════════════════════════════════════════════

/**
 * Scores a single lead. Combines 4 deterministic sub-scores
 * with 1 Gemini semantic score.
 */
export async function scoreLead(
  lead: LeadProfile,
  icp: ICPCriteria,
): Promise<ScoredLead> {
  const title_match     = scoreTitle(lead, icp);
  const industry_match  = scoreIndustry(lead, icp);
  const location_match  = scoreLocation(lead, icp);
  const headcount_match = scoreHeadcount(lead, icp);

  const { score: semantic_bio, rationale } = await scoreSemanticBio(lead, icp);

  const icp_score =
    title_match + industry_match + location_match + headcount_match + semantic_bio;

  return {
    lead,
    icp_score,
    passes_threshold: icp_score >= icp.minimum_score_threshold,
    score_rationale:  rationale,
    sub_scores: {
      title_match,
      industry_match,
      location_match,
      headcount_match,
      semantic_bio,
    },
  };
}

// ═════════════════════════════════════════════════════════════
//  4. BATCH PROCESSOR
// ═════════════════════════════════════════════════════════════

/**
 * Processes up to 100 leads in controlled concurrent batches.
 * Primary entry-point called by the Story 3.1 scraper worker.
 */
export async function batchScoreLeads(
  leads: LeadProfile[],
  icp: ICPCriteria,
): Promise<BatchScoringResult> {
  const startTime = Date.now();
  const results: ScoredLead[] = [];

  for (let i = 0; i < leads.length; i += BATCH_CONCURRENCY) {
    const chunk = leads.slice(i, i + BATCH_CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(lead => scoreLead(lead, icp)),
    );
    results.push(...chunkResults);

    // 4s pause between chunks – respects Gemini free tier (15 req/min)
    if (i + BATCH_CONCURRENCY < leads.length) {
      await new Promise(resolve => setTimeout(resolve, 4000));
    }
  }

  results.sort((a, b) => b.icp_score - a.icp_score);

  const qualified    = results.filter(r => r.passes_threshold);
  const disqualified = results.filter(r => !r.passes_threshold);
  const avgScore     = results.length > 0
    ? Math.round(results.reduce((acc, r) => acc + r.icp_score, 0) / results.length)
    : 0;

  return {
    qualified_leads:    qualified,
    disqualified_leads: disqualified,
    summary: {
      total_processed:    results.length,
      total_qualified:    qualified.length,
      total_disqualified: disqualified.length,
      average_score:      avgScore,
      processing_time_ms: Date.now() - startTime,
    },
  };
}
