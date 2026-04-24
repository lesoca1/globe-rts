import { type Player } from "./Player";
import { type GameState } from "./GameState";

// ─────────────────────────────────────────────
// AI.ts
// Simple AI that makes decisions each tick:
// - Adjusts sliders based on situation
// - Picks attack targets
// ─────────────────────────────────────────────

export function runAI(game: GameState): void {
  for (const player of game.players) {
    if (player.isHuman || !player.alive) continue;
    aiDecide(game, player);
  }
}

function aiDecide(game: GameState, player: Player): void {
  // Only make strategic decisions every ~2 seconds (8 ticks)
  if (game.tickCount % 8 !== player.id % 8) return;

  // 1. Adjust troop ratio based on threat level
  const threat = assessThreat(game, player);
  if (threat > 0.5) {
    // Under threat: more troops
    player.troopRatio = Math.min(0.9, player.troopRatio + 0.05);
    player.attackIntensity = Math.min(0.8, player.attackIntensity + 0.05);
  } else {
    // Safe: balance economy
    player.troopRatio = Math.max(0.4, player.troopRatio - 0.02);
    player.attackIntensity = Math.max(0.3, player.attackIntensity - 0.02);
  }

  // 2. Pick attack target: weakest neighbor
  player.attackTarget = pickTarget(game, player);
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

/** Find the weakest neighboring player to attack */
function pickTarget(game: GameState, player: Player): number | null {
  // Find which other players we border
  const neighboringPlayers = new Map<number, number>(); // playerId → shared border count

  for (const tileIdx of player.borderTiles) {
    const tile = game.tiles[tileIdx];
    for (const nIdx of tile.neighbors) {
      const neighbor = game.tiles[nIdx];
      if (neighbor.owner !== null && neighbor.owner !== player.id) {
        neighboringPlayers.set(
          neighbor.owner,
          (neighboringPlayers.get(neighbor.owner) || 0) + 1
        );
      }
    }
  }

  if (neighboringPlayers.size === 0) return null;

  // Pick the one with fewest troops (weakest)
  let weakestId: number | null = null;
  let weakestTroops = Infinity;

  for (const [pid] of neighboringPlayers) {
    const target = game.players.find((p) => p.id === pid);
    if (!target || !target.alive) continue;
    if (target.troops < weakestTroops) {
      weakestTroops = target.troops;
      weakestId = pid;
    }
  }

  return weakestId;
}
