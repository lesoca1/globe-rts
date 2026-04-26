import * as THREE from "three";
import { GLOBE_RADIUS } from "../globe/GlobeMesh";
import { type GameState } from "../game/GameState";
import { type Player } from "../game/Player";
import { type Attack } from "../game/Attack";

// ─────────────────────────────────────────────
// AttackIndicators.ts
// Renders an arrow + troop-count label for every
// active player-vs-player attack. Arrows arc from
// the attacker's border tile up over the globe and
// down onto the defender's tile.
// ─────────────────────────────────────────────

const ARROW_SEGMENTS = 24;
const ARC_LIFT = 0.07;       // peak of the arc above the globe surface
const ARROW_HEAD_SIZE = 0.06;
// Render arrows just above the surface so they don't z-fight tiles.
const ARROW_RADIUS = GLOBE_RADIUS * 1.008;

interface IndicatorEntry {
  attack: Attack;
  line: THREE.Line;
  head: THREE.Mesh;
  label: HTMLDivElement;
}

export class AttackIndicators {
  private group: THREE.Group;
  private labelContainer: HTMLDivElement;
  private game: GameState;
  private camera: THREE.PerspectiveCamera;
  // Keyed by `${attackerId}:${targetIdx}` for stable identity across ticks.
  private entries = new Map<string, IndicatorEntry>();
  private projected = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    labelContainer: HTMLDivElement,
    game: GameState,
    camera: THREE.PerspectiveCamera
  ) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.labelContainer = labelContainer;
    this.game = game;
    this.camera = camera;
  }

  /** Refresh indicators each frame. Cheap when there are few attacks. */
  update(): void {
    const live = new Set<string>();

    for (const player of this.game.players) {
      if (!player.alive) continue;
      for (const attack of player.attacks) {
        if (!this.shouldShow(attack)) continue;
        const key = this.keyFor(player, attack);
        live.add(key);

        let entry = this.entries.get(key);
        if (!entry) {
          entry = this.createEntry(player, attack);
          this.entries.set(key, entry);
        } else {
          entry.attack = attack;
          this.updateGeometry(entry, player);
        }
        this.updateLabel(entry, player);
      }
    }

    // Drop entries whose attacks ended.
    for (const [key, entry] of this.entries) {
      if (!live.has(key)) this.disposeEntry(entry, key);
    }
  }

  /** Tear everything down (e.g. on game restart). */
  clear(): void {
    for (const [key, entry] of this.entries) this.disposeEntry(entry, key);
  }

  // ── Internals ──

  /** Only show indicators for attacks where both sides have an owner. */
  private shouldShow(attack: Attack): boolean {
    const target = this.game.tiles[attack.targetTileIndex];
    return target.owner !== null;
  }

  private keyFor(player: Player, attack: Attack): string {
    return `${player.id}:${attack.targetTileIndex}`;
  }

  private createEntry(player: Player, attack: Attack): IndicatorEntry {
    const color = player.color.clone();

    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(ARROW_SEGMENTS * 3), 3)
    );
    const lineMat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const line = new THREE.Line(lineGeom, lineMat);
    line.renderOrder = 999;
    this.group.add(line);

    const headGeom = new THREE.ConeGeometry(
      ARROW_HEAD_SIZE * 0.45,
      ARROW_HEAD_SIZE,
      8
    );
    const headMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
    });
    const head = new THREE.Mesh(headGeom, headMat);
    head.renderOrder = 1000;
    this.group.add(head);

    const label = document.createElement("div");
    label.className = "attack-indicator";
    label.style.borderColor = "#" + color.getHexString();
    this.labelContainer.appendChild(label);

    const entry: IndicatorEntry = { attack, line, head, label };
    this.updateGeometry(entry, player);
    return entry;
  }

  private updateGeometry(entry: IndicatorEntry, _player: Player): void {
    const fromTile = this.game.tiles[entry.attack.fromTileIndex];
    const toTile = this.game.tiles[entry.attack.targetTileIndex];

    const start = fromTile.centroid.clone().normalize().multiplyScalar(ARROW_RADIUS);
    const end = toTile.centroid.clone().normalize().multiplyScalar(ARROW_RADIUS);

    // Mid-point lifted slightly above the globe to give the arrow an arc.
    const mid = start
      .clone()
      .add(end)
      .multiplyScalar(0.5)
      .normalize()
      .multiplyScalar(ARROW_RADIUS * (1 + ARC_LIFT));

    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const positions = (
      entry.line.geometry.attributes.position as THREE.BufferAttribute
    ).array as Float32Array;

    let lastPoint = start;
    for (let i = 0; i < ARROW_SEGMENTS; i++) {
      const p = curve.getPoint(i / (ARROW_SEGMENTS - 1));
      positions[i * 3] = p.x;
      positions[i * 3 + 1] = p.y;
      positions[i * 3 + 2] = p.z;
      if (i === ARROW_SEGMENTS - 2) lastPoint = p;
    }
    entry.line.geometry.attributes.position.needsUpdate = true;
    entry.line.geometry.computeBoundingSphere();

    // Orient the arrow head along the tangent at the end of the curve.
    entry.head.position.copy(end);
    const tangent = end.clone().sub(lastPoint).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    entry.head.quaternion.setFromUnitVectors(up, tangent);
  }

  private updateLabel(entry: IndicatorEntry, player: Player): void {
    const fromTile = this.game.tiles[entry.attack.fromTileIndex];
    const toTile = this.game.tiles[entry.attack.targetTileIndex];

    // Place label over the arc midpoint.
    this.projected
      .copy(fromTile.centroid)
      .add(toTile.centroid)
      .multiplyScalar(0.5)
      .normalize()
      .multiplyScalar(GLOBE_RADIUS * (1 + ARC_LIFT * 1.4));

    const cameraDir = this.camera.position.clone().normalize();
    const facing = this.projected.clone().normalize().dot(cameraDir);
    if (facing < 0.05) {
      entry.label.style.display = "none";
      return;
    }

    const ndc = this.projected.clone().project(this.camera);
    if (ndc.z > 1 || ndc.z < -1) {
      entry.label.style.display = "none";
      return;
    }

    const x = (ndc.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-ndc.y * 0.5 + 0.5) * window.innerHeight;

    // Show committed flow rate (troops/tick) and progress.
    const flow = entry.attack.flowRate;
    const pct = Math.floor(entry.attack.progress * 100);
    entry.label.textContent = `⚔ ${player.name} → ${flow.toFixed(1)}/t · ${pct}%`;
    entry.label.style.display = "block";
    entry.label.style.opacity = String(Math.min(1, facing * 3));
    entry.label.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
  }

  private disposeEntry(entry: IndicatorEntry, key: string): void {
    this.group.remove(entry.line);
    this.group.remove(entry.head);
    entry.line.geometry.dispose();
    (entry.line.material as THREE.Material).dispose();
    entry.head.geometry.dispose();
    (entry.head.material as THREE.Material).dispose();
    entry.label.remove();
    this.entries.delete(key);
  }
}
