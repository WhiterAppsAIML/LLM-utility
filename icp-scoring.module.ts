// ─────────────────────────────────────────────────────────────
//  Story 3.2 – AI-Powered Lead Matching & Scoring Engine
//  NestJS Module  (icp-scoring.module.ts)
// ─────────────────────────────────────────────────────────────

import { Module }               from '@nestjs/common';
import { ICPScoringController } from './icp-scoring.controller';

@Module({
  controllers: [ICPScoringController],
  // Service functions and repository functions are plain async
  // exports – imported directly where needed, no DI required.
  // If you migrate to TypeORM, inject repositories here.
})
export class ICPScoringModule {}
