import { type Player } from "./Player";
import { type GameState } from "./GameState";

export function runAI(game: GameState): void {
  for (const player of game.players) {
    if (player.isHuman || !player.alive) continue;
    aiDecide(game, player);
  }
}

function aiDecide(game: GameState, player: Player): void {
  if (game.tickCount % 20 !== player.id % 20) return;

  const threat = assessThreat(game, player);
  if (threat > 0.5) {
    player.attackAllocation = Math.min(0.12, player.attackAllocation + 0.01);
  } else {
    player.attackAllocation = Math.max(0.04, player.attackAllocation - 0.005);
  }

  const targetId = pickTarget(game, player);
  if (targetId !== null) {
    if (player.attacks.some((attack) => attack.defenderId === targetId)) return;
    const targetTileIndex = anyEnemyBorderTile(game, player, targetId);
    if (targetTileIndex >= 0) {
      game.requestAttack(player, targetTileIndex);
    }
    return;
  }

  if (player.attacks.some((attack) => attack.defenderId === null)) return;
  const expansionTileIndex = anyUnclaimedNeighbor(game, player);
  if (expansionTileIndex >= 0) {
    game.requestExpansion(player, expansionTileIndex);
  }
}

function assessThreat(game: GameState, player: Player): number {
  if (player.borderTiles.size === 0) return 0;

  let enemyBorderCount = 0;
  for (const tileIndex of player.borderTiles) {
    const tile = game.tiles[tileIndex];
    for (const neighborIndex of tile.neighbors) {
      const neighbor = game.tiles[neighborIndex];
      if (neighbor.owner !== null && neighbor.owner !== player.id) {
        enemyBorderCount++;
        break;
      }
    }
  }

  return enemyBorderCount / player.borderTiles.size;
}

function pickTarget(game: GameState, player: Player): number | null {
  const neighboringPlayers = new Set<number>();

  for (const tileIndex of player.borderTiles) {
    const tile = game.tiles[tileIndex];
    for (const neighborIndex of tile.neighbors) {
      const neighbor = game.tiles[neighborIndex];
      if (neighbor.owner !== null && neighbor.owner !== player.id) {
        neighboringPlayers.add(neighbor.owner);
      }
    }
  }

  if (neighboringPlayers.size === 0) return null;

  let weakestId: number | null = null;
  let weakestTroops = Infinity;
  for (const playerId of neighboringPlayers) {
    const target = game.players.find((candidate) => candidate.id === playerId);
    if (!target || !target.alive) continue;
    if (target.troops < weakestTroops) {
      weakestTroops = target.troops;
      weakestId = playerId;
    }
  }

  return weakestId;
}

function anyEnemyBorderTile(game: GameState, player: Player, targetId: number): number {
  for (const borderIndex of player.borderTiles) {
    const borderTile = game.tiles[borderIndex];
    for (const neighborIndex of borderTile.neighbors) {
      if (game.tiles[neighborIndex].owner === targetId) {
        return neighborIndex;
      }
    }
  }
  return -1;
}

function anyUnclaimedNeighbor(game: GameState, player: Player): number {
  for (const borderIndex of player.borderTiles) {
    const borderTile = game.tiles[borderIndex];
    for (const neighborIndex of borderTile.neighbors) {
      const neighbor = game.tiles[neighborIndex];
      if (neighbor.owner === null && neighbor.terrain === "plains") {
        return neighborIndex;
      }
    }
  }
  return -1;
}
