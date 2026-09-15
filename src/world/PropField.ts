import {
  Group,
  InstancedMesh,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Sphere,
  Texture,
  Vector3,
} from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CASCADE, FENCE, PROPS, RAIL, SPECIES, VISTA, type SpeciesParams } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import { loadProp, type LoadedProp } from '../assets/PropLoader';
import type { PropAssets } from '../core/AssetManager';
import type { HeightField } from './HeightField';
import type { Terrain } from './Terrain';
import type { ObstacleGrid } from './Obstacles';

// Semis générique de props (patron GrassField généralisé) : rejet par splat,
// pente, eau (SDF), chemin, dégagement du spawn + espacement Poisson-light via
// une grille de hachage spatiale partagée entre espèces, amas optionnels,
// alignement partiel à la normale, chunks 3×3 en InstancedMesh (une géométrie +
// un matériau par espèce). La clôture est posée à part, le long du chemin.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PlacedPoint {
  x: number;
  z: number;
  hard: number;   // rayon dur (tronc/corps)
  soft: number;   // rayon doux (canopée/encombrement)
  tall: boolean;  // les espèces lowGround ne testent que le rayon dur des « tall »
  species: string;
}

/** Hachage spatial des points posés — requêtes de voisinage en O(voisins). */
class PlacementHash {
  private readonly cells = new Map<number, PlacedPoint[]>();
  private static readonly CELL = 4;

  add(p: PlacedPoint): void {
    const k = this.key(Math.floor(p.x / PlacementHash.CELL), Math.floor(p.z / PlacementHash.CELL));
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push(p);
  }

  private key(cx: number, cz: number): number {
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  /** Vrai si (x,z) viole l'espacement pour l'espèce candidate S. */
  conflicts(x: number, z: number, s: SpeciesParams, speciesId: string): boolean {
    const maxR = Math.max(s.minSpacing, s.footprint + 4);
    const span = Math.ceil(maxR / PlacementHash.CELL);
    const cx = Math.floor(x / PlacementHash.CELL);
    const cz = Math.floor(z / PlacementHash.CELL);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const list = this.cells.get(this.key(cx + dx, cz + dz));
        if (!list) continue;
        for (const p of list) {
          const other = s.lowGround && p.tall ? p.hard : p.soft;
          const base = other + s.footprint;
          const minD = p.species === speciesId ? Math.max(s.minSpacing, base) : base;
          const ddx = x - p.x;
          const ddz = z - p.z;
          if (ddx * ddx + ddz * ddz < minD * minD) return true;
        }
      }
    }
    return false;
  }
}

interface Instance {
  x: number;
  y: number;
  z: number;
  yaw: number;
  s: number;
  ys: number; // écrasement vertical (rochers : silhouettes assises)
  nx: number;
  ny: number;
  nz: number;
}

export class PropField {
  readonly group = new Group();
  /** Canopées pour les blobs de la minimap. */
  readonly minimapTrees: { x: number; z: number; r: number }[] = [];
  /** Ancres des mufliers (sparkles + prompt F). */
  readonly snapdragonAnchors: Vector3[] = [];
  /** Props chargés, réutilisés par l'habillage de crête (RimDressing). */
  readonly loaded = new Map<string, LoadedProp>();

  constructor(
    terrain: Terrain,
    ground: HeightField,
    props: PropAssets,
    flowerAtlas: Texture | null,
    obstacles: ObstacleGrid,
    /** Distance XZ à l'axe de la voie ferrée (M5) — exclusion du semis. */
    trackDistance: ((x: number, z: number) => number) | null = null,
  ) {
    const hash = new PlacementHash();
    const half = ground.size / 2 - 2;

    // Géométries/matériaux par espèce — GLB normalisés ou billboards d'atlas
    const sources = new Map<string, LoadedProp>();
    const glbKeys: [string, keyof PropAssets][] = [
      ['treeA', 'treeA'],
      ['treeB', 'treeB'],
      ['boulderA', 'boulderA'],
      ['boulderB', 'boulderB'],
      ['bush', 'bush'],
      ['snapdragon', 'snapdragon'],
    ];
    for (const [key, assetKey] of glbKeys) {
      const gltf = props[assetKey];
      const spec = SPECIES[key]!;
      if (!gltf) {
        console.warn(`[PropField] GLB absent : ${key} — espèce ignorée`);
        continue;
      }
      const prop = loadProp(gltf, { targetHeight: spec.targetHeight, sway: spec.sway });
      if (prop) sources.set(key, prop);
    }
    for (const [key, prop] of sources) this.loaded.set(key, prop);
    if (flowerAtlas) {
      sources.set('flowersY', flowerBillboardProp(flowerAtlas, 0));
      sources.set('flowersB', flowerBillboardProp(flowerAtlas, 1));
    } else {
      console.warn('[PropField] atlas de fleurs absent — fleurs sauvages ignorées');
    }

    // Ordre de semis fixe : les gros d'abord (ils réservent leur empreinte)
    const order = ['treeA', 'treeB', 'boulderA', 'boulderB', 'bush', 'snapdragon', 'flowersY', 'flowersB'];
    const chunkCount = PROPS.chunks;
    const chunkSize = (half * 2) / chunkCount;

    for (let si = 0; si < order.length; si++) {
      const key = order[si]!;
      const spec = SPECIES[key]!;
      const prop = sources.get(key);
      if (!prop) continue;
      const rand = mulberry32(PROPS.seed + si * 131);

      // Amas : centres tirés d'abord (seed partagée ⇒ amas mixtes entre espèces)
      let centers: { x: number; z: number }[] | null = null;
      if (spec.clusters) {
        centers = [];
        const crand = mulberry32(PROPS.seed + spec.clusters.seed);
        let cAttempts = 0;
        // Bande nearWaterSdf = ruban étroit le long des rives : le tirage
        // uniforme sur la carte a besoin de beaucoup plus d'essais pour y tomber
        const cBudget = spec.clusters.count * (spec.nearWaterSdf ? 600 : 40);
        while (centers.length < spec.clusters.count && cAttempts < cBudget) {
          cAttempts++;
          const x = (crand() * 2 - 1) * half;
          const z = (crand() * 2 - 1) * half;
          if (Math.hypot(x, z) < PROPS.spawnClear + spec.clusters.radius) continue;
          // Les centres DOIVENT respecter la bande nearWaterSdf de l'espèce :
          // sinon tous les amas tombent loin des rives et le semis échoue à
          // 100 % (0/40 mufliers, prouvé par rejeu déterministe en revue)
          const csdf = ground.getWaterSdf(x, z);
          if (csdf < spec.waterClear) continue;
          if (spec.nearWaterSdf && (csdf < spec.nearWaterSdf[0] || csdf > spec.nearWaterSdf[1])) continue;
          if (ground.getSlopeDeg(x, z) > spec.slopeMaxDeg + 6) continue;
          if (centers.some((c) => Math.hypot(c.x - x, c.z - z) < spec.clusters!.radius * 1.5)) continue;
          centers.push({ x, z });
        }
      }

      const buckets: Instance[][] = Array.from({ length: chunkCount * chunkCount }, () => []);
      let placed = 0;
      let attempts = 0;
      const maxAttempts = spec.count * 40;
      const normal = new Vector3();
      while (placed < spec.count && attempts < maxAttempts) {
        attempts++;
        let x: number;
        let z: number;
        if (centers && centers.length > 0) {
          const c = centers[Math.floor(rand() * centers.length)]!;
          const ang = rand() * Math.PI * 2;
          const r = spec.clusters!.radius * Math.sqrt(rand());
          x = c.x + Math.cos(ang) * r;
          z = c.z + Math.sin(ang) * r;
        } else {
          x = (rand() * 2 - 1) * half;
          z = (rand() * 2 - 1) * half;
        }
        if (Math.abs(x) > half || Math.abs(z) > half) continue;
        if (Math.hypot(x, z) < PROPS.spawnClear) continue;
        // Corridor de vue spawn → cascade : les canopées y masqueraient la chute
        if (!spec.lowGround && spec.targetHeight > 2 && inVistaCorridor(x, z)) continue;
        if (terrain.pathDistance(x, z) < spec.pathClear) continue;
        // Emprise de la voie ferrée : rien SUR les rails (espèces hautes plus large)
        if (trackDistance && trackDistance(x, z) < (spec.lowGround ? RAIL.clearProps * 0.6 : RAIL.clearProps)) continue;
        const sdf = ground.getWaterSdf(x, z);
        if (sdf < spec.waterClear) continue;
        if (spec.nearWaterSdf && (sdf < spec.nearWaterSdf[0] || sdf > spec.nearWaterSdf[1])) continue;
        if (spec.grassMin > 0 && terrain.getSplat(x, z).grass < spec.grassMin) continue;
        if (ground.getSlopeDeg(x, z) > spec.slopeMaxDeg) continue;
        if (hash.conflicts(x, z, spec, key)) continue;

        const s = spec.scale[0] + rand() * (spec.scale[1] - spec.scale[0]);
        ground.getNormal(x, z, normal);
        const inst: Instance = {
          x,
          y: ground.getHeight(x, z) - spec.sinkFactor * s,
          z,
          yaw: rand() * Math.PI * 2,
          s,
          ys: spec.ySquash ? spec.ySquash[0] + rand() * (spec.ySquash[1] - spec.ySquash[0]) : 1,
          nx: normal.x,
          ny: normal.y,
          nz: normal.z,
        };
        const ci = Math.min(Math.floor((x + half) / chunkSize), chunkCount - 1);
        const cj = Math.min(Math.floor((z + half) / chunkSize), chunkCount - 1);
        buckets[cj * chunkCount + ci]!.push(inst);
        hash.add({
          x,
          z,
          hard: spec.hardRadius * s,
          soft: spec.footprint * s,
          tall: !spec.lowGround,
          species: key,
        });
        if (spec.collisionR > 0) obstacles.add({ x, z, r: spec.collisionR * s });
        if (key === 'boulderA' || key === 'boulderB') {
          // Halo d'assise : terre/roche tamponnées dans la splat sous le rocher
          // (l'herbe semée APRÈS — bush/fleurs/touffes — évite le halo via getSplat)
          terrain.stampSplat(x, z, 1.8 * spec.collisionR * s, 0.45, 0.25);
        }
        if (key === 'treeA' || key === 'treeB') {
          this.minimapTrees.push({ x, z, r: spec.footprint * s });
        }
        if (key === 'snapdragon') {
          this.snapdragonAnchors.push(new Vector3(x, inst.y + prop.height * s * 0.75, z));
        }
        placed++;
      }

      this.buildChunks(key, prop, spec, buckets);
      console.info(`[PropField] ${key} : ${placed}/${spec.count} posés (${attempts} tentatives)`);
    }

    // ---- Clôture le long du chemin principal ----
    const fenceProp = props.fence ? loadProp(props.fence, { targetHeight: FENCE.targetHeight }) : null;
    if (fenceProp) {
      this.loaded.set('fence', fenceProp);
      this.buildFence(terrain, ground, fenceProp, obstacles);
    } else {
      console.warn('[PropField] GLB absent : fence — clôture ignorée');
    }
  }

  private buildChunks(
    key: string,
    prop: LoadedProp,
    spec: SpeciesParams,
    buckets: Instance[][],
  ): void {
    const m = new Matrix4();
    const q = new Quaternion();
    const qYaw = new Quaternion();
    const scale = new Vector3();
    const up = new Vector3(0, 1, 0);
    const n = new Vector3();
    const qAlign = new Quaternion();

    for (const bucket of buckets) {
      if (bucket.length === 0) continue;
      const mesh = new InstancedMesh(prop.geometry, prop.material, bucket.length);
      const center = new Vector3();
      for (let i = 0; i < bucket.length; i++) {
        const b = bucket[i]!;
        // qAlign et q doivent rester distincts : slerpQuaternions(qa, qb)
        // fait this.copy(qa), donc avec this === qb l'alignement s'auto-écrase.
        n.set(b.nx, b.ny, b.nz);
        qAlign.setFromUnitVectors(up, n);
        q.identity().slerp(qAlign, spec.alignToNormal);
        qYaw.setFromAxisAngle(up, b.yaw);
        q.multiply(qYaw);
        scale.set(b.s, b.s * b.ys, b.s);
        m.compose(_pos.set(b.x, b.y, b.z), q, scale);
        mesh.setMatrixAt(i, m);
        center.add(_pos);
      }
      center.divideScalar(bucket.length);
      let radiusSq = 0;
      for (const b of bucket) {
        const d = (b.x - center.x) ** 2 + (b.y - center.y) ** 2 + (b.z - center.z) ** 2;
        if (d > radiusSq) radiusSq = d;
      }
      const margin = (prop.height + prop.radiusXZ) * spec.scale[1];
      mesh.boundingSphere = new Sphere(center.clone(), Math.sqrt(radiusSq) + margin);
      mesh.frustumCulled = true;
      mesh.castShadow = spec.castShadow;
      // false pour le feuillage : l'auto-ombrage reçu = acné sur les grandes
      // canopées lisses (le personnage, qui ne reçoit jamais, est indemne)
      mesh.receiveShadow = spec.receiveShadow;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.name = `props-${key}`;
      this.group.add(mesh);
    }
  }

  private buildFence(
    terrain: Terrain,
    ground: HeightField,
    prop: LoadedProp,
    obstacles: ObstacleGrid,
  ): void {
    const path = terrain.path;
    const step = Math.max(prop.lengthX * FENCE.overlap, 0.5);
    const pos = new Vector3();
    const tan = new Vector3();
    const placements: { x: number; z: number; y: number; yaw: number }[] = [];
    let s = FENCE.startT * path.length;
    let prevY: number | null = null;
    for (let i = 0; i < FENCE.segments && s < path.length; i++, s += step) {
      path.sample(s, pos, tan);
      const px = pos.x - tan.z * FENCE.sideOffset;
      const pz = pos.z + tan.x * FENCE.sideOffset;
      const y = ground.getHeight(px, pz);
      if (prevY !== null && Math.abs(y - prevY) > FENCE.maxHeightStep) {
        prevY = y;
        continue; // trou rustique dans la clôture
      }
      prevY = y;
      placements.push({ x: px, z: pz, y: y - 0.06, yaw: Math.atan2(tan.x, tan.z) + FENCE.yawOffset });
      obstacles.add({ x: px, z: pz, r: FENCE.obstacleR });
      const midX = px + tan.x * (prop.lengthX / 2);
      const midZ = pz + tan.z * (prop.lengthX / 2);
      obstacles.add({ x: midX, z: midZ, r: FENCE.obstacleR });
    }
    if (placements.length === 0) return;

    const mesh = new InstancedMesh(prop.geometry, prop.material, placements.length);
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const center = new Vector3();
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      q.setFromAxisAngle(up, p.yaw);
      m.compose(_pos.set(p.x, p.y, p.z), q, _one);
      mesh.setMatrixAt(i, m);
      center.add(_pos);
    }
    center.divideScalar(placements.length);
    let radiusSq = 0;
    for (const p of placements) {
      const d = (p.x - center.x) ** 2 + (p.y - center.y) ** 2 + (p.z - center.z) ** 2;
      if (d > radiusSq) radiusSq = d;
    }
    mesh.boundingSphere = new Sphere(center.clone(), Math.sqrt(radiusSq) + prop.lengthX + prop.height);
    mesh.frustumCulled = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'props-fence';
    this.group.add(mesh);
    console.info(`[PropField] fence : ${placements.length}/${FENCE.segments} segments`);
  }
}

/**
 * Vrai si (x,z) est dans le couloir de vue spawn → lèvre de la cascade, sur
 * les premiers VISTA.maxDist mètres (au-delà, la chute domine les canopées).
 * Exportée depuis M4 : les camps de golems (CampField) l'utilisent aussi.
 */
export function inVistaCorridor(x: number, z: number): boolean {
  const tx = CASCADE.top.x;
  const tz = CASCADE.top.z;
  const len2 = tx * tx + tz * tz;
  const t = Math.min(Math.max((x * tx + z * tz) / len2, 0), 1);
  const along = t * Math.sqrt(len2);
  if (along > VISTA.maxDist) return false;
  const perp = Math.hypot(x - tx * t, z - tz * t);
  // Le couloir s'évase avec la distance (la chute est vue sous un angle constant)
  const halfW = VISTA.halfWidth + (along / VISTA.maxDist) * VISTA.feather;
  return perp < halfW;
}

/** Deux quads croisés à 90° portant l'atlas de fleurs (rangée = espèce). */
function flowerBillboardProp(atlas: Texture, row: 0 | 1): LoadedProp {
  const { w, h } = PROPS.flowerQuad;
  const a = new PlaneGeometry(w, h);
  a.translate(0, h / 2, 0);
  const b = a.clone();
  b.rotateY(Math.PI / 2);
  const merged = mergeGeometries([a, b], false) ?? a;
  merged.computeBoundingSphere();
  return {
    geometry: merged,
    material: ToonMaterials.flowerBillboard(atlas, row),
    height: h,
    radiusXZ: w / 2,
    lengthX: w,
  };
}

const _pos = new Vector3();
const _one = new Vector3(1, 1, 1);
