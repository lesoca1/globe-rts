import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createGlobeMesh, GLOBE_RADIUS } from "./globe/GlobeMesh";
import { buildTiles, buildAdjacency, paintTile } from "./globe/TileData";
import { pickTile } from "./input/Raycaster";
import { GameState } from "./game/GameState";
import { runAI } from "./game/AI";

// ── Renderer ──
const canvas = document.getElementById("globe-canvas") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0a0a1a);

// ── Scene ──
const scene = new THREE.Scene();

// ── Camera ──
const camera = new THREE.PerspectiveCamera(
  50, window.innerWidth / window.innerHeight, 0.1, 100
);
camera.position.set(0, 0, 14);

// ── Orbit Controls ──
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.8;
controls.minDistance = GLOBE_RADIUS + 0.5;
controls.maxDistance = GLOBE_RADIUS * 5;
controls.enablePan = false;

// ── Lighting ──
// Key light tracks the camera so the visible hemisphere is always lit
// (no day/night shadow). Strong ambient + hemisphere fill keeps the
// silhouette edges from going dark, while flat-shaded normals still
// give each tile its faceted look.
const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
scene.add(keyLight);
scene.add(new THREE.AmbientLight(0xffffff, 1.1));
scene.add(new THREE.HemisphereLight(0xb0c8ff, 0x8a7a66, 0.5));

// ── Globe ──
console.time("Globe mesh");
const globeMesh = createGlobeMesh();
scene.add(globeMesh);
console.timeEnd("Globe mesh");

// ── Tile data ──
console.time("Build tiles");
const tiles = buildTiles(globeMesh.geometry);
console.timeEnd("Build tiles");

console.time("Build adjacency");
buildAdjacency(globeMesh.geometry, tiles);
console.timeEnd("Build adjacency");

console.log(`Globe: ${tiles.length} tiles`);

// ── Atmosphere + stars ──
const atmosGeo = new THREE.SphereGeometry(GLOBE_RADIUS * 1.012, 64, 64);
const atmosMat = new THREE.MeshBasicMaterial({
  color: 0x4488ff, transparent: true, opacity: 0.06, side: THREE.BackSide,
});
scene.add(new THREE.Mesh(atmosGeo, atmosMat));

const starCount = 2000;
const starPos = new Float32Array(starCount * 3);
for (let i = 0; i < starCount; i++) {
  const r = 40 + Math.random() * 20;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  starPos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  starPos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  starPos[i * 3 + 2] = r * Math.cos(phi);
}
const starGeo = new THREE.BufferGeometry();
starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
  color: 0xffffff, size: 0.08, sizeAttenuation: true,
})));

// ── Game State ──
const game = new GameState(tiles, globeMesh.geometry);

// Spawn 5 AI bots
game.setupAI(5);

// Hook AI into the game tick
const originalTick = game["tick"].bind(game);
game["tick"] = function () {
  originalTick();
  runAI(game);
};

// ── HUD elements ──
const tileInfoEl = document.getElementById("tile-info")!;
const playerStatsEl = document.getElementById("player-stats")!;
const controlsPanel = document.getElementById("controls-panel")!;
const leaderboardEl = document.getElementById("leaderboard")!;
const leaderboardList = document.getElementById("leaderboard-list")!;
const territoryBar = document.getElementById("territory-bar")!;
const territoryPct = document.getElementById("territory-pct")!;
const popValue = document.getElementById("pop-value")!;
const troopsValue = document.getElementById("troops-value")!;
const goldValue = document.getElementById("gold-value")!;
const troopRatioSlider = document.getElementById("troop-ratio") as HTMLInputElement;
const troopRatioLabel = document.getElementById("troop-ratio-label")!;
const attackSlider = document.getElementById("attack-intensity") as HTMLInputElement;
const attackLabel = document.getElementById("attack-intensity-label")!;
const victoryOverlay = document.getElementById("victory-overlay")!;
const victoryMessage = document.getElementById("victory-message")!;

// ── Slider handlers ──
troopRatioSlider.addEventListener("input", () => {
  const val = parseInt(troopRatioSlider.value) / 100;
  troopRatioLabel.textContent = `${troopRatioSlider.value}%`;
  const human = game.getHuman();
  if (human) human.troopRatio = val;
});

attackSlider.addEventListener("input", () => {
  const val = parseInt(attackSlider.value) / 100;
  attackLabel.textContent = `${attackSlider.value}%`;
  const human = game.getHuman();
  if (human) human.attackIntensity = val;
});

// ── State change: update HUD every tick ──
game.onStateChange = () => {
  const human = game.getHuman();
  if (!human) return;

  const terr = game.getTerritory(human);
  territoryBar.style.width = `${terr}%`;
  territoryPct.textContent = `${terr.toFixed(1)}%`;
  popValue.textContent = Math.floor(human.population).toString();
  troopsValue.textContent = Math.floor(human.troops).toString();
  goldValue.textContent = Math.floor(human.gold).toString();

  // Update leaderboard
  const sorted = [...game.players]
    .filter((p) => p.alive)
    .sort((a, b) => b.landTileCount - a.landTileCount);

  const dead = game.players.filter((p) => !p.alive);

  leaderboardList.innerHTML = [...sorted, ...dead]
    .map((p) => {
      const pct = game.getTerritory(p).toFixed(1);
      const cls = p.alive ? "" : " lb-dead";
      const hex = "#" + p.color.getHexString();
      return `<div class="lb-entry${cls}">
        <div class="lb-color" style="background:${hex}"></div>
        <span class="lb-name">${p.name}</span>
        <span class="lb-pct">${pct}%</span>
      </div>`;
    })
    .join("");
};

// ── Victory callback ──
game.onVictory = (winner) => {
  victoryOverlay.style.display = "flex";
  if (winner.isHuman) {
    victoryMessage.textContent = `You conquered ${game.getTerritory(winner).toFixed(1)}% of the globe!`;
  } else {
    victoryMessage.textContent = `${winner.name} conquered ${game.getTerritory(winner).toFixed(1)}% of the globe.`;
    document.getElementById("victory-title")!.textContent = "Defeat";
  }
};

// ── Click handling ──
const HIGHLIGHT_COLOR = new THREE.Color(0xffcc00);
let selectedTile: number = -1;

canvas.addEventListener("click", (event) => {
  const tileIndex = pickTile(event, camera, globeMesh);

  // Un-highlight previous
  if (selectedTile >= 0) {
    game.repaintTile(selectedTile);
  }

  if (tileIndex < 0) {
    selectedTile = -1;
    return;
  }

  const tile = tiles[tileIndex];

  // ── Spawning phase: click to start ──
  if (game.phase === "spawning") {
    const human = game.handleSpawnClick(tileIndex);
    if (human) {
      tileInfoEl.textContent = "Your empire has begun! Expanding...";
      playerStatsEl.style.display = "block";
      controlsPanel.style.display = "flex";
      leaderboardEl.style.display = "block";
      selectedTile = -1;

      // Set attack target to null initially (expand into unclaimed)
      human.attackTarget = null;
      return;
    } else {
      tileInfoEl.textContent = "Can't spawn there — pick a land tile";
      return;
    }
  }

  // ── Playing phase: select / attack ──
  selectedTile = tileIndex;
  paintTile(globeMesh.geometry, tileIndex, HIGHLIGHT_COLOR);

  const human = game.getHuman();
  if (human && tile.owner !== null && tile.owner !== human.id) {
    // Clicked an enemy tile → set as attack target
    human.attackTarget = tile.owner;
    const target = game.players.find((p) => p.id === tile.owner);
    tileInfoEl.textContent = `Attacking ${target?.name || "unknown"}!`;
  } else if (human && tile.owner === human.id) {
    // Clicked own tile
    human.attackTarget = null;
    tileInfoEl.textContent = `Your tile  |  ${tile.terrain.replace("_", " ")}`;
  } else {
    tileInfoEl.textContent =
      `${tile.terrain.replace("_", " ")}  |  ` +
      `${tile.latDeg.toFixed(1)}°, ${tile.lonDeg.toFixed(1)}°`;
  }
});

// ── Resize ──
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Render loop ──
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  keyLight.position.copy(camera.position);
  renderer.render(scene, camera);
}

animate();
