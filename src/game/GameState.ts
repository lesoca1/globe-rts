import * as THREE from "three";
import { type Tile, paintTile, TERRAIN_COLORS, TERRAIN_DEFENSE } from "../globe/TileData";
import {
  type Player,
  createPlayer,
  PLAYER_PALETTE,
} from "./Player";
import {
  type Attack,
  createAttack,
  KC,
  KL,
  KD,
  EPSILON,
  ATTACKER_TERRAIN_MOD,
  MIN_FLOW_RATE,
} from "./Attack";

// ─────────────────────────────────────────────
// GameState.ts
// Manages the game loop: spawning, tick-based
// attacks, population growth, and win conditions.
// ─────────────────────────────────────────────

export type GamePhase = "menu" | "countdown" | "playing" | "victory";

export interface GameConfig {
  playerName: string;
  playerPaletteIndex: number;
  botCount: number;
  // (Reserved for future use: globe selection, etc.)
}

function isLand(terrain: string): boolean {
  return terrain !== "deep_water" && terrain !== "shallow_water";
}

function isAttackableTerrain(terrain: string): boolean {
  // Naval combat isn't modeled; water tiles are off-limits for attacks.
  return isLand(terrain);
}

// ── Population growth (logistic) ──
// Population (= troop pool P) grows toward a territory-derived cap Pmax.
//   Pmax = kp * N^alpha     (sublinear in territory N, diminishing returns)
//   dP   = r * (P + beta) * (1 - P / Pmax)
// `beta` is a small fraction of Pmax that keeps growth from stalling at P=0.
// Population is updated AFTER all attacks each tick, so newly grown troops
// can't be spent on attacks until the next tick.
const POP_KP = 50;
const POP_ALPHA = 0.6;
const POP_GROWTH_R = 0.05;
const POP_BETA_FRACTION = 0.02;

// Gold accrued per owned land tile per tick from the worker fraction
// (the (1 - troopRatio) side of the slider).
const GOLD_PER_TILE = 0.05;

const WIN_THRESHOLD = 0.80;  // 80% of land to win

const COUNTDOWN_DURATION_MS = 5000;

// ── Defense seeding ──
// Defense (D) given to a tile when it's first claimed via spawn,
// and the floor value when an enemy tile is captured.
const SPAWN_DEFENSE = 5;
const BASE_CAPTURE_DEFENSE = 3;
// Fraction of the attack's committed flow that "garrisons" a captured tile.
const CAPTURE_GARRISON_FRACTION = 0.5;

// Per-player cap on auto-launched expansion attacks (into unclaimed tiles).
// Manual / AI-launched player-vs-player attacks are unbounded.
const MAX_AUTO_EXPANSION_ATTACKS = 6;

export class GameState {
  tiles: Tile[];
  geometry: THREE.BufferGeometry;
  players: Player[] = [];
  phase: GamePhase = "menu";
  totalLandTiles: number = 0;
  winner: Player | null = null;
  tickCount: number = 0;

  // Countdown state
  countdownRemainingMs: number = 0;
  private countdownStartTime: number = 0;

  // Callbacks for UI updates
  onStateChange: (() => void) | null = null;
  onVictory: ((winner: Player) => void) | null = null;
  onCountdownTick: ((secondsRemaining: number) => void) | null = null;
  onCountdownEnd: (() => void) | null = null;

  private tickInterval: number | null = null;
  private countdownInterval: number | null = null;
  private countdownTimeout: number | null = null;

  // Cached land-tile pool used for finding bot spawn locations.
  private landSpawnPool: Tile[] | null = null;

  constructor(tiles: Tile[], geometry: THREE.BufferGeometry) {
    this.tiles = tiles;
    this.geometry = geometry;
    this.totalLandTiles = tiles.filter((t) => isLand(t.terrain)).length;
  }

  // ── Setup ──

  /** Initialize players from config. Bots aren't spawned until countdown begins. */
  setupGame(config: GameConfig): void {
    this.players = [];

    const human = createPlayer(
      0,
      config.playerName || "You",
      true,
      config.playerPaletteIndex
    );
    this.players.push(human);

    // Assign bot palette indices, skipping the human's choice when possible.
    const used = new Set<number>([config.playerPaletteIndex]);
    let next = 0;
    for (let i = 1; i <= config.botCount; i++) {
      while (used.has(next % PLAYER_PALETTE.length) &&
             used.size < PLAYER_PALETTE.length) {
        next++;
      }
      const palIdx = next % PLAYER_PALETTE.length;
      used.add(palIdx);
      next++;
      if (used.size >= PLAYER_PALETTE.length) {
        // Palette exhausted — let further bots cycle through colors freely.
        used.clear();
        used.add(config.playerPaletteIndex);
      }
      this.players.push(createPlayer(i, `Bot ${i}`, false, palIdx));
    }
  }

  /** Begin the 5-second freeze. Bots spawn now; the human can click to spawn. */
  startCountdown(): void {
    if (this.phase !== "menu") return;
    this.phase = "countdown";

    // Pre-build the spawn pool once for performance with many bots.
    this.landSpawnPool = this.tiles.filter(
      (t) => t.terrain === "plains" && t.owner === null
    );

    // All bots pick locations immediately.
    for (const p of this.players) {
      if (p.isHuman) continue;
      this.spawnPlayer(p, this.findSpawnLocation(p));
    }

    this.countdownStartTime = performance.now();
    this.countdownRemainingMs = COUNTDOWN_DURATION_MS;

    // Tick the visible timer at 100 ms granularity.
    this.countdownInterval = window.setInterval(() => {
      const elapsed = performance.now() - this.countdownStartTime;
      this.countdownRemainingMs = Math.max(0, COUNTDOWN_DURATION_MS - elapsed);
      this.onCountdownTick?.(this.countdownRemainingMs / 1000);
    }, 100);

    this.countdownTimeout = window.setTimeout(
      () => this.endCountdown(),
      COUNTDOWN_DURATION_MS
    );

    this.onCountdownTick?.(COUNTDOWN_DURATION_MS / 1000);
  }

  /** End the countdown: auto-spawn the human if they didn't pick, then play. */
  private endCountdown(): void {
    if (this.phase !== "countdown") return;

    if (this.countdownInterval !== null) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
    if (this.countdownTimeout !== null) {
      clearTimeout(this.countdownTimeout);
      this.countdownTimeout = null;
    }

    const human = this.getHuman();
    if (human && !human.spawned) {
      this.spawnPlayer(human, this.findSpawnLocation(human));
    }

    this.phase = "playing";
    this.onCountdownEnd?.();
    this.startGameLoop();
  }

  /** Find a good spawn point: land tile far from other players */
  private findSpawnLocation(player: Player): number {
    const landTiles = this.landSpawnPool ?? this.tiles.filter(
      (t) => t.terrain === "plains" && t.owner === null
    );
    if (landTiles.length === 0) return -1;

    let bestTile = landTiles[Math.floor(Math.random() * landTiles.length)];
    let bestScore = -1;

    // Sample to avoid O(n²) with 300K+ tiles
    const sampleSize = Math.min(500, landTiles.length);
    const step = Math.max(1, Math.floor(landTiles.length / sampleSize));

    for (let i = 0; i < landTiles.length; i += step) {
      const tile = landTiles[i];
      if (tile.owner !== null) continue;
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
      if (!isLand(tile.terrain) || tile.owner !== null) continue;

      this.claimTile(player, idx, SPAWN_DEFENSE);
      claimed++;

      // Add neighbors to queue
      for (const n of tile.neighbors) {
        if (!visited.has(n)) toVisit.push(n);
      }
    }

    player.spawned = claimed > 0;
    this.updateBorderTiles(player);
  }

  /** Human player spawns by clicking a land tile during the countdown. */
  handleSpawnClick(tileIndex: number): Player | null {
    if (this.phase !== "countdown") return null;
    const tile = this.tiles[tileIndex];
    if (!isLand(tile.terrain) || tile.owner !== null) return null;

    const human = this.getHuman();
    if (!human || human.spawned) return null;

    this.spawnPlayer(human, tileIndex);
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

    // 1. Resolve all attacks first.
    for (const player of this.players) {
      if (!player.alive) continue;
      this.maintainExpansionAttacks(player);
      this.tickAttacks(player);
    }

    // 2. Eliminate players who lost all territory during attack resolution.
    //    Done before growth so dead players don't accrue troops/gold.
    for (const player of this.players) {
      if (!player.alive) continue;
      if (player.ownedTiles.size === 0) {
        player.alive = false;
        player.attacks = [];
      }
    }

    // 3. Population (troop-pool P) growth — logistic, capped by Pmax.
    //    Per spec, runs AFTER all attack calculations so troops generated
    //    this tick cannot be spent on attacks until the next tick.
    for (const player of this.players) {
      if (!player.alive) continue;
      this.tickPopulation(player);
    }

    // 4. Win check.
    this.checkVictory();

    // 5. Notify UI.
    this.onStateChange?.();
  }

  /**
   * Logistic population growth for one player.
   *
   *   Pmax = kp * N^alpha
   *   beta = beta_frac * Pmax
   *   dP   = r * (P + beta) * (1 - P / Pmax)
   *   P    = clamp(P + dP, 0, Pmax)
   *
   * `r` is scaled by the player's troopRatio so the slider trades raw
   * growth speed for gold income from the worker fraction.
   */
  private tickPopulation(player: Player): void {
    const N = player.landTileCount;
    if (N <= 0) return;

    const pMax = this.maxTroops(player);
    const beta = POP_BETA_FRACTION * pMax;
    const fillFactor = Math.max(0, 1 - player.troops / pMax);
    const r = POP_GROWTH_R * player.troopRatio;
    const dP = r * (player.troops + beta) * fillFactor;

    player.troops = Math.min(pMax, player.troops + dP);

    // Worker output (the unused fraction of the troopRatio slider) → gold.
    player.gold += N * (1 - player.troopRatio) * GOLD_PER_TILE;

    // Mirror P into the legacy `population` field so downstream code/UI
    // that still reads it sees the current troop pool size.
    player.population = player.troops;
  }

  /** Pmax — sublinear cap on troop pool from current territory. */
  maxTroops(player: Player): number {
    if (player.landTileCount <= 0) return 0;
    return POP_KP * Math.pow(player.landTileCount, POP_ALPHA);
  }

  // ── Attack maintenance ──

  /**
   * Top up a player's auto-expansion attacks against unclaimed neighbors.
   * Player-vs-player attacks are launched explicitly (by click or AI) and
   * are not managed here.
   */
  private maintainExpansionAttacks(player: Player): void {
    if (player.borderTiles.size === 0) return;

    // Drop expansion attacks whose targets are no longer unclaimed
    // (captured already, or captured by someone else).
    player.attacks = player.attacks.filter((a) => {
      const t = this.tiles[a.targetTileIndex];
      // Keep player-vs-player attacks; they're managed elsewhere.
      if (t.owner !== null) return t.owner !== player.id;
      // Unclaimed: keep as expansion attack.
      return true;
    });

    let expansionCount = 0;
    const targetSet = new Set<number>();
    for (const a of player.attacks) {
      targetSet.add(a.targetTileIndex);
      const t = this.tiles[a.targetTileIndex];
      if (t.owner === null) expansionCount++;
    }

    if (expansionCount >= MAX_AUTO_EXPANSION_ATTACKS) return;

    // Pick the cheapest unclaimed neighbors to attack.
    const candidates: { tileIdx: number; fromIdx: number; cost: number }[] = [];
    for (const borderIdx of player.borderTiles) {
      const borderTile = this.tiles[borderIdx];
      for (const nIdx of borderTile.neighbors) {
        if (targetSet.has(nIdx)) continue;
        const n = this.tiles[nIdx];
        if (n.owner !== null) continue;
        if (!isAttackableTerrain(n.terrain)) continue;

        // Cost score: lower D_eff = cheaper. Unclaimed has D=0 so this is
        // dominated by the terrain modifier.
        const dEff = Math.max(EPSILON, n.defense * n.terrainDefense * n.structureDefense);
        candidates.push({ tileIdx: nIdx, fromIdx: borderIdx, cost: dEff });
      }
    }

    candidates.sort((a, b) => a.cost - b.cost);

    for (const c of candidates) {
      if (expansionCount >= MAX_AUTO_EXPANSION_ATTACKS) break;
      if (targetSet.has(c.tileIdx)) continue;
      // Flow rate is set to a placeholder; tickAttacks redistributes
      // the player's attack budget across all active attacks.
      player.attacks.push(createAttack(player.id, c.tileIdx, c.fromIdx, 1));
      targetSet.add(c.tileIdx);
      expansionCount++;
    }
  }

  /**
   * Run one tick of all of `player`'s active attacks.
   * Order per spec:
   *   1. Drop invalid attacks.
   *   2. Distribute commitment across all attacks (capped by P).
   *   3. For each attack: progress, attrition, capture check.
   */
  private tickAttacks(player: Player): void {
    if (player.attacks.length === 0) return;

    // 1. Validate targets. Drop attacks whose target is now self-owned
    //    or whose origin tile is no longer ours.
    player.attacks = player.attacks.filter((a) => {
      const target = this.tiles[a.targetTileIndex];
      if (target.owner === player.id) return false;
      if (!isAttackableTerrain(target.terrain)) return false;
      // The origin can be lost mid-attack; in that case re-anchor to any
      // current border tile that neighbors the target if possible.
      const fromTile = this.tiles[a.fromTileIndex];
      if (fromTile.owner !== player.id) {
        const newFrom = this.findAdjacentBorder(player, a.targetTileIndex);
        if (newFrom < 0) return false;
        a.fromTileIndex = newFrom;
      }
      return true;
    });

    if (player.attacks.length === 0) return;

    // 2. Distribute commitment. Total flow = troops * attackIntensity,
    //    split evenly across active attacks. Then global cap: total flow
    //    must not exceed P.
    const desiredTotal = Math.max(0, player.troops * player.attackIntensity);
    const perAttack = desiredTotal / player.attacks.length;
    let totalFlow = 0;
    for (const a of player.attacks) {
      a.flowRate = perAttack;
      totalFlow += a.flowRate;
    }
    if (totalFlow > player.troops && totalFlow > 0) {
      const scale = player.troops / totalFlow;
      for (const a of player.attacks) a.flowRate *= scale;
      totalFlow = player.troops;
    }

    // 3. Process each attack.
    const completed: Attack[] = [];
    for (const attack of player.attacks) {
      const tile = this.tiles[attack.targetTileIndex];
      const ra = attack.flowRate;

      if (ra < MIN_FLOW_RATE) {
        // Too weak to register; progress decays.
        attack.progress = Math.max(0, attack.progress - KC);
        continue;
      }

      // Effective attack & defense.
      const aEff = ra * ATTACKER_TERRAIN_MOD;
      const dEff = Math.max(
        EPSILON,
        tile.defense * tile.terrainDefense * tile.structureDefense
      );

      // Net pressure & progress change.
      const delta = aEff - dEff;
      const dC = KC * (delta / dEff);
      attack.progress = Math.max(0, attack.progress + dC);

      // Attacker attrition (continuous troop drain).
      player.troops = Math.max(0, player.troops - KL * aEff);

      // Defender attrition.
      tile.defense = Math.max(0, tile.defense - KD * aEff);

      // Capture check.
      if (attack.progress >= 1) {
        this.captureTile(player, attack);
        completed.push(attack);
      }
    }

    if (completed.length > 0) {
      const set = new Set(completed);
      player.attacks = player.attacks.filter((a) => !set.has(a));
    }
  }

  /**
   * Public entrypoint to launch a directed attack against an enemy or
   * unclaimed tile. Returns true if the attack was queued.
   */
  requestAttack(attacker: Player, targetTileIdx: number): boolean {
    if (!attacker.alive) return false;
    const tile = this.tiles[targetTileIdx];
    if (!isAttackableTerrain(tile.terrain)) return false;
    if (tile.owner === attacker.id) return false;

    // Must have a border tile adjacent to the target.
    const fromIdx = this.findAdjacentBorder(attacker, targetTileIdx);
    if (fromIdx < 0) return false;

    // De-dupe: if already attacking this tile, do nothing.
    for (const a of attacker.attacks) {
      if (a.targetTileIndex === targetTileIdx) return false;
    }

    attacker.attacks.push(createAttack(attacker.id, targetTileIdx, fromIdx, 1));
    return true;
  }

  /** Cancel any active attack a player has on the given target tile. */
  cancelAttack(attacker: Player, targetTileIdx: number): boolean {
    const before = attacker.attacks.length;
    attacker.attacks = attacker.attacks.filter(
      (a) => a.targetTileIndex !== targetTileIdx
    );
    return attacker.attacks.length < before;
  }

  /** Find one of `player`'s border tiles that's adjacent to `targetIdx`. */
  private findAdjacentBorder(player: Player, targetIdx: number): number {
    const target = this.tiles[targetIdx];
    for (const nIdx of target.neighbors) {
      if (this.tiles[nIdx].owner === player.id) return nIdx;
    }
    return -1;
  }

  /** Resolve a successful capture of the attack's target tile. */
  private captureTile(attacker: Player, attack: Attack): void {
    const tile = this.tiles[attack.targetTileIndex];
    const previousOwner =
      tile.owner !== null
        ? this.players.find((p) => p.id === tile.owner) ?? null
        : null;

    if (previousOwner) {
      this.releaseTile(previousOwner, tile.index);
    }

    const newDefense = Math.max(
      BASE_CAPTURE_DEFENSE,
      attack.flowRate * CAPTURE_GARRISON_FRACTION
    );
    this.claimTile(attacker, tile.index, newDefense);

    this.updateBorderTiles(attacker);
    if (previousOwner) this.updateBorderTiles(previousOwner);

    // Re-paint neighboring border tiles whose status may have changed.
    const affected = new Set<number>();
    for (const nIdx of tile.neighbors) {
      const nOwner = this.tiles[nIdx].owner;
      if (nOwner !== null && nOwner !== attacker.id) affected.add(nOwner);
    }
    for (const pid of affected) {
      const p = this.players.find((pl) => pl.id === pid);
      if (p) this.updateBorderTiles(p);
    }
  }

  // ── Helpers ──

  private claimTile(player: Player, tileIdx: number, defense: number): void {
    const tile = this.tiles[tileIdx];
    tile.owner = player.id;
    tile.defense = defense;
    tile.terrainDefense = TERRAIN_DEFENSE[tile.terrain];
    // structureDefense stays at whatever it is (1.0 until structures exist).
    player.ownedTiles.add(tileIdx);
    if (isLand(tile.terrain)) {
      player.landTileCount++;
      player.tileCenterSum.add(tile.centroid);
    }

    paintTile(this.geometry, tileIdx, player.color);
  }

  private releaseTile(player: Player, tileIdx: number): void {
    const tile = this.tiles[tileIdx];
    if (!player.ownedTiles.has(tileIdx)) return;
    player.ownedTiles.delete(tileIdx);
    player.borderTiles.delete(tileIdx);
    if (isLand(tile.terrain)) {
      player.landTileCount--;
      player.tileCenterSum.sub(tile.centroid);
    }
    // The new owner's claimTile will set defense; clear here for cleanliness.
    tile.defense = 0;
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
