import * as THREE from "three";

const raycaster = new THREE.Raycaster();
const mouseNDC = new THREE.Vector2();

export function pickTile(
  event: MouseEvent,
  camera: THREE.Camera,
  globeMesh: THREE.Mesh
): number {
  const rect = (event.target as HTMLElement).getBoundingClientRect();
  mouseNDC.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouseNDC, camera);

  const hits = raycaster.intersectObject(globeMesh);

  if (hits.length === 0) return -1;

  const faceIndex = hits[0].faceIndex;

  if (faceIndex == null) return -1;  // == catches both null and undefined
  return faceIndex;
}
