// ─────────────────────────────────────────────────────────────
//  Story 3.2 – ICP Scoring Engine
//  Standalone Test  (no DB, no Redis required)
//
//  Run:
//    export GEMINI_API_KEY=AIza...
//    npx ts-node test/icp-scoring.test.ts
// ─────────────────────────────────────────────────────────────

import { batchScoreLeads, scoreLead } from '../src/icp-scoring/icp-scoring.service';
import { LeadProfile, ICPCriteria }   from '../src/icp-scoring/icp-scoring.types';

// ─── Abort early if key is missing ───────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('\n❌  GEMINI_API_KEY is not set.');
  console.error('    Get a free key at: aistudio.google.com');
  console.error('    Then run:  export GEMINI_API_KEY=AIza...\n');
  process.exit(1);
}

// ─── Sample ICP ───────────────────────────────────────────────

const SAMPLE_ICP: ICPCriteria = {
  target_titles:    ['Founder', 'CEO', 'VP of Sales', 'Head of Growth', 'Chief Revenue Officer'],
  target_industries:['SaaS', 'Information Technology', 'B2B Software', 'Marketing Technology'],
  company_headcount:{ min: 10, max: 200 },
  target_locations: ['Pune', 'Mumbai', 'San Francisco', 'New York', 'India'],
  icp_description:
    'B2B SaaS founders and senior revenue leaders at early-to-growth stage companies ' +
    '(10–200 employees) who are actively building or scaling an outbound sales motion. ' +
    'Ideal candidates are frustrated with manual prospecting and want to automate LinkedIn outreach.',
  minimum_score_threshold: 65,
};

// ─── Sample Leads ─────────────────────────────────────────────

const LEADS: LeadProfile[] = [
  {
    id:                'lead-001',
    linkedin_url:      'https://linkedin.com/in/arjun-mehta-founder',
    full_name:         'Arjun Mehta',
    job_title:         'Founder & CEO',
    company:           'Growfast SaaS',
    company_headcount: '11-50',
    industry:          'SaaS',
    location:          'Pune, Maharashtra, India',
    bio: 'Building Growfast – a B2B SaaS tool helping SME sales teams automate their LinkedIn outreach. ' +
         'Previously at Salesforce. We have 3 AEs and need to scale pipeline fast without adding headcount.',
  },
  {
    id:                'lead-002',
    linkedin_url:      'https://linkedin.com/in/priya-sharma-vpsales',
    full_name:         'Priya Sharma',
    job_title:         'VP of Sales',
    company:           'NexaTech Solutions',
    company_headcount: '51-200',
    industry:          'Information Technology',
    location:          'Mumbai, India',
    bio: 'Leading a 12-person sales team at NexaTech. Biggest challenge is top-of-funnel volume. ' +
         'Experimenting with LinkedIn automation tools to increase demo bookings.',
  },
  {
    id:                'lead-003',
    linkedin_url:      'https://linkedin.com/in/james-walker-cro',
    full_name:         'James Walker',
    job_title:         'Chief Revenue Officer',
    company:           'PipelineIQ',
    company_headcount: '51-200',
    industry:          'Marketing Technology',
    location:          'San Francisco, CA',
    bio: 'CRO at PipelineIQ. Obsessed with building repeatable outbound systems. ' +
         'We use LinkedIn heavily for prospecting and are always testing new automation tools.',
  },
  {
    id:                'lead-004',
    linkedin_url:      'https://linkedin.com/in/rahul-banerjee-dev',
    full_name:         'Rahul Banerjee',
    job_title:         'Senior Software Engineer',
    company:           'Infosys',
    company_headcount: '10,001+',
    industry:          'IT Services',
    location:          'Bangalore, India',
    bio: 'Full-stack developer at Infosys. Working on internal tooling and cloud migrations. ' +
         'Passionate about open-source and Rust.',
  },
  {
    id:                'lead-005',
    linkedin_url:      'https://linkedin.com/in/sara-jones-head-growth',
    full_name:         'Sara Jones',
    job_title:         'Head of Growth',
    company:           'LaunchPad HQ',
    company_headcount: '11-50',
    industry:          'SaaS',
    location:          'New York, NY',
    bio: '',  // no bio – tests graceful fallback
  },
  {
    id:                'lead-006',
    linkedin_url:      'https://linkedin.com/in/anita-verma-hr',
    full_name:         'Anita Verma',
    job_title:         'HR Manager',
    company:           'BrightHire Co',
    company_headcount: '201-500',
    industry:          'Human Resources',
    location:          'Delhi, India',
    bio: 'HR professional focused on talent acquisition and employee engagement. ' +
         'No involvement in sales or marketing.',
  },
];

// ─── Helpers ──────────────────────────────────────────────────

function line(char = '─', len = 58) { return char.repeat(len); }

function printLead(sl: Awaited<ReturnType<typeof scoreLead>>) {
  const pass = sl.passes_threshold ? '✅ QUALIFIED' : '❌ DROPPED  ';
  console.log(`\n  ${pass}  ${sl.lead.full_name}`);
  console.log(`           ${sl.lead.job_title} @ ${sl.lead.company}`);
  console.log(`  Score    : ${sl.icp_score}/100`);
  console.log(
    `  Breakdown: title=${sl.sub_scores.title_match} | ` +
    `industry=${sl.sub_scores.industry_match} | ` +
    `location=${sl.sub_scores.location_match} | ` +
    `headcount=${sl.sub_scores.headcount_match} | ` +
    `semantic=${sl.sub_scores.semantic_bio}`,
  );
  if (sl.score_rationale) {
    console.log(`  Rationale: ${sl.score_rationale}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`\n  ✗ FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ✓ ${msg}`);
}

// ─── Main test runner ─────────────────────────────────────────

async function run() {
  console.log('\n' + line('═'));
  console.log('  ICP Scoring Engine — Standalone Test');
  console.log('  LLM: Gemini 2.0 Flash (free tier)');
  console.log(line('═'));
  console.log(`\n  Threshold : ${SAMPLE_ICP.minimum_score_threshold}/100`);
  console.log(`  Leads     : ${LEADS.length}`);
  console.log(`  Note      : Gemini free tier = 15 req/min,`);
  console.log(`              4s pause between batches of 5`);
  console.log('\n' + line());

  // ── Batch score all leads ──────────────────────────────────
  console.log('\n  Scoring leads (this takes ~10–15 seconds)...\n');
  const result = await batchScoreLeads(LEADS, SAMPLE_ICP);

  // ── Print results ──────────────────────────────────────────
  console.log(line('═'));
  console.log('  RESULTS');
  console.log(line('═'));

  for (const sl of [...result.qualified_leads, ...result.disqualified_leads]) {
    printLead(sl);
  }

  // ── Summary ───────────────────────────────────────────────
  console.log('\n' + line('═'));
  console.log('  SUMMARY');
  console.log(line('─'));
  console.log(`  Total processed : ${result.summary.total_processed}`);
  console.log(`  Qualified       : ${result.summary.total_qualified}`);
  console.log(`  Dropped         : ${result.summary.total_disqualified}`);
  console.log(`  Average score   : ${result.summary.average_score}/100`);
  console.log(`  Time taken      : ${result.summary.processing_time_ms}ms`);
  console.log(line('═'));

  // ── Acceptance criteria ───────────────────────────────────
  console.log('\n  ACCEPTANCE CRITERIA');
  console.log(line('─'));

  const qualIds = result.qualified_leads.map(s => s.lead.id);
  const dropIds = result.disqualified_leads.map(s => s.lead.id);

  assert(qualIds.includes('lead-001'), 'Arjun Mehta (Founder, SaaS, Pune)     → QUALIFIED');
  assert(qualIds.includes('lead-002'), 'Priya Sharma (VP Sales, Mumbai)        → QUALIFIED');
  assert(qualIds.includes('lead-003'), 'James Walker (CRO, MarTech, SF)        → QUALIFIED');
  assert(dropIds.includes('lead-004'), 'Rahul Banerjee (Engineer, 10k+ co.)    → DROPPED');
  assert(dropIds.includes('lead-006'), 'Anita Verma (HR Manager)               → DROPPED');

  // Validate sub-scores always sum to icp_score
  for (const sl of [...result.qualified_leads, ...result.disqualified_leads]) {
    const sum =
      sl.sub_scores.title_match +
      sl.sub_scores.industry_match +
      sl.sub_scores.location_match +
      sl.sub_scores.headcount_match +
      sl.sub_scores.semantic_bio;
    assert(sum === sl.icp_score, `Sub-scores sum correctly for ${sl.lead.full_name}`);
  }

  console.log('\n' + line('═'));
  console.log('  ✅  All tests passed — engine is working correctly');
  console.log(line('═') + '\n');
}

run().catch(err => {
  console.error('\n❌  Test crashed:', err.message ?? err);
  process.exit(1);
});
