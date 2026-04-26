import { type Player } from "./Player";
import { type GameState } from "./GameState";

// ─────────────────────────────────────────────
// AI.ts
// Simple AI that periodically:
// - Adjusts sliders based on threat level.
// - Launches tick-based attacks against the
//   weakest neighboring enemy's border tiles.
// ─────────────────────────────────────────────

// Max simultaneous player-vs-player attacks per AI.
const AI_MAX_PVP_ATTACKS = 3;

export function runAI(game: GameState): void {
  for (const player of game.players) {
    if (player.isHuman || !player.alive) continue;
    aiDecide(game, player);
  }
}

function aiDecide(game: GameState, player: Player): void {
  // Only make strategic decisions every ~2 seconds (8 ticks).
  if (game.tickCount % 8 !== player.id % 8) return;

  // 1. Adjust sliders by threat.
  const threat = assessThreat(game, player);
  if (threat > 0.5) {
    player.troopRatio = Math.min(0.9, player.troopRatio + 0.05);
    player.attackIntensity = Math.min(0.8, player.attackIntensity + 0.05);
  } else {
    player.troopRatio = Math.max(0.4, player.troopRatio - 0.02);
    player.attackIntensity = Math.max(0.3, player.attackIntensity - 0.02);
  }

  // 2. Pick a target and launch attacks against its weakest border tiles.
  const targetId = pickTarget(game, player);
  if (targetId === null) return;

  // How many fresh PvP attacks to launch this decision cycle.
  const pvpActive = countPvpAttacks(game, player);
  if (pvpActive >= AI_MAX_PVP_ATTACKS) return;

  const launches = chooseAttackTiles(
    game,
    player,
    targetId,
    AI_MAX_PVP_ATTACKS - pvpActive
  );
  for (const tileIdx of launches) {
    game.requestAttack(player, tileIdx);
  }
}

/** How much of our border is shared with enemies? */
function assessThreat(game: GameState, player: Player): number {
  if (player.borderTiles.size === 0) return 0;

  let enemyBorderCount = 0;
  for (const tileIdx of player.borderTiles) {
    const tile = game.tiles[tileIdx];
    for (const nIdx of tile.neighbors) {
      const neighbor = game.tiles[nIdx];
      if (neighbor.owner !== null && neighbor.owner !== player.id) {
        enemyBorderCount++;
        break;
      }
    }
  }

  return enemyBorderCount / player.borderTiles.size;
}

/** Find the weakest neighboring player to attack. */
function pickTarget(game: GameState, player: Player): number | null {
  const neighboringPlayers = new Set<number>();

  for (const tileIdx of player.borderTiles) {
    const tile = game.tiles[tileIdx];
    for (const nIdx of tile.neighbors) {
      const neighbor = game.tiles[nIdx];
      if (neighbor.owner !== null && neighbor.owner !== player.id) {
        neighboringPlayers.add(neighbor.owner);
      }
    }
  }

  if (neighboringPlayers.size === 0) return null;

  let weakestId: number | null = null;
  let weakestTroops = Infinity;
  for (const pid of neighboringPlayers) {
    const target = game.players.find((p) => p.id === pid);
    if (!target || !target.alive) continue;
    if (target.troops < weakestTroops) {
      weakestTroops = target.troops;
      weakestId = pid;
    }
  }
  return weakestId;
}

function countPvpAttacks(game: GameState, player: Player): number {
  let n = 0;
  for (const a of player.attacks) {
    const t = game.tiles[a.targetTileIndex];
    if (t.owner !== null) n++;
  }
  return n;
}

/**
 * Pick up to `limit` enemy tiles owned by `targetId` adjacent to one of
 * the player's border tiles, preferring tiles with the lowest D_eff
 * (defense × terrain × structure).
 */
function chooseAttackTiles(
  game: GameState,
  player: Player,
  targetId: number,
  limit: number
): number[] {
  if (limit <= 0) return [];

  const seen = new Set<number>();
  for (const a of player.attacks) seen.add(a.targetTileIndex);

  type Cand = { idx: number; cost: number };
  const cands: Cand[] = [];

  for (const borderIdx of player.borderTiles) {
    const borderTile = game.tiles[borderIdx];
    for (const nIdx of borderTile.neighbors) {
      if (seen.has(nIdx)) continue;
      const n = game.tiles[nIdx];
      if (n.owner !== targetId) continue;
      const cost = Math.max(
        0.01,
        n.defense * n.terrainDefense * n.structureDefense
      );
      cands.push({ idx: nIdx, cost });
      seen.add(nIdx);
    }
  }

  cands.sort((a, b) => a.cost - b.cost);
  return cands.slice(0, limit).map((c) => c.idx);
}
