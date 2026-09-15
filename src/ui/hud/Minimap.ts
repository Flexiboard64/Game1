import { Vector3, type Object3D } from 'three/webgpu';
import { CANYON, HUD, MESA, MINIMAP, PALETTE, RAIL, SNOW, WRECK } from '../../config';
import { PLAYER_ARROW, VIEW_CONE } from '../glyphs';
import type { ThirdPersonCamera } from '../../player/ThirdPersonCamera';
import type { Terrain } from '../../world/Terrain';
import type { HeightField } from '../../world/HeightField';
import type { SnowField } from '../../world/SnowField';
import type { TrackSpec } from '../../world/TrackSpec';

// Minimap « carte peinte » rendue CPU une fois au démarrage (512², splat ×
// hillshade), indépendante du backend. M6 : DEUX cartes (vallée + Snezhnaya
// rectangulaire) commutées par la position ; le voile givré ne signale plus
// que l'interstice du tunnel (hors des deux régions).

const MAP_RES = 512;

interface RegionMap {
  dataUrl: string;
  sizeX: number;
  sizeZ: number;
  cx: number;
  cz: number;
}

export class Minimap {
  private readonly el: HTMLDivElement;
  private readonly mapEl: HTMLDivElement;
  private readonly cone: HTMLDivElement;
  private readonly valley: RegionMap;
  private readonly snowRegion: RegionMap | null = null;
  private readonly snowField: SnowField | null = null;
  private current: RegionMap;
  private offMap = false;

  constructor(
    parent: HTMLElement,
    terrain: Terrain,
    ground: HeightField,
    trees: readonly { x: number; z: number; r: number }[] = [],
    snowMap?: { snow: SnowField; track: TrackSpec; buildings: readonly { x: number; z: number; r: number }[] },
  ) {
    this.valley = {
      dataUrl: renderMap(terrain, ground, trees),
      sizeX: ground.size,
      sizeZ: ground.size,
      cx: 0,
      cz: 0,
    };
    if (snowMap) {
      this.snowRegion = {
        dataUrl: renderSnowMap(snowMap.snow, snowMap.track, snowMap.buildings),
        sizeX: SNOW.halfX * 2,
        sizeZ: SNOW.halfZ * 2,
        cx: SNOW.center.x,
        cz: SNOW.center.z,
      };
      this.snowField = snowMap.snow;
    }
    this.current = this.valley;

    this.el = document.createElement('div');
    this.el.className = 'minimap';
    this.el.innerHTML = `
      <div class="minimap-clip">
        <div class="minimap-rotator"><div class="minimap-map"></div></div>
      </div>
      <div class="minimap-halo"></div>
      <div class="minimap-ring"></div>
      <div class="minimap-cone">${VIEW_CONE}</div>
      <div class="minimap-arrow">${PLAYER_ARROW}</div>
      <div class="minimap-north">N</div>`;
    parent.appendChild(this.el);

    this.mapEl = this.el.querySelector<HTMLDivElement>('.minimap-map')!;
    this.cone = this.el.querySelector<HTMLDivElement>('.minimap-cone')!;
    this.mapEl.style.backgroundImage = `url(${this.valley.dataUrl})`;
  }

  // playerVisual = transform interpolée du modèle (même état que le rendu 3D) :
  // lire l'état 60 Hz brut du contrôleur ferait strober la flèche à 120 Hz
  // pendant que la carte, elle, tourne à la cadence de rendu (orbit.yaw)
  update(orbit: ThirdPersonCamera, playerVisual: Object3D): void {
    const clip = this.el.querySelector<HTMLDivElement>('.minimap-clip')!;
    const radius = clip.clientWidth / 2;
    if (radius === 0) return;
    const pxPerMeter = radius / HUD.minimapWorldRadius;
    const px = playerVisual.position.x;
    const pz = playerVisual.position.z;

    // Commutation de région (hystérésis implicite : contains() a 0 recouvrement)
    const wanted = this.snowRegion && this.snowField?.contains(px, pz) ? this.snowRegion : this.valley;
    if (wanted !== this.current) {
      this.current = wanted;
      this.mapEl.style.backgroundImage = `url(${wanted.dataUrl})`;
    }
    const region = this.current;

    // Hors des DEUX régions (interstice du tunnel) : clamp + voile givré
    const rx = px - region.cx;
    const rz = pz - region.cz;
    const cx = Math.min(Math.max(rx, -region.sizeX / 2), region.sizeX / 2);
    const cz = Math.min(Math.max(rz, -region.sizeZ / 2), region.sizeZ / 2);
    const off = cx !== rx || cz !== rz;
    if (off !== this.offMap) {
      this.offMap = off;
      this.el.classList.toggle('minimap-offmap', off);
    }

    // Carte FIXE nord en haut (style Genshin, « N » statique en CSS) : seule la
    // position translate ; le cône tourne avec la caméra, la flèche avec le cap
    const u = (cx + region.sizeX / 2) / region.sizeX;
    const v = (cz + region.sizeZ / 2) / region.sizeZ;
    const mapW = region.sizeX * pxPerMeter;
    const mapH = region.sizeZ * pxPerMeter;

    this.mapEl.style.width = `${mapW}px`;
    this.mapEl.style.height = `${mapH}px`;
    this.mapEl.style.transform = `translate(${radius - u * mapW}px, ${radius - v * mapH}px)`;

    // Cône de vision : forward caméra XZ = (−sin yaw, −cos yaw) → rotate(−yaw)
    this.cone.style.transform = `rotate(${-orbit.yaw}rad)`;

    // Flèche : cap absolu du personnage (0 = +Z = bas de la carte) → π − h
    const h = playerVisual.rotation.y;
    const arrow = this.el.querySelector<HTMLDivElement>('.minimap-arrow')!;
    arrow.style.transform = `translate(-50%, -50%) rotate(${Math.PI - h}rad)`;
  }
}

/** Carte de la région Snezhnaya : hauteur/pente + glace plate + voie + repères. */
function renderSnowMap(
  snow: SnowField,
  track: TrackSpec,
  buildings: readonly { x: number; z: number; r: number }[],
): string {
  const RES_X = 192;
  const RES_Z = Math.round((RES_X * SNOW.halfZ) / SNOW.halfX); // ≈ 284 (aspect exact)
  const canvas = document.createElement('canvas');
  canvas.width = RES_X;
  canvas.height = RES_Z;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(RES_X, RES_Z);
  const light = new Vector3(SUN_DIR.x, SUN_DIR.y, SUN_DIR.z).normalize();
  const n = new Vector3();
  const sizeX = SNOW.halfX * 2;
  const sizeZ = SNOW.halfZ * 2;

  for (let py = 0; py < RES_Z; py++) {
    for (let pxx = 0; pxx < RES_X; pxx++) {
      const x = SNOW.center.x - SNOW.halfX + (pxx / (RES_X - 1)) * sizeX;
      const z = SNOW.center.z - SNOW.halfZ + (py / (RES_Z - 1)) * sizeZ;
      const o = (py * RES_X + pxx) * 4;
      const h = snow.getHeight(x, z);
      const dm = Math.hypot(x - MESA.cx, z - MESA.cz);
      const ice = snow.seaSdf(x, z) < 0 || (dm > CANYON.rIn && dm < CANYON.rOut && h < CANYON.floorY + 0.8);
      if (ice) {
        img.data[o] = 128;
        img.data[o + 1] = 186;
        img.data[o + 2] = 205;
        img.data[o + 3] = 255;
        continue;
      }
      snow.getNormal(x, z, n);
      let shade = MINIMAP.shadeBase + Math.max(0, n.dot(light)) * MINIMAP.shadeRange;
      shade *= 1 - MINIMAP.slopeDarken * (1 - n.y);
      // Plateau de la ville : gris pierre ; neige bleutée partout ailleurs
      const plateau = h > MESA.topY - 1.5 && dm < MESA.rBase;
      const base = plateau ? [168, 174, 186] : [212, 224, 240];
      img.data[o] = base[0]! * shade;
      img.data[o + 1] = base[1]! * shade;
      img.data[o + 2] = base[2]! * shade;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const toPx = (x: number, z: number): [number, number] => [
    ((x - (SNOW.center.x - SNOW.halfX)) / sizeX) * RES_X,
    ((z - (SNOW.center.z - SNOW.halfZ)) / sizeZ) * RES_Z,
  ];

  // Voie ferrée : polyligne sombre du débouché du tube au heurtoir ville
  ctx.strokeStyle = '#3B4255';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  for (let s = track.sTubeExit; s <= track.length; s += 4) {
    track.pose(s, pose);
    const [mx, mz] = toPx(pose.x, pose.z);
    if (s === track.sTubeExit) ctx.moveTo(mx, mz);
    else ctx.lineTo(mx, mz);
  }
  ctx.stroke();

  // Bâtiments : pastilles cramoisies (toits) — le palais ressort par sa taille
  ctx.fillStyle = '#8a2c3a';
  for (const b of buildings) {
    const [bx, bz] = toPx(b.x, b.z);
    ctx.beginPath();
    ctx.arc(bx, bz, Math.max(b.r * (RES_X / sizeX), 1.6), 0, Math.PI * 2);
    ctx.fill();
  }

  // Épave (réf 2) : trait sombre incliné
  {
    const [wx, wz] = toPx(WRECK.x, WRECK.z);
    ctx.save();
    ctx.translate(wx, wz);
    ctx.rotate(-WRECK.yaw);
    ctx.fillStyle = '#463f3a';
    ctx.fillRect(-1.5, -4, 3, 8);
    ctx.restore();
  }

  // Gares : pastilles dorées cerclées (Toundra + Snezhnograd)
  for (const st of [RAIL.stationSnow, RAIL.stationCity]) {
    const [sx, sz] = toPx(st.x, st.z);
    ctx.fillStyle = PALETTE.gold;
    ctx.strokeStyle = '#3B4255';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(sx, sz, 4.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  return canvas.toDataURL();
}

const SUN_DIR = { x: -0.55, y: 0.72, z: -0.42 };

function renderMap(
  terrain: Terrain,
  ground: HeightField,
  trees: readonly { x: number; z: number; r: number }[],
): string {
  const canvas = document.createElement('canvas');
  canvas.width = MAP_RES;
  canvas.height = MAP_RES;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(MAP_RES, MAP_RES);
  const half = ground.size / 2;
  const light = new Vector3(-0.55, 0.72, -0.42).normalize();
  const n = new Vector3();

  // Palette sombre/réaliste + relief marqué (constantes dans config.MINIMAP)
  const grassCol = MINIMAP.grass;
  const dirtCol = MINIMAP.dirt;
  const rockCol = MINIMAP.rock;

  for (let py = 0; py < MAP_RES; py++) {
    for (let px = 0; px < MAP_RES; px++) {
      const x = (px / (MAP_RES - 1)) * ground.size - half;
      const z = (py / (MAP_RES - 1)) * ground.size - half;

      // Eau : surface horizontale → couleur plate SANS hillshade (style Genshin)
      if (ground.getWaterSdf(x, z) < 0) {
        const o = (py * MAP_RES + px) * 4;
        img.data[o] = MINIMAP.water[0]!;
        img.data[o + 1] = MINIMAP.water[1]!;
        img.data[o + 2] = MINIMAP.water[2]!;
        img.data[o + 3] = 255;
        continue;
      }

      const s = terrain.getSplat(x, z);
      ground.getNormal(x, z, n);
      // Hillshade contrasté puis assombrissement par pente ; les valeurs > 255
      // sont clampées par Uint8ClampedArray, inutile de borner ici
      let shade = MINIMAP.shadeBase + Math.max(0, n.dot(light)) * MINIMAP.shadeRange;
      shade *= 1 - MINIMAP.slopeDarken * (1 - n.y);

      const o = (py * MAP_RES + px) * 4;
      img.data[o] = (grassCol[0]! * s.grass + dirtCol[0]! * s.dirt + rockCol[0]! * s.rock) * shade;
      img.data[o + 1] = (grassCol[1]! * s.grass + dirtCol[1]! * s.dirt + rockCol[1]! * s.rock) * shade;
      img.data[o + 2] = (grassCol[2]! * s.grass + dirtCol[2]! * s.dirt + rockCol[2]! * s.rock) * shade;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Blobs de canopée « carte peinte » : 3 disques jitterés par arbre, 2 tons
  const pxPerM = MAP_RES / ground.size;
  for (let i = 0; i < trees.length; i++) {
    const t = trees[i]!;
    const cx = (t.x + half) * pxPerM;
    const cy = (t.z + half) * pxPerM;
    const r = Math.max(t.r * pxPerM, 2);
    for (let j = 0; j < 3; j++) {
      // Jitter déterministe par index (pas de PRNG : lisibilité > exactitude)
      const jx = Math.sin(i * 7.3 + j * 2.1) * r * 0.45;
      const jy = Math.cos(i * 5.1 + j * 3.7) * r * 0.45;
      ctx.fillStyle = j === 0 ? MINIMAP.treeFill : MINIMAP.treeHighlight;
      ctx.beginPath();
      ctx.arc(cx + jx, cy + jy, r * (j === 0 ? 1 : 0.62), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Gare du train (M5) : pastille dorée cerclée à l'emplacement du quai Vallée
  {
    const sx = ((RAIL.stationValley.x + half) / ground.size) * MAP_RES;
    const sy = ((RAIL.stationValley.z + half) / ground.size) * MAP_RES;
    ctx.fillStyle = PALETTE.gold;
    ctx.strokeStyle = '#3B4255';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(sx, sy, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Petit « rail » stylisé : deux traits sombres dans la pastille
    ctx.strokeStyle = '#3B4255';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(sx - 3, sy - 1.4);
    ctx.lineTo(sx + 3, sy - 1.4);
    ctx.moveTo(sx - 3, sy + 1.4);
    ctx.lineTo(sx + 3, sy + 1.4);
    ctx.stroke();
  }

  // Marqueur de quête : losange doré (tourne avec la carte — lisible à cette taille)
  const q = terrain.questPosition;
  const qx = ((q.x + half) / ground.size) * MAP_RES;
  const qy = ((q.z + half) / ground.size) * MAP_RES;
  ctx.save();
  ctx.translate(qx, qy);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = PALETTE.elements.geo;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.fillRect(-5, -5, 10, 10);
  ctx.strokeRect(-5, -5, 10, 10);
  ctx.restore();

  return canvas.toDataURL();
}
