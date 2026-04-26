// ─────────────────────────────────────────────
// Attack.ts
// A persistent, click-spawned campaign. Each
// active attack carries a finite pool of troops
// that the player allocated at click time. Per
// tick the troops are spread uniformly across
// the current front (every target tile adjacent
// to the attacker's territory) and grind down
// defenses until the front is consumed or the
// pool runs out.
// ─────────────────────────────────────────────

export interface Attack {
  // Player ID of the attacker.
  attackerId: number;

  // Target player ID, or null when this is an expansion into unclaimed land.
  // An attacker has at most one Attack per (defenderId | null).
  defenderId: number | null;

  // Remaining pool of troops allocated to this campaign. Drained by combat
  // attrition and by 1:1 cancellation against an opposing attack.
  troops: number;

  // Per-target-tile capture progress in [0, 1]. Tiles that aren't currently
  // on the front aren't tracked.
  progress: Map<number, number>;

  // Cached for rendering: a representative attacker border tile and a
  // representative target tile on the current front. Recomputed each tick.
  fromTileIndex: number;
  toTileIndex: number;
}

// ── Tuning constants ──

// kc — capture-progress coefficient. Controls how fast progress moves per
// tick relative to the (Δ / D_eff) ratio.
export const KC = 0.04;

// kl — attacker attrition coefficient. Fraction of A_eff drained from the
// campaign's troop pool per tick per engaged target.
export const KL = 0.05;

// kd — defender attrition coefficient. Fraction of A_eff chipped off the
// target tile's defense per tick.
export const KD = 0.10;

// Small epsilon to keep the progress formula well-defined when attacking
// tiles with effectively no defense.
export const EPSILON = 0.5;

// Ta — attacker terrain modifier. Reserved for future use; currently 1.0.
export const ATTACKER_TERRAIN_MOD = 1.0;

// Below this allocation per engaged target, a campaign can't make progress
// and is dropped to free up its slot.
export const MIN_FLOW_PER_TARGET = 0.05;

export function createAttack(
  attackerId: number,
  defenderId: number | null,
  fromTileIndex: number,
  toTileIndex: number,
  troops: number
): Attack {
  return {
    attackerId,
    defenderId,
    troops,
    progress: new Map(),
    fromTileIndex,
    toTileIndex,
  };
}
