import * as THREE from "three";

const SUBDIVISION_LEVEL = 7;
const GLOBE_RADIUS = 5;

export function createGlobeMesh(): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(
    GLOBE_RADIUS,
    SUBDIVISION_LEVEL
  );

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
  return 20 * Math.pow(4, SUBDIVISION_LEVEL);
}

export { GLOBE_RADIUS };
