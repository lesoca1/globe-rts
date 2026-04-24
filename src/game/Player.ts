import * as THREE from "three";

// ─────────────────────────────────────────────
// Player.ts
// Each player (human or AI) has territory,
// population, gold, and control sliders.
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
  troops: number;
  gold: number;

  // Control sliders (0–1)
  troopRatio: number;         // what fraction of pop growth goes to troops (vs workers)
  attackIntensity: number;    // what fraction of border troops to use per expansion tick

  // Attack target: if set, expansion prioritizes tiles near this target
  attackTarget: number | null;  // player ID to focus attacks on

  // Stats
  alive: boolean;
  landTileCount: number;      // cached for performance
}

// Predefined player colors — distinct and colorblind-friendly
const PLAYER_PALETTE: [number, number][] = [
  [0xe63946, 0xff6b6b],   // red
  [0x457b9d, 0x6db3d4],   // blue
  [0xe9c46a, 0xf4d98c],   // gold
  [0x2a9d8f, 0x52cbbe],   // teal
  [0xf4a261, 0xf7c08a],   // orange
  [0x9b5de5, 0xb983f5],   // purple
  [0x06d6a0, 0x47eda5],   // mint
  [0xef476f, 0xf7799a],   // pink
];

export function createPlayer(
  id: number,
  name: string,
  isHuman: boolean
): Player {
  const [main, border] = PLAYER_PALETTE[id % PLAYER_PALETTE.length];
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
    attackTarget: null,
    alive: true,
    landTileCount: 0,
  };
}
