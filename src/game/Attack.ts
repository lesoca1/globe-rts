// ─────────────────────────────────────────────
// Attack.ts
// A persistent, tick-based attack object. Each
// active attack has a committed troop flow rate
// (ra) and a capture progress (C in [0, 1]).
// Per tick the attack consumes attacker troops,
// chips away at the target tile's defense, and
// advances or regresses progress depending on
// the balance of effective attack vs effective
// defense. When C reaches 1 the tile flips.
// ─────────────────────────────────────────────

export interface Attack {
  // Player ID of the attacker.
  attackerId: number;

  // Target tile index.
  targetTileIndex: number;

  // ra — committed troop flow rate (troops / tick).
  // May be scaled down each tick if the player can't
  // sustain the total commitment across all attacks.
  flowRate: number;

  // C — capture progress in [0, 1]. Reaching 1 captures.
  progress: number;

  // The attacker's border tile this attack originates
  // from. Used purely for rendering an indicator arrow.
  fromTileIndex: number;
}

// ── Tuning constants ──

// kc — capture-progress coefficient. Controls how fast
// progress moves per tick relative to the (Δ / D_eff) ratio.
export const KC = 0.04;

// kl — attacker attrition coefficient. Fraction of A_eff
// removed from the attacker's troop pool per tick.
export const KL = 0.05;

// kd — defender attrition coefficient. Fraction of A_eff
// chipped off the tile's defense per tick.
export const KD = 0.10;

// Small epsilon to keep the progress formula well-defined
// when attacking tiles with effectively no defense.
export const EPSILON = 0.5;

// Ta — attacker terrain modifier. Reserved for future use
// (e.g. cavalry on plains); currently always 1.0.
export const ATTACKER_TERRAIN_MOD = 1.0;

// Below this commitment per tick, an attack is too weak
// to register and is dropped to free up its slot.
export const MIN_FLOW_RATE = 0.05;

export function createAttack(
  attackerId: number,
  targetTileIndex: number,
  fromTileIndex: number,
  flowRate: number
): Attack {
  return {
    attackerId,
    targetTileIndex,
    fromTileIndex,
    flowRate,
    progress: 0,
  };
}
