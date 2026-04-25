import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createGlobeMesh, GLOBE_RADIUS } from "./globe/GlobeMesh";
import { buildTiles, buildAdjacency, paintTile } from "./globe/TileData";
import { loadEarthData } from "./globe/EarthData";
import { pickTile } from "./input/Raycaster";
import { GameState } from "./game/GameState";
import { runAI } from "./game/AI";
import { PLAYER_PALETTE } from "./game/Player";

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
// Right-click drag rotates the globe; left-click is reserved for the
// game (spawning, selecting tiles, attacking).
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.rotateSpeed = 0.5;
controls.zoomSpeed = 0.8;
controls.minDistance = GLOBE_RADIUS + 0.5;
controls.maxDistance = GLOBE_RADIUS * 5;
controls.enablePan = false;
controls.mouseButtons = {
  LEFT: null as unknown as THREE.MOUSE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.ROTATE,
};

// Suppress the browser context menu so right-click drag works cleanly.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

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
console.time("Load Earth maps");
const earth = await loadEarthData();
console.timeEnd("Load Earth maps");

console.time("Build tiles");
const tiles = buildTiles(globeMesh.geometry, earth);
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

// Hook AI into the game tick
const originalTick = game["tick"].bind(game);
game["tick"] = function () {
  originalTick();
  runAI(game);
};

// ── Resize ──
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── Render loop ──
const labelContainer = document.getElementById("name-labels")!;
const labelMap = new Map<number, HTMLDivElement>();
const projectedPos = new THREE.Vector3();
const cameraDir = new THREE.Vector3();

function updateLabels() {
  if (game.phase === "menu") return;
  cameraDir.copy(camera.position).normalize();

  const seen = new Set<number>();
  for (const player of game.players) {
    if (!player.alive || player.landTileCount === 0) continue;
    seen.add(player.id);

    let label = labelMap.get(player.id);
    if (!label) {
      label = document.createElement("div");
      label.className = "name-label";
      label.style.color = "#fff";
      const hex = "#" + player.color.getHexString();
      label.style.borderLeft = `3px solid ${hex}`;
      label.textContent = player.name;
      labelContainer.appendChild(label);
      labelMap.set(player.id, label);
    }

    // Geographic center of territory, projected back to the globe surface.
    projectedPos.copy(player.tileCenterSum)
      .divideScalar(player.landTileCount)
      .normalize()
      .multiplyScalar(GLOBE_RADIUS * 1.005);

    // Hide labels on the far hemisphere.
    const facing = projectedPos.clone().normalize().dot(cameraDir);
    if (facing < 0.05) {
      label.style.display = "none";
      continue;
    }

    const ndc = projectedPos.clone().project(camera);
    if (ndc.z > 1 || ndc.z < -1) {
      label.style.display = "none";
      continue;
    }

    const x = (ndc.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-ndc.y * 0.5 + 0.5) * window.innerHeight;
    label.style.display = "block";
    label.style.opacity = String(Math.min(1, facing * 3));
    label.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
  }

  // Drop labels for players that no longer exist.
  for (const [id, label] of labelMap) {
    if (!seen.has(id)) {
      label.remove();
      labelMap.delete(id);
    }
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  keyLight.position.copy(camera.position);
  updateLabels();
  renderer.render(scene, camera);
}

animate();

// ─────────────────────────────────────────────
// Start menu — must complete before the game begins.
// ─────────────────────────────────────────────

const startMenu = document.getElementById("start-menu")!;
const hud = document.getElementById("hud")!;
const cfgName = document.getElementById("cfg-name") as HTMLInputElement;
const cfgBots = document.getElementById("cfg-bots") as HTMLInputElement;
const cfgBotsVal = document.getElementById("cfg-bots-val")!;
const cfgStartBtn = document.getElementById("cfg-start") as HTMLButtonElement;
const colorPicker = document.getElementById("cfg-color-picker")!;

cfgBots.addEventListener("input", () => {
  cfgBotsVal.textContent = cfgBots.value;
});

let selectedPaletteIndex = 0;
PLAYER_PALETTE.forEach(([main], idx) => {
  const sw = document.createElement("div");
  sw.className = "color-swatch" + (idx === 0 ? " selected" : "");
  sw.style.background = "#" + new THREE.Color(main).getHexString();
  sw.dataset.idx = String(idx);
  sw.addEventListener("click", () => {
    selectedPaletteIndex = idx;
    colorPicker.querySelectorAll(".color-swatch").forEach((el) =>
      el.classList.remove("selected")
    );
    sw.classList.add("selected");
  });
  colorPicker.appendChild(sw);
});

cfgStartBtn.addEventListener("click", () => {
  game.setupGame({
    playerName: cfgName.value.trim() || "Commander",
    playerPaletteIndex: selectedPaletteIndex,
    botCount: parseInt(cfgBots.value, 10),
  });

  startMenu.style.display = "none";
  hud.style.display = "flex";

  beginCountdown();
});

// ─────────────────────────────────────────────
// HUD wiring (only takes effect after game setup)
// ─────────────────────────────────────────────

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
const countdownOverlay = document.getElementById("countdown-overlay")!;
const countdownTimerEl = document.getElementById("countdown-timer")!;

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

game.onStateChange = () => {
  const human = game.getHuman();
  if (!human) return;

  const terr = game.getTerritory(human);
  territoryBar.style.width = `${terr}%`;
  territoryPct.textContent = `${terr.toFixed(1)}%`;
  popValue.textContent = Math.floor(human.population).toString();
  troopsValue.textContent = Math.floor(human.troops).toString();
  goldValue.textContent = Math.floor(human.gold).toString();

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

game.onVictory = (winner) => {
  victoryOverlay.style.display = "flex";
  if (winner.isHuman) {
    victoryMessage.textContent = `You conquered ${game.getTerritory(winner).toFixed(1)}% of the globe!`;
  } else {
    victoryMessage.textContent = `${winner.name} conquered ${game.getTerritory(winner).toFixed(1)}% of the globe.`;
    document.getElementById("victory-title")!.textContent = "Defeat";
  }
};

// Apply the human's chosen color to the territory bar.
function styleHumanColor() {
  const human = game.getHuman();
  if (!human) return;
  const hex = "#" + human.color.getHexString();
  territoryBar.style.background = hex;
}

function beginCountdown() {
  styleHumanColor();
  leaderboardEl.style.display = "block";
  countdownOverlay.style.display = "block";
  tileInfoEl.textContent = "Click a land tile to claim your starting territory.";

  game.onCountdownTick = (secondsRemaining) => {
    countdownTimerEl.textContent = Math.ceil(secondsRemaining).toString();
  };

  game.onCountdownEnd = () => {
    countdownOverlay.style.display = "none";
    playerStatsEl.style.display = "block";
    controlsPanel.style.display = "flex";
    tileInfoEl.textContent = "Right-click drag to spin · left-click to select / attack";
  };

  game.startCountdown();
}

// ── Click handling ──
const HIGHLIGHT_COLOR = new THREE.Color(0xffcc00);
let selectedTile: number = -1;

// Treat any left-mousedown that travels more than DRAG_THRESHOLD_PX
// before releasing as a drag, not a click — keeps a stray hand on the
// mouse from spawning your empire on the wrong continent.
const DRAG_THRESHOLD_PX = 5;
let mouseDownX = 0;
let mouseDownY = 0;
let mouseDownButton = -1;

canvas.addEventListener("mousedown", (event) => {
  mouseDownX = event.clientX;
  mouseDownY = event.clientY;
  mouseDownButton = event.button;
});

canvas.addEventListener("click", (event) => {
  // Only the primary (left) button fires `click`. Right-click drags
  // are handled by OrbitControls and never reach here.
  if (game.phase === "menu") return;

  if (mouseDownButton === 0) {
    const dx = event.clientX - mouseDownX;
    const dy = event.clientY - mouseDownY;
    if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) return;
  }

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

  // ── Countdown phase: click to spawn ──
  if (game.phase === "countdown") {
    const human = game.getHuman();
    if (!human || human.spawned) return;

    const result = game.handleSpawnClick(tileIndex);
    if (result) {
      tileInfoEl.textContent = "Empire founded — waiting for the world to unfreeze…";
      result.attackTarget = null;
      selectedTile = -1;
      return;
    } else {
      tileInfoEl.textContent = "Can't spawn there — pick an unclaimed land tile.";
      return;
    }
  }

  // ── Playing phase: select / attack ──
  selectedTile = tileIndex;
  paintTile(globeMesh.geometry, tileIndex, HIGHLIGHT_COLOR);

  const human = game.getHuman();
  if (human && tile.owner !== null && tile.owner !== human.id) {
    human.attackTarget = tile.owner;
    const target = game.players.find((p) => p.id === tile.owner);
    tileInfoEl.textContent = `Attacking ${target?.name || "unknown"}!`;
  } else if (human && tile.owner === human.id) {
    human.attackTarget = null;
    tileInfoEl.textContent = `Your tile  |  ${tile.terrain.replace("_", " ")}`;
  } else {
    tileInfoEl.textContent =
      `${tile.terrain.replace("_", " ")}  |  ` +
      `${tile.latDeg.toFixed(1)}°, ${tile.lonDeg.toFixed(1)}°`;
  }
});
