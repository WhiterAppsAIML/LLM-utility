// ─────────────────────────────────────────────────────────────
//  Account Warm-Up Curve  (src/common/warmup.ts)
//
//  Implements the formula from the security spec:
//
//    Wₙ = BaseCap × (1 + n / 14)
//
//  where n = consecutive days the account has been connected.
//
//  Used by:
//    • Sprint 3  – limits how many scored leads get pushed into
//                  the active campaign queue on day 1–14
//    • Sprint 5  – daily cap enforcer reads this before routing
//
//  Hard ceilings from the platform limit matrix:
//  ──────────────────────────────────────────────
//    Profile Views       80 / day
//    Connection Requests 30 / day
//    Direct Messages    100 / day
//    Profile Follows     40 / day
// ─────────────────────────────────────────────────────────────

export type ActionType = 'PROFILE_VIEW' | 'CONN_REQUEST' | 'MESSAGE' | 'FOLLOW';

// ─── Absolute daily hard caps (DDL CHECK constraints mirror these) ───

export const HARD_CAPS: Record<ActionType, number> = {
  PROFILE_VIEW:  80,
  CONN_REQUEST:  30,
  MESSAGE:       100,
  FOLLOW:        40,
};

// ─── Recommended warm-up base caps (Day 1 starting point) ────

export const WARMUP_BASE_CAPS: Record<ActionType, number> = {
  PROFILE_VIEW:  20,
  CONN_REQUEST:  10,
  MESSAGE:       25,
  FOLLOW:        15,
};

// ─────────────────────────────────────────────────────────────
//  Core formula
// ─────────────────────────────────────────────────────────────

/**
 * Returns the safe daily cap for an action type given how many
 * consecutive days the account has been actively connected.
 *
 * Formula:  Wₙ = BaseCap × (1 + n / 14)
 * Clamped:  never exceeds the absolute hard cap for that action.
 *
 * @param action      One of the four automatable action types
 * @param activeDays  Consecutive days since account was connected (0-indexed)
 *
 * @example
 *   getDailyCap('CONN_REQUEST', 0)   // → 10   (day 1, fresh account)
 *   getDailyCap('CONN_REQUEST', 7)   // → 15   (week 1 complete)
 *   getDailyCap('CONN_REQUEST', 14)  // → 20   (fully warmed up)
 *   getDailyCap('CONN_REQUEST', 100) // → 30   (hard cap, regardless of n)
 */
export function getDailyCap(action: ActionType, activeDays: number): number {
  const base     = WARMUP_BASE_CAPS[action];
  const hardCap  = HARD_CAPS[action];
  const n        = Math.max(0, activeDays);

  const warmupCap = base * (1 + n / 14);

  return Math.min(Math.floor(warmupCap), hardCap);
}

// ─────────────────────────────────────────────────────────────
//  Full warm-up schedule for an account (Days 0–14+)
// ─────────────────────────────────────────────────────────────

export interface WarmupScheduleRow {
  day:          number;
  profile_view: number;
  conn_request: number;
  message:      number;
  follow:       number;
}

/**
 * Returns the complete warm-up schedule for days 0 through `upToDay`.
 * Useful for displaying the warm-up progress on the account settings UI.
 */
export function getWarmupSchedule(upToDay = 14): WarmupScheduleRow[] {
  return Array.from({ length: upToDay + 1 }, (_, day) => ({
    day,
    profile_view: getDailyCap('PROFILE_VIEW', day),
    conn_request: getDailyCap('CONN_REQUEST', day),
    message:      getDailyCap('MESSAGE',      day),
    follow:       getDailyCap('FOLLOW',       day),
  }));
}

// ─────────────────────────────────────────────────────────────
//  Integration helper  (called by Sprint 5 rotation router)
// ─────────────────────────────────────────────────────────────

/**
 * Given an account's connected_at timestamp, computes how many
 * full days have elapsed and returns its current daily caps.
 *
 * @param connectedAt  The `created_at` of the linkedin_accounts row
 */
export function getAccountCaps(
  connectedAt: Date,
): Record<ActionType, number> {
  const msPerDay   = 1000 * 60 * 60 * 24;
  const activeDays = Math.floor(
    (Date.now() - connectedAt.getTime()) / msPerDay,
  );

  return {
    PROFILE_VIEW: getDailyCap('PROFILE_VIEW', activeDays),
    CONN_REQUEST: getDailyCap('CONN_REQUEST', activeDays),
    MESSAGE:      getDailyCap('MESSAGE',      activeDays),
    FOLLOW:       getDailyCap('FOLLOW',       activeDays),
  };
}
