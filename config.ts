// ─────────────────────────────────────────────────────────────
//  Common Config Module  (src/common/config.ts)
//
//  Single source of truth for all environment variables used
//  by the ICP Scoring Engine.  Import this instead of reading
//  process.env directly in service/worker/repository files.
//
//  Required .env keys:
//  ───────────────────────────────────────────────────────────
//  ANTHROPIC_API_KEY     Your Anthropic API key
//  DATABASE_URL          PostgreSQL connection string
//  REDIS_HOST            Redis hostname          (default: localhost)
//  REDIS_PORT            Redis port              (default: 6379)
//  REDIS_PASSWORD        Redis password          (optional)
//  ICP_BATCH_CONCURRENCY LLM calls in parallel   (default: 5)
//  ICP_MIN_SCORE_DEFAULT Fallback threshold      (default: 65)
// ─────────────────────────────────────────────────────────────

function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`[Config] Missing required environment variable: ${key}`);
  return val;
}

function optional_env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

// ─── Exported config object ───────────────────────────────────

export const config = {
  anthropic: {
    apiKey: require_env('ANTHROPIC_API_KEY'),
    model:  'claude-sonnet-4-6' as const,
    maxTokens: 512,
  },

  db: {
    connectionString: require_env('DATABASE_URL'),
    poolMax:          10,
    idleTimeoutMs:    30_000,
    connectionTimeoutMs: 5_000,
  },

  redis: {
    host:     optional_env('REDIS_HOST', 'localhost'),
    port:     parseInt(optional_env('REDIS_PORT', '6379'), 10),
    password: process.env['REDIS_PASSWORD'],
  },

  scoring: {
    /** Max concurrent LLM calls per batch (respects Anthropic rate limits) */
    batchConcurrency: parseInt(optional_env('ICP_BATCH_CONCURRENCY', '5'), 10),

    /** Inter-chunk pause in ms to avoid API burst */
    chunkPauseMs: 200,

    /** Fallback min threshold when workspace ICP has none set */
    defaultMinScore: parseInt(optional_env('ICP_MIN_SCORE_DEFAULT', '65'), 10),

    /** Sub-score ceilings – must sum to 100 */
    maxScores: {
      title:     25,
      industry:  20,
      location:  15,
      headcount: 15,
      semantic:  25,
    },
  },

  worker: {
    queueName:   'icp-scoring' as const,
    concurrency: 3,
    attempts:    3,
    backoffMs:   5_000,
  },
} as const;

// ─── Redis connection shape (used by BullMQ) ─────────────────

export type RedisConfig = {
  host:      string;
  port:      number;
  password?: string;
};

export function getRedisConfig(): RedisConfig {
  return {
    host:     config.redis.host,
    port:     config.redis.port,
    password: config.redis.password,
  };
}
