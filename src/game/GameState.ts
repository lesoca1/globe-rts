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
  MIN_FLOW_PER_TARGET,
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

/** Stable key for a (low, high) player-id pair, used to dedupe mutual checks. */
function pairKey(a: number, b: number): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
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

// Fixed troops/worker split. The single in-game slider controls per-attack
// allocation, not growth speed.
const TROOP_RATIO = 0.7;

// Gold accrued per owned land tile per tick from the worker fraction.
const GOLD_PER_TILE = 0.05;

const WIN_THRESHOLD = 0.80;  // 80% of land to win

const COUNTDOWN_DURATION_MS = 5000;

// ── Defense seeding ──
// Defense (D) given to a tile when it's first claimed via spawn,
// and the floor value when an enemy tile is captured.
const SPAWN_DEFENSE = 5;
const BASE_CAPTURE_DEFENSE = 3;
// Per-tile garrison cost taken from the campaign pool when a tile is captured.
// Keeps successful campaigns from snowballing without paying anything.
const CAPTURE_GARRISON_COST = 4;

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
    //    a. 1:1 cancellation between mutually-attacking pairs (consumes pool
    //       on both sides without combat).
    //    b. Per-player tick: prune dead campaigns, then advance combat across
    //       the current front uniformly.
    this.applyMutualCancellation();
    for (const player of this.players) {
      if (!player.alive) continue;
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
   */
  private tickPopulation(player: Player): void {
    const N = player.landTileCount;
    if (N <= 0) return;

    const pMax = this.maxTroops(player);
    const beta = POP_BETA_FRACTION * pMax;
    const fillFactor = Math.max(0, 1 - player.troops / pMax);
    const r = POP_GROWTH_R * TROOP_RATIO;
    const dP = r * (player.troops + beta) * fillFactor;

    player.troops = Math.min(pMax, player.troops + dP);

    // Worker output (the non-troop fraction) → gold.
    player.gold += N * (1 - TROOP_RATIO) * GOLD_PER_TILE;

    // Mirror P into the legacy `population` field for any downstream readers.
    player.population = player.troops;
  }

  /** Pmax — sublinear cap on troop pool from current territory. */
  maxTroops(player: Player): number {
    if (player.landTileCount <= 0) return 0;
    return POP_KP * Math.pow(player.landTileCount, POP_ALPHA);
  }

  // ── Attack maintenance ──

  /**
   * Apply 1:1 troop cancellation between any pair (A, B) where A is
   * attacking B and B is attacking A. This drains both pools without doing
   * any tile combat — the troops meet in the middle and annihilate.
   */
  private applyMutualCancellation(): void {
    const seen = new Set<string>();
    for (const a of this.players) {
      if (!a.alive) continue;
      for (const atk of a.attacks) {
        if (atk.defenderId === null) continue;
        const key = pairKey(a.id, atk.defenderId);
        if (seen.has(key)) continue;
        seen.add(key);

        const b = this.players.find((p) => p.id === atk.defenderId);
        if (!b || !b.alive) continue;
        const counter = b.attacks.find((x) => x.defenderId === a.id);
        if (!counter) continue;

        const canceled = Math.min(atk.troops, counter.troops);
        atk.troops -= canceled;
        counter.troops -= canceled;
      }
    }
  }

  /**
   * Run one tick of all of `player`'s active campaigns.
   *   1. Drop campaigns that are out of troops or have no front.
   *   2. Build the front: every (attackerBorderTile → targetTile) edge
   *      where targetTile matches the campaign's defender (or is unclaimed
   *      land for an expansion campaign).
   *   3. Distribute the troop pool uniformly across each unique target tile
   *      on the front and resolve combat per target.
   */
  private tickAttacks(player: Player): void {
    if (player.attacks.length === 0) return;

    const surviving: Attack[] = [];

    for (const attack of player.attacks) {
      if (attack.troops <= 0) continue;

      // Build the front: target tiles adjacent to the attacker's territory.
      const front = this.computeFront(player, attack);
      if (front.targets.size === 0) {
        // No reachable front anymore — campaign ends, leftover troops are
        // returned to the player's main pool.
        player.troops = Math.min(this.maxTroops(player), player.troops + attack.troops);
        continue;
      }

      // Drop progress for tiles that left the front (e.g. captured by a
      // third party) so the map doesn't grow unbounded.
      for (const tIdx of attack.progress.keys()) {
        if (!front.targets.has(tIdx)) attack.progress.delete(tIdx);
      }

      // Refresh rendering anchors.
      attack.fromTileIndex = front.representativeFrom;
      attack.toTileIndex = front.representativeTo;

      const numTargets = front.targets.size;
      const perTarget = attack.troops / numTargets;

      if (perTarget < MIN_FLOW_PER_TARGET) {
        // Spread too thin to make any progress this tick — keep the campaign
        // alive but skip combat. Without enemy reinforcement it'll bleed via
        // mutual cancellation or be reset by the player.
        surviving.push(attack);
        continue;
      }

      const captured: number[] = [];
      for (const tIdx of front.targets) {
        if (attack.troops <= 0) break;
        const tile = this.tiles[tIdx];

        const aEff = perTarget * ATTACKER_TERRAIN_MOD;
        const dEff = Math.max(
          EPSILON,
          tile.defense * tile.terrainDefense * tile.structureDefense
        );

        const dC = KC * ((aEff - dEff) / dEff);
        const prev = attack.progress.get(tIdx) ?? 0;
        const next = Math.max(0, prev + dC);
        attack.progress.set(tIdx, next);

        // Attacker attrition: troops drained from the campaign pool.
        attack.troops = Math.max(0, attack.troops - KL * aEff);
        // Defender attrition: defense chipped on the target tile.
        tile.defense = Math.max(0, tile.defense - KD * aEff);

        if (next >= 1) captured.push(tIdx);
      }

      // Resolve captures after the loop so we don't mutate the front mid-pass.
      for (const tIdx of captured) {
        if (attack.troops < CAPTURE_GARRISON_COST) {
          attack.progress.delete(tIdx);
          continue;
        }
        attack.troops -= CAPTURE_GARRISON_COST;
        this.captureTile(player, tIdx, CAPTURE_GARRISON_COST);
        attack.progress.delete(tIdx);
      }

      if (attack.troops > 0) surviving.push(attack);
    }

    player.attacks = surviving;
  }

  /**
   * Build the current attack front for a campaign: every target tile that
   * is (a) adjacent to one of the attacker's owned tiles and (b) matches
   * the campaign's filter (specific defender, or unclaimed land for an
   * expansion campaign).
   */
  private computeFront(
    player: Player,
    attack: Attack
  ): { targets: Set<number>; representativeFrom: number; representativeTo: number } {
    const targets = new Set<number>();
    let representativeFrom = attack.fromTileIndex;
    let representativeTo = attack.toTileIndex;
    let foundAnchor = false;

    for (const borderIdx of player.borderTiles) {
      const borderTile = this.tiles[borderIdx];
      for (const nIdx of borderTile.neighbors) {
        const n = this.tiles[nIdx];
        if (!isAttackableTerrain(n.terrain)) continue;

        if (attack.defenderId === null) {
          if (n.owner !== null) continue;
        } else {
          if (n.owner !== attack.defenderId) continue;
        }

        if (!targets.has(nIdx)) {
          targets.add(nIdx);
          if (!foundAnchor) {
            representativeFrom = borderIdx;
            representativeTo = nIdx;
            foundAnchor = true;
          }
        }
      }
    }

    return { targets, representativeFrom, representativeTo };
  }

  /**
   * Public entrypoint to launch a directed attack on an enemy player.
   * `targetTileIdx` is the tile the player clicked; the campaign targets
   * that tile's owner (so it spreads along the entire shared border).
   */
  requestAttack(attacker: Player, targetTileIdx: number): boolean {
    if (!attacker.alive) return false;
    const tile = this.tiles[targetTileIdx];
    if (!isAttackableTerrain(tile.terrain)) return false;
    if (tile.owner === attacker.id) return false;
    if (tile.owner === null) return this.requestExpansion(attacker, targetTileIdx);

    const defenderId = tile.owner;

    // Must share a border with the defender somewhere.
    const anchor = this.findBorderAnchor(attacker, defenderId, targetTileIdx);
    if (!anchor) return false;

    // De-dupe: at most one campaign per (attacker → defender).
    if (attacker.attacks.some((a) => a.defenderId === defenderId)) return false;

    const allocation = this.consumeAllocation(attacker);
    if (allocation <= 0) return false;

    attacker.attacks.push(
      createAttack(attacker.id, defenderId, anchor.from, anchor.to, allocation)
    );
    return true;
  }

  /**
   * Public entrypoint to launch an expansion into unclaimed land.
   * Spreads uniformly outward from every border tile that touches unclaimed
   * land — the clicked tile is just the trigger.
   */
  requestExpansion(attacker: Player, targetTileIdx: number): boolean {
    if (!attacker.alive) return false;
    const tile = this.tiles[targetTileIdx];
    if (!isAttackableTerrain(tile.terrain)) return false;
    if (tile.owner !== null) return false;

    const anchor = this.findBorderAnchor(attacker, null, targetTileIdx);
    if (!anchor) return false;

    if (attacker.attacks.some((a) => a.defenderId === null)) return false;

    const allocation = this.consumeAllocation(attacker);
    if (allocation <= 0) return false;

    attacker.attacks.push(
      createAttack(attacker.id, null, anchor.from, anchor.to, allocation)
    );
    return true;
  }

  /**
   * Cancel any active campaign by `attacker` against the same target type
   * the clicked tile represents (defender player, or expansion). Refunds
   * any unspent troops to the player's pool.
   */
  cancelAttack(attacker: Player, targetTileIdx: number): boolean {
    const tile = this.tiles[targetTileIdx];
    const defenderId = tile.owner; // number | null
    let canceled = false;
    attacker.attacks = attacker.attacks.filter((a) => {
      if (a.defenderId !== defenderId) return true;
      attacker.troops = Math.min(
        this.maxTroops(attacker),
        attacker.troops + Math.max(0, a.troops)
      );
      canceled = true;
      return false;
    });
    return canceled;
  }

  /** True if `attacker` currently has a campaign matching the clicked tile. */
  hasActiveAttackFor(attacker: Player, targetTileIdx: number): boolean {
    const tile = this.tiles[targetTileIdx];
    const defenderId = tile.owner;
    return attacker.attacks.some((a) => a.defenderId === defenderId);
  }

  /**
   * Withdraw the per-click allocation from the player's troop pool. Returns
   * the actual amount withdrawn (capped by current troops).
   */
  private consumeAllocation(attacker: Player): number {
    const want = attacker.troops * attacker.attackAllocation;
    const got = Math.max(0, Math.min(attacker.troops, want));
    attacker.troops -= got;
    return got;
  }

  /**
   * Find a border anchor pair (attacker tile, target tile) for a campaign.
   * Prefers the clicked tile if it's on the front; otherwise picks any
   * adjacent attacker/target pair. Returns null if no front exists.
   */
  private findBorderAnchor(
    attacker: Player,
    defenderId: number | null,
    clickedTileIdx: number
  ): { from: number; to: number } | null {
    const clicked = this.tiles[clickedTileIdx];
    const matchesDefender = (idx: number): boolean => {
      const t = this.tiles[idx];
      if (defenderId === null) return t.owner === null && isAttackableTerrain(t.terrain);
      return t.owner === defenderId && isAttackableTerrain(t.terrain);
    };

    // Prefer the clicked tile if it's directly on the front.
    if (matchesDefender(clickedTileIdx)) {
      for (const nIdx of clicked.neighbors) {
        if (this.tiles[nIdx].owner === attacker.id) {
          return { from: nIdx, to: clickedTileIdx };
        }
      }
    }

    // Otherwise pick any matching (border, target) pair.
    for (const borderIdx of attacker.borderTiles) {
      const borderTile = this.tiles[borderIdx];
      for (const nIdx of borderTile.neighbors) {
        if (matchesDefender(nIdx)) return { from: borderIdx, to: nIdx };
      }
    }
    return null;
  }

  /** Resolve a successful capture of `tileIdx` by `attacker`. */
  private captureTile(attacker: Player, tileIdx: number, garrison: number): void {
    const tile = this.tiles[tileIdx];
    const previousOwner =
      tile.owner !== null
        ? this.players.find((p) => p.id === tile.owner) ?? null
        : null;

    if (previousOwner) {
      this.releaseTile(previousOwner, tile.index);
    }

    const newDefense = Math.max(BASE_CAPTURE_DEFENSE, garrison);
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
