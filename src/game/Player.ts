import * as THREE from "three";
import { type Attack } from "./Attack";

// ─────────────────────────────────────────────
// Player.ts
// Each player (human or AI) has territory,
// a troop pool (P), gold, control sliders,
// and a list of active attacks.
// ─────────────────────────────────────────────

export interface Player {
  id: number;
  name: string;
  color: THREE.Color;
  borderColor: THREE.Color;   // slightly brighter, for border tiles
  isHuman: boolean;

  // Territory
  ownedTiles: Set<number>;    // tile indices
  borderTiles: Set<number>;   // owned tiles adjacent to non-owned tiles

  // Resources
  population: number;
  troops: number;             // P — total troop pool
  gold: number;

  // Control sliders (0–1)
  troopRatio: number;         // what fraction of pop growth goes to troops (vs workers)
  attackIntensity: number;    // fraction of P committed across all active attacks per tick

  // Active tick-based attacks owned by this player.
  attacks: Attack[];

  // Stats
  alive: boolean;
  landTileCount: number;      // cached for performance

  // Running sum of owned-tile centroids; divided by landTileCount yields
  // the geographic center of the territory, used to position the on-map
  // nickname label.
  tileCenterSum: THREE.Vector3;
  spawned: boolean;
}

// Predefined player colors — distinct and colorblind-friendly.
// Tuple is [main, border-highlight].
export const PLAYER_PALETTE: [number, number][] = [
  [0xe63946, 0xff6b6b],   // red
  [0x457b9d, 0x6db3d4],   // blue
  [0xe9c46a, 0xf4d98c],   // gold
  [0x2a9d8f, 0x52cbbe],   // teal
  [0xf4a261, 0xf7c08a],   // orange
  [0x9b5de5, 0xb983f5],   // purple
  [0x06d6a0, 0x47eda5],   // mint
  [0xef476f, 0xf7799a],   // pink
];

export function paletteEntry(index: number): [number, number] {
  return PLAYER_PALETTE[index % PLAYER_PALETTE.length];
}

export function createPlayer(
  id: number,
  name: string,
  isHuman: boolean,
  paletteIndex: number = id
): Player {
  const [main, border] = paletteEntry(paletteIndex);
  return {
    id,
    name,
    color: new THREE.Color(main),
    borderColor: new THREE.Color(border),
    isHuman,
    ownedTiles: new Set(),
    borderTiles: new Set(),
    population: 0,
    troops: 50,        // starting troops
    gold: 0,
    troopRatio: 0.6,   // 60% troops, 40% workers by default
    attackIntensity: 0.5,
    attacks: [],
    alive: true,
    landTileCount: 0,
    tileCenterSum: new THREE.Vector3(),
    spawned: false,
  };
}
