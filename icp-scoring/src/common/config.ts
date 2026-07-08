// ─────────────────────────────────────────────────────────────
//  Common Config Module  (src/common/config.ts)
//
//  Required .env keys:
//  ───────────────────────────────────────────────────────────
//  GEMINI_API_KEY        Your Google Gemini API key  (required)
//  DATABASE_URL          PostgreSQL connection string (required in production,
//                        optional for running the test suite locally)
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

export const config = {
  // ── Gemini ────────────────────────────────────────────────
  gemini: {
    apiKey: require_env('GEMINI_API_KEY'),
    model:  'gemini-2.0-flash' as const,
  },

  // ── Database (optional during local test runs) ────────────
  db: {
    connectionString:    optional_env('DATABASE_URL', ''),  // empty = no DB
    poolMax:             10,
    idleTimeoutMs:       30_000,
    connectionTimeoutMs: 5_000,
  },

  redis: {
    host:     optional_env('REDIS_HOST', 'localhost'),
    port:     parseInt(optional_env('REDIS_PORT', '6379'), 10),
    password: process.env['REDIS_PASSWORD'],
  },

  scoring: {
    batchConcurrency: parseInt(optional_env('ICP_BATCH_CONCURRENCY', '5'), 10),
    chunkPauseMs:     4000,  // respects Gemini free tier: 15 req/min
    defaultMinScore:  parseInt(optional_env('ICP_MIN_SCORE_DEFAULT', '65'), 10),
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
