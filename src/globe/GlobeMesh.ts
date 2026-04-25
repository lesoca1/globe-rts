import * as THREE from "three";

// THREE's IcosahedronGeometry `detail` is NOT a recursive subdivision level —
// it's the number of segments per edge of the 20 base faces, so total tile
// count is 20 * (detail + 1)^2, not 20 * 4^detail. Detail 200 → ~810k tiles,
// roughly one pixel per tile on a 1080p screen at default zoom.
const ICO_DETAIL = 200;
const GLOBE_RADIUS = 5;

export function createGlobeMesh(): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(GLOBE_RADIUS, ICO_DETAIL);

  const nonIndexed = geometry.toNonIndexed();

  const vertexCount = nonIndexed.attributes.position.count;
  const colors = new Float32Array(vertexCount * 3);

  for (let i = 0; i < vertexCount; i++) {
    colors[i * 3] = 0.3;
    colors[i * 3 + 1] = 0.3;
    colors[i * 3 + 2] = 0.35;
  }
  nonIndexed.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshPhongMaterial({
    vertexColors: true,
    flatShading: true,
    shininess: 15,
    specular: new THREE.Color(0x222244),
  });

  const mesh = new THREE.Mesh(nonIndexed, material);
  mesh.name = "globe";
  return mesh;
}

export function getTileCount(): number {
  return 20 * (ICO_DETAIL + 1) ** 2;
}

export { GLOBE_RADIUS };
