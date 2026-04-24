import * as THREE from "three";
import { type Tile, paintTile, TERRAIN_COLORS } from "../globe/TileData";
import { type Player, createPlayer } from "./Player";

// ─────────────────────────────────────────────
// GameState.ts
// Manages the game loop: spawning, expansion,
// combat, resources, and win conditions.
// ─────────────────────────────────────────────

export type GamePhase = "spawning" | "playing" | "victory";

// Terrain capture costs (in troops)
const TERRAIN_COST: Record<string, number> = {
  deep_water: Infinity,   // can't capture ocean
  shallow_water: 8,
  plains: 1,
  hills: 3,
  mountains: 6,
};

// How fast population grows per owned land tile per tick
const POP_GROWTH_RATE = 0.015;
// Gold per worker per tick
const GOLD_PER_WORKER = 0.02;
// How many troops are used per expansion attempt on a single tile
const TROOPS_PER_EXPAND = 1.5;

const WIN_THRESHOLD = 0.80;  // 80% of land to win

export class GameState {
  tiles: Tile[];
  geometry: THREE.BufferGeometry;
  players: Player[] = [];
  phase: GamePhase = "spawning";
  totalLandTiles: number = 0;
  winner: Player | null = null;
  tickCount: number = 0;

  // Callbacks for UI updates
  onStateChange: (() => void) | null = null;
  onVictory: ((winner: Player) => void) | null = null;

  private tickInterval: number | null = null;

  constructor(tiles: Tile[], geometry: THREE.BufferGeometry) {
    this.tiles = tiles;
    this.geometry = geometry;
    this.totalLandTiles = tiles.filter(
      (t) => t.terrain !== "deep_water"
    ).length;
  }

  // ── Setup ──

  /** Add AI players and spawn them on random land tiles */
  setupAI(count: number): void {
    for (let i = 1; i <= count; i++) {
      const ai = createPlayer(i, `Bot ${i}`, false);
      this.players.push(ai);
      this.spawnPlayer(ai, this.findSpawnLocation(ai));
    }
  }

  /** Find a good spawn point: land tile far from other players */
  private findSpawnLocation(player: Player): number {
    const landTiles = this.tiles.filter(
      (t) => t.terrain === "plains" && t.owner === null
    );
    if (landTiles.length === 0) return -1;

    // Score each tile by distance to nearest other player
    let bestTile = landTiles[0];
    let bestScore = -1;

    // Sample to avoid O(n²) with 300K+ tiles
    const sampleSize = Math.min(500, landTiles.length);
    const step = Math.max(1, Math.floor(landTiles.length / sampleSize));

    for (let i = 0; i < landTiles.length; i += step) {
      const tile = landTiles[i];
      let minDist = Infinity;

      for (const other of this.players) {
        if (other.id === player.id || other.ownedTiles.size === 0) continue;
        // Pick any owned tile of theirs for distance
        const otherTile = this.tiles[other.ownedTiles.values().next().value!];
        const dist = tile.centroid.distanceTo(otherTile.centroid);
        minDist = Math.min(minDist, dist);
      }

      if (minDist > bestScore) {
        bestScore = minDist;
        bestTile = tile;
      }
    }

    return bestTile.index;
  }

  /** Spawn a player: claim a cluster of tiles around a starting point */
  spawnPlayer(player: Player, centerTileIndex: number): void {
    if (centerTileIndex < 0) return;

    // BFS outward from center, claiming ~30 tiles
    const toVisit: number[] = [centerTileIndex];
    const visited = new Set<number>();
    let claimed = 0;
    const claimTarget = 30;

    while (toVisit.length > 0 && claimed < claimTarget) {
      const idx = toVisit.shift()!;
      if (visited.has(idx)) continue;
      visited.add(idx);

      const tile = this.tiles[idx];
      if (tile.terrain === "deep_water" || tile.owner !== null) continue;

      this.claimTile(player, idx);
      claimed++;

      // Add neighbors to queue
      for (const n of tile.neighbors) {
        if (!visited.has(n)) toVisit.push(n);
      }
    }

    this.updateBorderTiles(player);
  }

  /** Human player spawns by clicking */
  handleSpawnClick(tileIndex: number): Player | null {
    const tile = this.tiles[tileIndex];
    if (tile.terrain === "deep_water" || tile.owner !== null) return null;

    const human = createPlayer(0, "You", true);
    this.players.unshift(human); // human is always index 0
    this.spawnPlayer(human, tileIndex);

    this.phase = "playing";
    this.startGameLoop();

    return human;
  }

  // ── Core Game Loop ──

  startGameLoop(): void {
    if (this.tickInterval !== null) return;
    this.tickInterval = window.setInterval(() => this.tick(), 250); // 4 ticks/sec
  }

  stopGameLoop(): void {
    if (this.tickInterval !== null) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  private tick(): void {
    if (this.phase !== "playing") return;
    this.tickCount++;

    for (const player of this.players) {
      if (!player.alive) continue;

      // 1. Population growth
      const landOwned = player.landTileCount;
      const growth = landOwned * POP_GROWTH_RATE;
      player.population += growth;

      // 2. Split into troops and workers
      const newTroops = growth * player.troopRatio;
      const newWorkers = growth * (1 - player.troopRatio);
      player.troops += newTroops;

      // 3. Workers produce gold
      player.gold += newWorkers * GOLD_PER_WORKER;

      // 4. Auto-expand into unclaimed territory
      this.expandPlayer(player);

      // 5. Check elimination
      if (player.ownedTiles.size === 0) {
        player.alive = false;
      }
    }

    // 6. Check victory
    this.checkVictory();

    // 7. Notify UI
    this.onStateChange?.();
  }

  // ── Expansion ──

  private expandPlayer(player: Player): void {
    if (player.borderTiles.size === 0) return;

    const troopsAvailable = player.troops * player.attackIntensity;
    if (troopsAvailable < TROOPS_PER_EXPAND) return;

    let troopsSpent = 0;
    const maxSpend = troopsAvailable * 0.25; // spend up to 25% of available per tick
    const newlyClaimedTiles: number[] = [];

    // Collect expansion candidates: unclaimed (or enemy) tiles adjacent to our border
    const candidates: { tileIdx: number; cost: number; priority: number }[] = [];

    for (const borderIdx of player.borderTiles) {
      const borderTile = this.tiles[borderIdx];

      for (const neighborIdx of borderTile.neighbors) {
        const neighbor = this.tiles[neighborIdx];
        if (neighbor.owner === player.id) continue;

        const baseCost = TERRAIN_COST[neighbor.terrain];
        if (baseCost === Infinity) continue;

        // Cost is higher to capture enemy tiles
        const enemyMultiplier = neighbor.owner !== null ? 3 : 1;
        const cost = baseCost * enemyMultiplier;

        // Priority: prefer attacking the focused target, then cheap tiles
        let priority = 1 / cost;
        if (
          player.attackTarget !== null &&
          neighbor.owner === player.attackTarget
        ) {
          priority *= 5; // 5x priority for attack target
        }

        candidates.push({ tileIdx: neighborIdx, cost, priority });
      }
    }

    // Sort by priority (highest first), deduplicate
    candidates.sort((a, b) => b.priority - a.priority);
    const seen = new Set<number>();

    for (const { tileIdx, cost } of candidates) {
      if (seen.has(tileIdx)) continue;
      seen.add(tileIdx);

      if (troopsSpent + cost > maxSpend) continue;

      const tile = this.tiles[tileIdx];

      // If enemy tile, also reduce their troops
      if (tile.owner !== null) {
        const defender = this.players.find((p) => p.id === tile.owner);
        if (defender) {
          // Need to overcome defense
          const defense = cost * 1.5;
          if (troopsSpent + defense > maxSpend) continue;

          defender.ownedTiles.delete(tileIdx);
          defender.borderTiles.delete(tileIdx);
          defender.landTileCount--;
          troopsSpent += defense;
        }
      }

      this.claimTile(player, tileIdx);
      newlyClaimedTiles.push(tileIdx);
      troopsSpent += cost;
    }

    player.troops -= troopsSpent;
    if (player.troops < 0) player.troops = 0;

    // Update borders only if territory changed
    if (newlyClaimedTiles.length > 0) {
      this.updateBorderTiles(player);
      // Also update borders for any affected players
      const affectedPlayers = new Set<number>();
      for (const idx of newlyClaimedTiles) {
        for (const nIdx of this.tiles[idx].neighbors) {
          const nOwner = this.tiles[nIdx].owner;
          if (nOwner !== null && nOwner !== player.id) {
            affectedPlayers.add(nOwner);
          }
        }
      }
      for (const pid of affectedPlayers) {
        const p = this.players.find((pl) => pl.id === pid);
        if (p) this.updateBorderTiles(p);
      }
    }
  }

  // ── Helpers ──

  private claimTile(player: Player, tileIdx: number): void {
    const tile = this.tiles[tileIdx];
    tile.owner = player.id;
    player.ownedTiles.add(tileIdx);
    if (tile.terrain !== "deep_water") {
      player.landTileCount++;
    }

    // Paint the tile
    paintTile(this.geometry, tileIdx, player.color);
  }

  /** Recalculate which of a player's tiles are on the border */
  updateBorderTiles(player: Player): void {
    player.borderTiles.clear();
    for (const tileIdx of player.ownedTiles) {
      const tile = this.tiles[tileIdx];
      for (const nIdx of tile.neighbors) {
        if (this.tiles[nIdx].owner !== player.id) {
          player.borderTiles.add(tileIdx);
          // Also paint border tiles slightly brighter
          paintTile(this.geometry, tileIdx, player.borderColor);
          break;
        }
      }
    }
  }

  /** Repaint a tile back to its terrain color (for deselection etc.) */
  repaintTile(tileIdx: number): void {
    const tile = this.tiles[tileIdx];
    if (tile.owner !== null) {
      const owner = this.players.find((p) => p.id === tile.owner);
      if (owner) {
        const isBorder = owner.borderTiles.has(tileIdx);
        paintTile(
          this.geometry,
          tileIdx,
          isBorder ? owner.borderColor : owner.color
        );
        return;
      }
    }
    paintTile(this.geometry, tileIdx, TERRAIN_COLORS[tile.terrain]);
  }

  private checkVictory(): void {
    for (const player of this.players) {
      if (!player.alive) continue;
      const ratio = player.landTileCount / this.totalLandTiles;
      if (ratio >= WIN_THRESHOLD) {
        this.phase = "victory";
        this.winner = player;
        this.stopGameLoop();
        this.onVictory?.(player);
        return;
      }
    }
  }

  /** Get the human player (always id 0) */
  getHuman(): Player | undefined {
    return this.players.find((p) => p.id === 0);
  }

  /** Get territory percentage for a player */
  getTerritory(player: Player): number {
    return (player.landTileCount / this.totalLandTiles) * 100;
  }
}
