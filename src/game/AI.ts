import { type Player } from "./Player";
import { type GameState } from "./GameState";

// ─────────────────────────────────────────────
// AI.ts
// Simple AI that periodically:
// - Tunes its per-attack allocation by threat level.
// - Launches a campaign against its weakest neighbor, or expands into
//   nearby unclaimed land if no enemy borders exist.
// ─────────────────────────────────────────────

export function runAI(game: GameState): void {
  for (const player of game.players) {
    if (player.isHuman || !player.alive) continue;
    aiDecide(game, player);
  }
}

function aiDecide(game: GameState, player: Player): void {
  // Only make strategic decisions every ~2 seconds (8 ticks).
  if (game.tickCount % 8 !== player.id % 8) return;

  // Tune the attack-allocation slider by threat. More threat → bigger
  // allocations per click so the AI commits decisively.
  const threat = assessThreat(game, player);
  if (threat > 0.5) {
    player.attackAllocation = Math.min(0.8, player.attackAllocation + 0.05);
  } else {
    player.attackAllocation = Math.max(0.3, player.attackAllocation - 0.02);
  }

  // Pick a target:
  //   - Weakest neighboring enemy if any, otherwise expand into unclaimed land.
  const targetId = pickTarget(game, player);
  if (targetId !== null) {
    if (player.attacks.some((a) => a.defenderId === targetId)) return;
    const tileIdx = anyEnemyBorderTile(game, player, targetId);
    if (tileIdx >= 0) game.requestAttack(player, tileIdx);
    return;
  }

  // No enemy neighbors — expand if we still have unclaimed neighbors.
  if (player.attacks.some((a) => a.defenderId === null)) return;
  const expandIdx = anyUnclaimedNeighbor(game, player);
  if (expandIdx >= 0) game.requestExpansion(player, expandIdx);
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

/** Any tile owned by `targetId` that's adjacent to one of `player`'s borders. */
function anyEnemyBorderTile(
  game: GameState,
  player: Player,
  targetId: number
): number {
  for (const borderIdx of player.borderTiles) {
    const borderTile = game.tiles[borderIdx];
    for (const nIdx of borderTile.neighbors) {
      if (game.tiles[nIdx].owner === targetId) return nIdx;
    }
  }
  return -1;
}

/** Any unclaimed land tile adjacent to one of `player`'s borders. */
function anyUnclaimedNeighbor(game: GameState, player: Player): number {
  for (const borderIdx of player.borderTiles) {
    const borderTile = game.tiles[borderIdx];
    for (const nIdx of borderTile.neighbors) {
      const n = game.tiles[nIdx];
      if (n.owner !== null) continue;
      if (n.terrain === "deep_water" || n.terrain === "shallow_water") continue;
      return nIdx;
    }
  }
  return -1;
}
