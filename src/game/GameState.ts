import * as THREE from "three";
import { type Tile, paintTile, TERRAIN_COLORS } from "../globe/TileData";
import { type Player, createPlayer, PLAYER_PALETTE } from "./Player";
import { type Attack, createAttack } from "./Attack";

export type GamePhase = "menu" | "countdown" | "playing" | "victory";

export interface GameConfig {
  playerName: string;
  playerPaletteIndex: number;
  botCount: number;
}

const COUNTDOWN_DURATION_MS = 5000;
const WIN_THRESHOLD = 0.8;
const BOT_SPAWN_TRIES = 1000;
const SPAWN_RADIUS_STEPS = 4;
const MIN_SPAWN_DISTANCE_STEPS = 18;
const DEFENSE_DEBUFF_MIDPOINT = 150_000;
const DEFENSE_DEBUFF_DECAY_RATE = Math.LN2 / 50_000;
const HUMAN_GOLD_PER_TICK = 100;
const BOT_GOLD_PER_TICK = 50;
const MAX_ATTACK_STEPS_PER_TICK = 8;

function isLand(terrain: string): boolean {
  return terrain !== "deep_water" && terrain !== "shallow_water";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sigmoid(value: number, decayRate: number, midpoint: number): number {
  return 1 / (1 + Math.exp(-decayRate * (value - midpoint)));
}

function terrainAttackProfile(tile: Tile): { mag: number; speed: number } {
  switch (tile.terrain) {
    case "plains":
      return { mag: 80, speed: 16.5 };
    case "hills":
      return { mag: 100, speed: 20 };
    case "mountains":
      return { mag: 120, speed: 25 };
    default:
      return { mag: 120, speed: 25 };
  }
}

type FrontInfo = {
  targetCount: number;
  bestTargetIndex: number;
  representativeFrom: number;
  representativeTo: number;
};

export class GameState {
  tiles: Tile[];
  geometry: THREE.BufferGeometry;
  players: Player[] = [];
  phase: GamePhase = "menu";
  totalLandTiles = 0;
  winner: Player | null = null;
  tickCount = 0;
  countdownRemainingMs = 0;

  onStateChange: (() => void) | null = null;
  onVictory: ((winner: Player) => void) | null = null;
  onCountdownTick: ((secondsRemaining: number) => void) | null = null;
  onCountdownEnd: (() => void) | null = null;

  private countdownStartTime = 0;
  private tickInterval: number | null = null;
  private countdownInterval: number | null = null;
  private countdownTimeout: number | null = null;
  private landSpawnPool: number[] = [];
  private playersById = new Map<number, Player>();

  constructor(tiles: Tile[], geometry: THREE.BufferGeometry) {
    this.tiles = tiles;
    this.geometry = geometry;
    this.totalLandTiles = tiles.filter((tile) => isLand(tile.terrain)).length;
  }

  setupGame(config: GameConfig): void {
    this.players = [];
    this.playersById.clear();

    const human = createPlayer(
      0,
      config.playerName || "Commander",
      true,
      config.playerPaletteIndex
    );
    this.players.push(human);
    this.playersById.set(human.id, human);

    const used = new Set<number>([config.playerPaletteIndex]);
    let nextPalette = 0;
    for (let i = 1; i <= config.botCount; i++) {
      while (
        used.has(nextPalette % PLAYER_PALETTE.length) &&
        used.size < PLAYER_PALETTE.length
      ) {
        nextPalette++;
      }
      const paletteIndex = nextPalette % PLAYER_PALETTE.length;
      used.add(paletteIndex);
      nextPalette++;
      if (used.size >= PLAYER_PALETTE.length) {
        used.clear();
        used.add(config.playerPaletteIndex);
      }
      const bot = createPlayer(i, `Bot ${i}`, false, paletteIndex);
      this.players.push(bot);
      this.playersById.set(bot.id, bot);
    }
  }

  startCountdown(): void {
    if (this.phase !== "menu") return;
    this.phase = "countdown";
    this.landSpawnPool = this.tiles
      .filter((tile) => tile.terrain === "plains" && tile.owner === null)
      .map((tile) => tile.index);

    for (const player of this.players) {
      if (player.isHuman) continue;
      const spawnTile = this.findSpawnLocation(player);
      if (spawnTile >= 0) {
        this.spawnPlayer(player, spawnTile, true);
      }
    }

    this.countdownStartTime = performance.now();
    this.countdownRemainingMs = COUNTDOWN_DURATION_MS;
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
      const spawnTile = this.findSpawnLocation(human);
      if (spawnTile >= 0) {
        this.spawnPlayer(human, spawnTile, true);
      }
    }

    this.phase = "playing";
    this.onCountdownEnd?.();
    this.startGameLoop();
  }

  private collectSpawnTiles(
    centerTileIndex: number,
    requireAllValid: boolean
  ): number[] | null {
    const center = this.tiles[centerTileIndex];
    if (!center || !isLand(center.terrain) || center.owner !== null) {
      return null;
    }

    const queue: Array<{ tileIndex: number; depth: number }> = [
      { tileIndex: centerTileIndex, depth: 0 },
    ];
    const seen = new Set<number>([centerTileIndex]);
    const claimed: number[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const tile = this.tiles[current.tileIndex];
      const valid = isLand(tile.terrain) && tile.owner === null;

      if (!valid) {
        if (requireAllValid) return null;
      } else {
        claimed.push(current.tileIndex);
      }

      if (current.depth >= SPAWN_RADIUS_STEPS) continue;

      for (const neighborIndex of tile.neighbors) {
        if (seen.has(neighborIndex)) continue;
        seen.add(neighborIndex);
        queue.push({ tileIndex: neighborIndex, depth: current.depth + 1 });
      }
    }

    return claimed.length > 0 ? claimed : null;
  }

  private graphDistance(startIndex: number, targetIndex: number, maxDepth: number): number {
    if (startIndex === targetIndex) return 0;

    const queue: Array<{ tileIndex: number; depth: number }> = [
      { tileIndex: startIndex, depth: 0 },
    ];
    const seen = new Set<number>([startIndex]);

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) continue;

      for (const neighborIndex of this.tiles[current.tileIndex].neighbors) {
        if (neighborIndex === targetIndex) return current.depth + 1;
        if (seen.has(neighborIndex)) continue;
        seen.add(neighborIndex);
        queue.push({ tileIndex: neighborIndex, depth: current.depth + 1 });
      }
    }

    return Infinity;
  }

  private findSpawnLocation(player: Player): number {
    if (this.landSpawnPool.length === 0) return -1;

    for (let attempt = 0; attempt < BOT_SPAWN_TRIES; attempt++) {
      const centerIndex =
        this.landSpawnPool[Math.floor(Math.random() * this.landSpawnPool.length)];
      const centerTile = this.tiles[centerIndex];
      if (centerTile.owner !== null || !isLand(centerTile.terrain)) continue;

      const tooClose = this.players.some((other) => {
        if (other.id === player.id || other.spawnTileIndex === null) return false;
        return (
          this.graphDistance(
            other.spawnTileIndex,
            centerIndex,
            MIN_SPAWN_DISTANCE_STEPS - 1
          ) < MIN_SPAWN_DISTANCE_STEPS
        );
      });
      if (tooClose) continue;

      const spawnTiles = this.collectSpawnTiles(centerIndex, true);
      if (spawnTiles !== null) {
        return centerIndex;
      }
    }

    return -1;
  }

  spawnPlayer(player: Player, centerTileIndex: number, requireAllValid = false): void {
    const spawnTiles = this.collectSpawnTiles(centerTileIndex, requireAllValid);
    if (!spawnTiles || spawnTiles.length === 0) return;

    for (const tileIndex of spawnTiles) {
      this.claimTile(player, tileIndex);
    }

    player.spawned = true;
    player.spawnTileIndex = centerTileIndex;
    this.updateBorderTiles(player);
  }

  handleSpawnClick(tileIndex: number): Player | null {
    if (this.phase !== "countdown") return null;

    const human = this.getHuman();
    if (!human || human.spawned) return null;

    const spawnTiles = this.collectSpawnTiles(tileIndex, false);
    if (!spawnTiles || spawnTiles.length === 0) return null;

    this.spawnPlayer(human, tileIndex, false);
    return human;
  }

  startGameLoop(): void {
    if (this.tickInterval !== null) return;
    this.tickInterval = window.setInterval(() => this.tick(), 100);
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
      this.tickAttacks(player);
    }

    for (const player of this.players) {
      if (!player.alive) continue;
      if (player.ownedTiles.size === 0) {
        player.alive = false;
        player.attacks = [];
      }
    }

    for (const player of this.players) {
      if (!player.alive) continue;
      this.tickPopulation(player);
      this.tickGold(player);
    }

    this.checkVictory();
    this.onStateChange?.();
  }

  private tickPopulation(player: Player): void {
    const maxTroops = this.maxTroops(player);
    if (maxTroops <= 0) {
      player.troops = 0;
      player.population = 0;
      return;
    }

    let toAdd = 10 + Math.pow(Math.max(player.troops, 0), 0.8) / 4;
    toAdd *= 1 - player.troops / maxTroops;
    if (!player.isHuman) {
      toAdd *= 0.6;
    }

    player.troops = Math.min(maxTroops, player.troops + Math.max(0, toAdd));
    player.population = player.troops;
  }

  private tickGold(player: Player): void {
    player.gold += player.isHuman ? HUMAN_GOLD_PER_TICK : BOT_GOLD_PER_TICK;
  }

  maxTroops(player: Player): number {
    if (player.landTileCount <= 0) return 0;
    const base =
      2 * (Math.pow(player.landTileCount, 0.7) * 1000 + 50_000);
    return player.isHuman ? base : base / 3;
  }

  private tickAttacks(player: Player): void {
    if (player.attacks.length === 0) return;

    const surviving: Attack[] = [];
    for (const attack of player.attacks) {
      if (attack.troops < 1) continue;

      let refunded = false;

      let attackSteps = 0;
      while (attack.troops >= 1 && attackSteps < MAX_ATTACK_STEPS_PER_TICK) {
        const front = this.computeFront(player, attack);
        if (front.targetCount === 0) {
          player.troops = Math.min(this.maxTroops(player), player.troops + attack.troops);
          refunded = true;
          break;
        }

        attack.fromTileIndex = front.representativeFrom;
        attack.toTileIndex = front.representativeTo;

        const defender =
          attack.defenderId === null
            ? null
            : this.playersById.get(attack.defenderId) ?? null;
        let tilesBudget = this.attackTilesPerTick(
          attack.troops,
          defender,
          front.targetCount
        );
        if (tilesBudget <= 0) break;

        const targetIndex = front.bestTargetIndex;
        if (targetIndex < 0) break;

        const tile = this.tiles[targetIndex];
        const resolution = this.resolveAttackTile(attack.troops, player, defender, tile);
        attack.troops = Math.max(0, attack.troops - resolution.attackerTroopLoss);
        if (defender) {
          defender.troops = Math.max(0, defender.troops - resolution.defenderTroopLoss);
        }

        if (attack.troops < 1) break;

        this.captureTile(player, targetIndex);
        tilesBudget -= resolution.tilesPerTickUsed;
        attackSteps++;
        if (tilesBudget <= 0) break;
      }

      if (!refunded && attack.troops >= 1) {
        surviving.push(attack);
      }
    }

    player.attacks = surviving;
  }

  private attackTilesPerTick(
    attackTroops: number,
    defender: Player | null,
    numAdjacentTilesWithEnemy: number
  ): number {
    if (numAdjacentTilesWithEnemy <= 0) return 0;

    if (defender) {
      return (
        clamp(((5 * attackTroops) / Math.max(1, defender.troops)) * 2, 0.01, 0.5) *
        numAdjacentTilesWithEnemy *
        3
      );
    }

    return numAdjacentTilesWithEnemy * 2;
  }

  private resolveAttackTile(
    attackTroops: number,
    attacker: Player,
    defender: Player | null,
    tile: Tile
  ): {
    attackerTroopLoss: number;
    defenderTroopLoss: number;
    tilesPerTickUsed: number;
  } {
    let { mag, speed } = terrainAttackProfile(tile);

    if (defender) {
      const defenseSig =
        1 - sigmoid(defender.landTileCount, DEFENSE_DEBUFF_DECAY_RATE, DEFENSE_DEBUFF_MIDPOINT);
      const largeDefenderSpeedDebuff = 0.7 + 0.3 * defenseSig;
      const largeDefenderAttackDebuff = 0.7 + 0.3 * defenseSig;

      let largeAttackBonus = 1;
      if (attacker.landTileCount > 100_000) {
        largeAttackBonus = Math.sqrt(100_000 / attacker.landTileCount) ** 0.7;
      }

      let largeAttackerSpeedBonus = 1;
      if (attacker.landTileCount > 100_000) {
        largeAttackerSpeedBonus = (100_000 / attacker.landTileCount) ** 0.6;
      }

      if (attacker.isHuman && !defender.isHuman) {
        mag *= 0.8;
      }

      const defenderTroopLoss = defender.troops / Math.max(1, defender.landTileCount);
      const currentAttackerLoss =
        clamp(defender.troops / Math.max(1, attackTroops), 0.6, 2) *
        mag *
        0.8 *
        largeDefenderAttackDebuff *
        largeAttackBonus;
      const altAttackerLoss = 1.3 * defenderTroopLoss * (mag / 100);
      const attackerTroopLoss = 0.4 * currentAttackerLoss + 0.6 * altAttackerLoss;

      return {
        attackerTroopLoss,
        defenderTroopLoss,
        tilesPerTickUsed:
          clamp(defender.troops / Math.max(1, 5 * attackTroops), 0.2, 1.5) *
          speed *
          largeDefenderSpeedDebuff *
          largeAttackerSpeedBonus,
      };
    }

    return {
      attackerTroopLoss: attacker.isHuman ? mag / 5 : mag / 10,
      defenderTroopLoss: 0,
      tilesPerTickUsed: clamp((2000 * Math.max(10, speed)) / Math.max(1, attackTroops), 5, 100),
    };
  }

  private computeFront(player: Player, attack: Attack): FrontInfo {
    const seenTargets = new Set<number>();
    let bestTargetIndex = -1;
    let bestScore = Infinity;
    let representativeFrom = attack.fromTileIndex;
    let representativeTo = attack.toTileIndex;
    let hasAnchor = false;

    for (const borderIndex of player.borderTiles) {
      const borderTile = this.tiles[borderIndex];
      for (const neighborIndex of borderTile.neighbors) {
        const neighborTile = this.tiles[neighborIndex];
        if (!isLand(neighborTile.terrain)) continue;

        if (attack.defenderId === null) {
          if (neighborTile.owner !== null) continue;
        } else if (neighborTile.owner !== attack.defenderId) {
          continue;
        }

        if (!seenTargets.has(neighborIndex)) {
          seenTargets.add(neighborIndex);
          if (!hasAnchor) {
            representativeFrom = borderIndex;
            representativeTo = neighborIndex;
            hasAnchor = true;
          }

          const score = this.scoreFrontierTarget(player, neighborIndex);
          if (score < bestScore) {
            bestScore = score;
            bestTargetIndex = neighborIndex;
          }
        }
      }
    }

    return {
      targetCount: seenTargets.size,
      bestTargetIndex,
      representativeFrom,
      representativeTo,
    };
  }

  private scoreFrontierTarget(player: Player, targetIndex: number): number {
    const tile = this.tiles[targetIndex];
    const terrainPenalty =
      tile.terrain === "plains" ? 1 : tile.terrain === "hills" ? 1.5 : 2;
    let ownedNeighbors = 0;
    for (const neighborIndex of tile.neighbors) {
      if (this.tiles[neighborIndex].owner === player.id) {
        ownedNeighbors++;
      }
    }

    return (
      (10 + ((targetIndex + this.tickCount) % 7)) *
      (1 - ownedNeighbors * 0.5 + terrainPenalty / 2)
    );
  }

  requestAttack(attacker: Player, targetTileIdx: number): boolean {
    if (!attacker.alive) return false;

    const tile = this.tiles[targetTileIdx];
    if (!isLand(tile.terrain)) return false;
    if (tile.owner === attacker.id) return false;
    if (tile.owner === null) return this.requestExpansion(attacker, targetTileIdx);

    const defenderId = tile.owner;
    const anchor = this.findBorderAnchor(attacker, defenderId, targetTileIdx);
    if (!anchor) return false;

    const allocation = this.consumeAllocation(attacker);
    if (allocation <= 0) return false;

    const existing = attacker.attacks.find((attack) => attack.defenderId === defenderId);
    if (existing) {
      existing.troops += allocation;
      existing.fromTileIndex = anchor.from;
      existing.toTileIndex = anchor.to;
      this.cancelOpposingAttack(defenderId, attacker.id, existing);
      return true;
    }

    const attack = createAttack(attacker.id, defenderId, anchor.from, anchor.to, allocation);
    this.cancelOpposingAttack(defenderId, attacker.id, attack);
    if (attack.troops < 1) return true;

    attacker.attacks.push(attack);
    return true;
  }

  requestExpansion(attacker: Player, targetTileIdx: number): boolean {
    if (!attacker.alive) return false;

    const tile = this.tiles[targetTileIdx];
    if (!isLand(tile.terrain) || tile.owner !== null) return false;

    const anchor = this.findBorderAnchor(attacker, null, targetTileIdx);
    if (!anchor) return false;

    const allocation = this.consumeAllocation(attacker);
    if (allocation <= 0) return false;

    const existing = attacker.attacks.find((attack) => attack.defenderId === null);
    if (existing) {
      existing.troops += allocation;
      existing.fromTileIndex = anchor.from;
      existing.toTileIndex = anchor.to;
      return true;
    }

    attacker.attacks.push(
      createAttack(attacker.id, null, anchor.from, anchor.to, allocation)
    );
    return true;
  }

  cancelAttack(attacker: Player, targetTileIdx: number): boolean {
    const tile = this.tiles[targetTileIdx];
    const defenderId = tile.owner;
    let canceled = false;

    attacker.attacks = attacker.attacks.filter((attack) => {
      if (attack.defenderId !== defenderId) return true;
      attacker.troops = Math.min(this.maxTroops(attacker), attacker.troops + attack.troops);
      canceled = true;
      return false;
    });

    return canceled;
  }

  hasActiveAttackFor(attacker: Player, targetTileIdx: number): boolean {
    const tile = this.tiles[targetTileIdx];
    const defenderId = tile.owner;
    return attacker.attacks.some((attack) => attack.defenderId === defenderId);
  }

  private consumeAllocation(attacker: Player): number {
    const requested = attacker.troops * attacker.attackAllocation;
    const allocated = Math.max(0, Math.min(attacker.troops, requested));
    attacker.troops -= allocated;
    return allocated;
  }

  private cancelOpposingAttack(
    defenderId: number,
    attackerId: number,
    newAttack: Attack
  ): void {
    const defender = this.playersById.get(defenderId);
    if (!defender) return;

    const counterAttack = defender.attacks.find((attack) => attack.defenderId === attackerId);
    if (!counterAttack) return;

    const canceled = Math.min(counterAttack.troops, newAttack.troops);
    counterAttack.troops -= canceled;
    newAttack.troops -= canceled;
    if (counterAttack.troops < 1) {
      defender.attacks = defender.attacks.filter((attack) => attack !== counterAttack);
    }
  }

  private findBorderAnchor(
    attacker: Player,
    defenderId: number | null,
    clickedTileIdx: number
  ): { from: number; to: number } | null {
    const matchesTarget = (tileIndex: number): boolean => {
      const tile = this.tiles[tileIndex];
      if (!isLand(tile.terrain)) return false;
      return defenderId === null ? tile.owner === null : tile.owner === defenderId;
    };

    const clickedTile = this.tiles[clickedTileIdx];
    if (matchesTarget(clickedTileIdx)) {
      for (const neighborIndex of clickedTile.neighbors) {
        if (this.tiles[neighborIndex].owner === attacker.id) {
          return { from: neighborIndex, to: clickedTileIdx };
        }
      }
    }

    for (const borderIndex of attacker.borderTiles) {
      for (const neighborIndex of this.tiles[borderIndex].neighbors) {
        if (matchesTarget(neighborIndex)) {
          return { from: borderIndex, to: neighborIndex };
        }
      }
    }

    return null;
  }

  private claimTile(player: Player, tileIdx: number): void {
    const tile = this.tiles[tileIdx];
    tile.owner = player.id;
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
  }

  private captureTile(attacker: Player, tileIdx: number): void {
    const tile = this.tiles[tileIdx];
    const affectedTileIndices = [tileIdx, ...tile.neighbors];
    const affectedPlayerIds = new Set<number>([attacker.id]);
    for (const affectedIndex of affectedTileIndices) {
      const ownerId = this.tiles[affectedIndex].owner;
      if (ownerId !== null) {
        affectedPlayerIds.add(ownerId);
      }
    }

    const previousOwner =
      tile.owner !== null
        ? this.playersById.get(tile.owner) ?? null
        : null;

    if (previousOwner) {
      affectedPlayerIds.add(previousOwner.id);
      this.releaseTile(previousOwner, tileIdx);
    }

    this.claimTile(attacker, tileIdx);

    for (const playerId of affectedPlayerIds) {
      const player = this.playersById.get(playerId);
      if (!player) continue;
      for (const affectedIndex of affectedTileIndices) {
        if (this.tiles[affectedIndex].owner === playerId) {
          this.recomputeBorderTile(player, affectedIndex);
        }
      }
    }
  }

  updateBorderTiles(player: Player): void {
    player.borderTiles.clear();
    for (const tileIndex of player.ownedTiles) {
      const tile = this.tiles[tileIndex];
      for (const neighborIndex of tile.neighbors) {
        if (this.tiles[neighborIndex].owner !== player.id) {
          player.borderTiles.add(tileIndex);
          paintTile(this.geometry, tileIndex, player.borderColor);
          break;
        }
      }
    }
  }

  private recomputeBorderTile(player: Player, tileIndex: number): void {
    if (this.tiles[tileIndex].owner !== player.id) {
      player.borderTiles.delete(tileIndex);
      return;
    }

    let isBorder = false;
    for (const neighborIndex of this.tiles[tileIndex].neighbors) {
      if (this.tiles[neighborIndex].owner !== player.id) {
        isBorder = true;
        break;
      }
    }

    if (isBorder) {
      player.borderTiles.add(tileIndex);
      paintTile(this.geometry, tileIndex, player.borderColor);
    } else {
      player.borderTiles.delete(tileIndex);
      paintTile(this.geometry, tileIndex, player.color);
    }
  }

  repaintTile(tileIdx: number): void {
    const tile = this.tiles[tileIdx];
    if (tile.owner !== null) {
      const owner = this.players.find((player) => player.id === tile.owner);
      if (owner) {
        paintTile(
          this.geometry,
          tileIdx,
          owner.borderTiles.has(tileIdx) ? owner.borderColor : owner.color
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

  getHuman(): Player | undefined {
    return this.players.find((player) => player.id === 0);
  }

  getTerritory(player: Player): number {
    return (player.landTileCount / this.totalLandTiles) * 100;
  }
}
