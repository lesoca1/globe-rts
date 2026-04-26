import * as THREE from "three";
import { type EarthData, sample } from "./EarthData";

export type Terrain = "deep_water" | "shallow_water" | "plains" | "hills" | "mountains";

// Defensive troop value applied to terrain on claim/capture.
// (`troops` on the tile is a holdover; new code uses `defense` / D.)
export interface Tile {
  index: number;
  centroid: THREE.Vector3;
  latDeg: number;
  lonDeg: number;
  terrain: Terrain;
  neighbors: number[];
  owner: number | null;
  troops: number;

  // ── Defense model ──
  // D — defensive troop value stationed on the tile (depleted by attacks).
  defense: number;
  // Td — terrain defense multiplier (constant per terrain).
  terrainDefense: number;
  // Sd — structure defense multiplier (1.0 until structures are built).
  structureDefense: number;
}

// Defensive multiplier applied by the terrain itself.
// Mountains and hills are easier to defend; water is treated as 1.0
// because naval combat isn't modeled yet (water tiles stay impassable).
export const TERRAIN_DEFENSE: Record<Terrain, number> = {
  deep_water:    1.0,
  shallow_water: 1.0,
  plains:        1.0,
  hills:         1.6,
  mountains:     2.5,
};

const TERRAIN_COLORS: Record<Terrain, THREE.Color> = {
  deep_water:    new THREE.Color(0x1a3a5c),
  shallow_water: new THREE.Color(0x2a6090),
  plains:        new THREE.Color(0x4a8c3f),
  hills:         new THREE.Color(0x7a9a4a),
  mountains:     new THREE.Color(0x9c9080),
};

export function buildTiles(
  geometry: THREE.BufferGeometry,
  earth: EarthData
): Tile[] {
  const pos = geometry.attributes.position;
  const colorAttr = geometry.attributes.color;
  const tileCount = pos.count / 3;

  const tiles: Tile[] = [];

  for (let t = 0; t < tileCount; t++) {
    const v0 = new THREE.Vector3().fromBufferAttribute(pos, t * 3);
    const v1 = new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 1);
    const v2 = new THREE.Vector3().fromBufferAttribute(pos, t * 3 + 2);
    const centroid = new THREE.Vector3()
      .addVectors(v0, v1)
      .add(v2)
      .divideScalar(3);

    const r = centroid.length();
    const latRad = Math.asin(centroid.y / r);
    const lonRad = Math.atan2(centroid.z, centroid.x);
    const latDeg = THREE.MathUtils.radToDeg(latRad);
    const lonDeg = THREE.MathUtils.radToDeg(lonRad);

    const terrain = classifyTerrain(latDeg, lonDeg, earth);

    const color = TERRAIN_COLORS[terrain];
    for (let v = 0; v < 3; v++) {
      colorAttr.setXYZ(t * 3 + v, color.r, color.g, color.b);
    }

    tiles.push({
      index: t,
      centroid,
      latDeg,
      lonDeg,
      terrain,
      neighbors: [],
      owner: null,
      troops: 0,
      defense: 0,
      terrainDefense: TERRAIN_DEFENSE[terrain],
      structureDefense: 1.0,
    });
  }

  colorAttr.needsUpdate = true;
  return tiles;
}

// Coastal halo ~1.5° (~165 km) — within this range of land we call it
// shallow water. 3×3 sample stencil keeps the per-tile cost bounded.
const COAST_HALO_DEG = 1.5;

function classifyTerrain(lat: number, lon: number, earth: EarthData): Terrain {
  // Water mask: white (>128) = water, black = land.
  const water = sample(earth.water, lon, lat);

  if (water > 128) {
    for (const dLat of [-COAST_HALO_DEG, 0, COAST_HALO_DEG]) {
      for (const dLon of [-COAST_HALO_DEG, 0, COAST_HALO_DEG]) {
        if (sample(earth.water, lon + dLon, lat + dLat) <= 128) {
          return "shallow_water";
        }
      }
    }
    return "deep_water";
  }

  // Land: classify by relief brightness. Topology image is dark overall;
  // ranges chosen empirically — most plains are <30, alpine ridges >80.
  const elev = sample(earth.topology, lon, lat);
  if (elev < 30) return "plains";
  if (elev < 80) return "hills";
  return "mountains";
}

export function buildAdjacency(
  geometry: THREE.BufferGeometry,
  tiles: Tile[]
): void {
  const pos = geometry.attributes.position;
  const tileCount = tiles.length;

  const PRECISION = 1000;
  const vertexMap = new Map<string, { tile: number; local: number }[]>();

  for (let t = 0; t < tileCount; t++) {
    for (let v = 0; v < 3; v++) {
      const x = Math.round(pos.getX(t * 3 + v) * PRECISION);
      const y = Math.round(pos.getY(t * 3 + v) * PRECISION);
      const z = Math.round(pos.getZ(t * 3 + v) * PRECISION);
      const key = `${x},${y},${z}`;

      if (!vertexMap.has(key)) vertexMap.set(key, []);
      vertexMap.get(key)!.push({ tile: t, local: v });
    }
  }

  const neighborSets: Set<number>[] = Array.from(
    { length: tileCount },
    () => new Set()
  );

  for (const entries of vertexMap.values()) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i].tile;
        const b = entries[j].tile;
        if (a !== b) {
          neighborSets[a].add(b);
          neighborSets[b].add(a);
        }
      }
    }
  }

  for (let t = 0; t < tileCount; t++) {
    tiles[t].neighbors = Array.from(neighborSets[t]);
  }

  console.log(
    `Adjacency built: ${tileCount} tiles, ` +
    `avg ${(tiles.reduce((s, t) => s + t.neighbors.length, 0) / tileCount).toFixed(1)} neighbors each`
  );
}

export function paintTile(
  geometry: THREE.BufferGeometry,
  tileIndex: number,
  color: THREE.Color
): void {
  const colorAttr = geometry.attributes.color;
  for (let v = 0; v < 3; v++) {
    colorAttr.setXYZ(tileIndex * 3 + v, color.r, color.g, color.b);
  }
  colorAttr.needsUpdate = true;
}

export { TERRAIN_COLORS };
