// ─────────────────────────────────────────────────────────────
//  Story 3.2 – AI-Powered Lead Matching & Scoring Engine
//  NestJS Controller  (icp-scoring.controller.ts)
//
//  Endpoints
//  ─────────────────────────────────────────────────────────────
//  POST /icp-scoring/batch          ← scraper worker hand-off
//  POST /icp-scoring/single         ← FE manual re-score
//  GET  /icp-scoring/leads/:id      ← FE lead grid data
//  POST /icp-scoring/workspace/icp  ← admin saves ICP config
//  GET  /icp-scoring/workspace/icp  ← admin reads ICP config
// ─────────────────────────────────────────────────────────────

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { batchScoreLeads, scoreLead }               from './icp-scoring.service';
import {
  persistScoredLeads,
  fetchWorkspaceICP,
  saveWorkspaceICP,
  fetchCampaignLeadScores,
}                                                    from './icp-scoring.repository';
import {
  LeadProfile,
  ICPCriteria,
  ScoredLead,
  BatchScoringResult,
}                                                    from './icp-scoring.types';

// ─── Request / Response DTOs ──────────────────────────────────

class BatchScoreDto {
  campaign_id!:  string;
  workspace_id!: string;
  leads!:        LeadProfile[];
  icp_criteria!: ICPCriteria;
}

class SingleScoreDto {
  lead!:         LeadProfile;
  icp_criteria!: ICPCriteria;
}

class SaveICPDto {
  workspace_id!: string;
  icp_criteria!: ICPCriteria;
}

// ─── Controller ───────────────────────────────────────────────

@Controller('icp-scoring')
export class ICPScoringController {
  private readonly logger = new Logger(ICPScoringController.name);

  // ───────────────────────────────────────────────────────────
  //  POST /icp-scoring/batch
  //
  //  Primary entry-point called by the BullMQ scraper worker
  //  (Story 3.1) after extracting up to 100 leads from a
  //  LinkedIn search URL.
  //
  //  Scores → persists → returns qualified / disqualified split.
  // ───────────────────────────────────────────────────────────
  @Post('batch')
  @HttpCode(HttpStatus.OK)
  async batchScore(@Body() body: BatchScoreDto): Promise<BatchScoringResult> {
    if (!body.leads?.length) {
      throw new BadRequestException('leads array must not be empty');
    }
    if (!body.icp_criteria?.icp_description) {
      throw new BadRequestException('icp_criteria.icp_description is required');
    }

    this.logger.log(
      `Batch score – campaign: ${body.campaign_id} | ` +
        `leads: ${body.leads.length} | ` +
        `threshold: ${body.icp_criteria.minimum_score_threshold}`,
    );

    const result = await batchScoreLeads(body.leads, body.icp_criteria);

    // Persist scores to leads table in a single DB transaction
    await persistScoredLeads(result.qualified_leads, result.disqualified_leads);

    this.logger.log(
      `Batch complete – qualified: ${result.summary.total_qualified} / ` +
        `${result.summary.total_processed} | ` +
        `avg: ${result.summary.average_score} | ` +
        `${result.summary.processing_time_ms}ms`,
    );

    return result;
  }

  // ───────────────────────────────────────────────────────────
  //  POST /icp-scoring/single
  //
  //  On-demand re-score for a single lead.
  //  Triggered by the FE lead grid's "Re-score" button.
  //  Does NOT persist – caller decides what to do with result.
  // ───────────────────────────────────────────────────────────
  @Post('single')
  @HttpCode(HttpStatus.OK)
  async singleScore(@Body() body: SingleScoreDto): Promise<ScoredLead> {
    if (!body.lead?.id) {
      throw new BadRequestException('lead.id is required');
    }
    if (!body.icp_criteria?.icp_description) {
      throw new BadRequestException('icp_criteria.icp_description is required');
    }

    this.logger.log(`Single score request – lead: ${body.lead.id}`);

    return scoreLead(body.lead, body.icp_criteria);
  }

  // ───────────────────────────────────────────────────────────
  //  GET /icp-scoring/leads/:campaignId
  //
  //  Returns all scored leads for a campaign sorted by
  //  icp_score DESC – consumed by the FE lead grid (Story 3.3).
  //
  //  Query params:
  //    ?min_score=75   (default 0 – return all)
  // ───────────────────────────────────────────────────────────
  @Get('leads/:campaignId')
  async getCampaignLeads(
    @Param('campaignId') campaignId: string,
    @Query('min_score')  minScoreStr?: string,
  ) {
    if (!campaignId) {
      throw new BadRequestException('campaignId param is required');
    }

    const minScore = minScoreStr ? parseInt(minScoreStr, 10) : 0;

    this.logger.log(
      `Fetching leads for campaign ${campaignId} (min_score=${minScore})`,
    );

    const leads = await fetchCampaignLeadScores(campaignId, minScore);

    return {
      campaign_id:   campaignId,
      total:         leads.length,
      min_score:     minScore,
      leads,
    };
  }

  // ───────────────────────────────────────────────────────────
  //  POST /icp-scoring/workspace/icp
  //
  //  Saves (or updates) the workspace ICP definition.
  //  Called from the workspace settings page when an admin
  //  configures or updates their ideal customer profile.
  // ───────────────────────────────────────────────────────────
  @Post('workspace/icp')
  @HttpCode(HttpStatus.OK)
  async saveICP(@Body() body: SaveICPDto) {
    if (!body.workspace_id) {
      throw new BadRequestException('workspace_id is required');
    }
    if (!body.icp_criteria?.icp_description) {
      throw new BadRequestException('icp_criteria.icp_description is required');
    }

    await saveWorkspaceICP(body.workspace_id, body.icp_criteria);

    this.logger.log(`ICP saved for workspace: ${body.workspace_id}`);

    return {
      success:      true,
      workspace_id: body.workspace_id,
      message:      'ICP criteria saved. New leads will be scored against this profile.',
    };
  }

  // ───────────────────────────────────────────────────────────
  //  GET /icp-scoring/workspace/icp/:workspaceId
  //
  //  Reads the current ICP definition for a workspace.
  //  Used by the FE settings page to pre-fill the ICP form.
  // ───────────────────────────────────────────────────────────
  @Get('workspace/icp/:workspaceId')
  async getICP(@Param('workspaceId') workspaceId: string) {
    if (!workspaceId) {
      throw new BadRequestException('workspaceId param is required');
    }

    const icp = await fetchWorkspaceICP(workspaceId);

    if (!icp) {
      throw new NotFoundException(
        `No ICP configured for workspace ${workspaceId}. ` +
          'Set one up in workspace settings.',
      );
    }

    return { workspace_id: workspaceId, icp_criteria: icp };
  }
}
