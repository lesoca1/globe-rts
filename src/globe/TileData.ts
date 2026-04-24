import * as THREE from "three";

export type Terrain = "deep_water" | "shallow_water" | "plains" | "hills" | "mountains";

export interface Tile {
  index: number;
  centroid: THREE.Vector3;
  latDeg: number;
  lonDeg: number;
  terrain: Terrain;
  neighbors: number[];
  owner: number | null;
  troops: number;
}

const TERRAIN_COLORS: Record<Terrain, THREE.Color> = {
  deep_water:    new THREE.Color(0x1a3a5c),
  shallow_water: new THREE.Color(0x2a6090),
  plains:        new THREE.Color(0x4a8c3f),
  hills:         new THREE.Color(0x7a9a4a),
  mountains:     new THREE.Color(0x9c9080),
};

export function buildTiles(geometry: THREE.BufferGeometry): Tile[] {
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

    const terrain = classifyTerrain(latDeg, lonDeg);

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
    });
  }

  colorAttr.needsUpdate = true;
  return tiles;
}

function classifyTerrain(lat: number, lon: number): Terrain {
  const la = lat * (Math.PI / 180);
  const lo = lon * (Math.PI / 180);

  let elevation =
    Math.sin(la * 2.0 + 0.5) * 0.4 +
    Math.sin(lo * 1.5 + 1.0) * 0.3 +
    Math.sin(la * 3.0 + lo * 2.0) * 0.25;

  elevation +=
    Math.sin(la * 5.0 + lo * 4.0 + 2.0) * 0.15 +
    Math.sin(la * 4.0 - lo * 3.0) * 0.1;

  elevation +=
    Math.sin(la * 10.0 + lo * 8.0 + 1.5) * 0.07 +
    Math.sin(la * 8.0 - lo * 6.0 + 3.0) * 0.05;

  if (Math.abs(lat) > 75) {
    elevation -= 0.3;
  }

  if (elevation < -0.15) return "deep_water";
  if (elevation < 0.05) return "shallow_water";
  if (elevation < 0.35) return "plains";
  if (elevation < 0.55) return "hills";
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
