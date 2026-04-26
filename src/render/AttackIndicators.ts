import * as THREE from "three";
import { GLOBE_RADIUS } from "../globe/GlobeMesh";
import { type GameState } from "../game/GameState";
import { type Player } from "../game/Player";
import { type Attack } from "../game/Attack";

// ─────────────────────────────────────────────
// AttackIndicators.ts
// One arrow + label per active player-vs-player
// campaign. The arrow arcs from the attacker's
// border to a representative target tile on the
// shared front; the label shows the troop pool
// remaining in the campaign.
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
  // Keyed by `${attackerId}:${defenderId}` for stable identity per campaign.
  private entries = new Map<string, IndicatorEntry>();
  private projected = new THREE.Vector3();
  private start = new THREE.Vector3();
  private end = new THREE.Vector3();
  private mid = new THREE.Vector3();
  private point = new THREE.Vector3();
  private tangent = new THREE.Vector3();
  private cameraDir = new THREE.Vector3();
  private ndc = new THREE.Vector3();

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

    // Drop entries whose campaigns ended.
    for (const [key, entry] of this.entries) {
      if (!live.has(key)) this.disposeEntry(entry, key);
    }
  }

  /** Tear everything down (e.g. on game restart). */
  clear(): void {
    for (const [key, entry] of this.entries) this.disposeEntry(entry, key);
  }

  // ── Internals ──

  /** Only show indicators for player-vs-player campaigns. */
  private shouldShow(attack: Attack): boolean {
    return attack.defenderId !== null;
  }

  private keyFor(player: Player, attack: Attack): string {
    return `${player.id}:${attack.defenderId ?? "exp"}`;
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
    line.frustumCulled = false;
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
    head.frustumCulled = false;
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
    const toTile = this.game.tiles[entry.attack.toTileIndex];

    this.start.copy(fromTile.centroid).normalize().multiplyScalar(ARROW_RADIUS);
    this.end.copy(toTile.centroid).normalize().multiplyScalar(ARROW_RADIUS);
    this.mid
      .copy(this.start)
      .add(this.end)
      .multiplyScalar(0.5)
      .normalize()
      .multiplyScalar(ARROW_RADIUS * (1 + ARC_LIFT));
    const positions = (
      entry.line.geometry.attributes.position as THREE.BufferAttribute
    ).array as Float32Array;

    let lastX = this.start.x;
    let lastY = this.start.y;
    let lastZ = this.start.z;
    for (let i = 0; i < ARROW_SEGMENTS; i++) {
      const t = i / (ARROW_SEGMENTS - 1);
      const oneMinusT = 1 - t;
      this.point
        .copy(this.start)
        .multiplyScalar(oneMinusT * oneMinusT)
        .addScaledVector(this.mid, 2 * oneMinusT * t)
        .addScaledVector(this.end, t * t);

      positions[i * 3] = this.point.x;
      positions[i * 3 + 1] = this.point.y;
      positions[i * 3 + 2] = this.point.z;
      if (i === ARROW_SEGMENTS - 2) {
        lastX = this.point.x;
        lastY = this.point.y;
        lastZ = this.point.z;
      }
    }
    entry.line.geometry.attributes.position.needsUpdate = true;

    // Orient the arrow head along the tangent at the end of the curve.
    entry.head.position.copy(this.end);
    this.tangent
      .set(this.end.x - lastX, this.end.y - lastY, this.end.z - lastZ)
      .normalize();
    entry.head.quaternion.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.tangent);
  }

  private updateLabel(entry: IndicatorEntry, player: Player): void {
    const fromTile = this.game.tiles[entry.attack.fromTileIndex];
    const toTile = this.game.tiles[entry.attack.toTileIndex];

    // Place label over the arc midpoint.
    this.projected
      .copy(fromTile.centroid)
      .add(toTile.centroid)
      .multiplyScalar(0.5)
      .normalize()
      .multiplyScalar(GLOBE_RADIUS * (1 + ARC_LIFT * 1.4));

    this.cameraDir.copy(this.camera.position).normalize();
    const facing = this.projected.normalize().dot(this.cameraDir);
    if (facing < 0.05) {
      entry.label.style.display = "none";
      return;
    }

    this.ndc.copy(this.projected).project(this.camera);
    if (this.ndc.z > 1 || this.ndc.z < -1) {
      entry.label.style.display = "none";
      return;
    }

    const x = (this.ndc.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.ndc.y * 0.5 + 0.5) * window.innerHeight;

    // Show the troop pool committed to this campaign.
    const troops = Math.max(0, Math.floor(entry.attack.troops));
    entry.label.textContent = `⚔ ${player.name} → ${troops}`;
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
