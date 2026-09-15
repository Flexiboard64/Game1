import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Sphere,
  Vector3,
} from 'three/webgpu';
import { GRASS, WATER } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { HeightField } from './HeightField';
import type { Terrain } from './Terrain';

// Tapis d'herbe en TOUFFES : 2 géométries de touffe bakées (5/7 brins courbés,
// inclinés, effilés) partagées par tous les chunks, semis auto-adaptatif par
// densité (touffes/m² — le compte suit l'aire herbeuse de la carte), passe
// OPAQUE + alphaTest (early-Z, zéro tri), culling de distance par chunk.
// Compatible WebGPU ET WebGL2.

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

function smooth01(t: number): number {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
}

const DEG = Math.PI / 180;

/**
 * Géométrie d'une touffe : brin central quasi vertical + couronne de brins
 * inclinés radialement, chacun courbé (4 segments), effilé et pincé en pointe.
 * Attributs : position, normal (up constant — le shader force la normale de
 * toute façon), uv (x transversal, y = t le long du brin), aBlade (phase de
 * vent, aléa de dissolution) constant par brin.
 */
function clumpGeometry(blades: number, heightMul: number, rng: () => number): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const aBlade: number[] = [];
  const index: number[] = [];
  let vertBase = 0;

  for (let b = 0; b < blades; b++) {
    const isCenter = b === 0;
    const ringCount = blades - 1;
    const ringAngle = isCenter
      ? 0
      : ((b - 1) / ringCount) * Math.PI * 2 + (rng() - 0.5) * 36 * DEG;
    const rootR = isCenter ? 0 : GRASS.clumpRadius * (0.5 + rng() * 0.5);
    const rootX = Math.cos(ringAngle) * rootR;
    const rootZ = Math.sin(ringAngle) * rootR;

    const h = (GRASS.bladeHeightMin + rng() * (GRASS.bladeHeightMax - GRASS.bladeHeightMin)) * heightMul;
    const lean = isCenter
      ? rng() * GRASS.leanCenterDeg * DEG
      : (GRASS.leanRingMinDeg + rng() * (GRASS.leanRingMaxDeg - GRASS.leanRingMinDeg)) * DEG;
    const curve = (GRASS.curveTipMinDeg + rng() * (GRASS.curveTipMaxDeg - GRASS.curveTipMinDeg)) * DEG;
    // Azimut de flexion : radial vers l'extérieur pour la couronne (touffe évasée)
    const bendAz = isCenter ? rng() * Math.PI * 2 : ringAngle + (rng() - 0.5) * 0.6;
    const bx = Math.cos(bendAz);
    const bz = Math.sin(bendAz);
    // Direction de largeur : perpendiculaire horizontale au plan de flexion
    const wx = -bz;
    const wz = bx;

    const phase = rng() * Math.PI * 2;
    const dissolve = rng();
    const segs = GRASS.bladeSegments;

    // Centreligne incrémentale : θ(t) = lean + curve·t²
    let px = rootX;
    let py = 0;
    let pz = rootZ;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      let w = GRASS.bladeWidth * (1 - GRASS.bladeTaper * t) * 0.5;
      if (t > GRASS.tipPinchT) {
        w *= 1 - GRASS.tipPinch * ((t - GRASS.tipPinchT) / (1 - GRASS.tipPinchT));
      }
      positions.push(px - wx * w, py, pz - wz * w, px + wx * w, py, pz + wz * w);
      normals.push(0, 1, 0, 0, 1, 0);
      uvs.push(0, t, 1, t);
      aBlade.push(phase, dissolve, phase, dissolve);
      if (i < segs) {
        const theta = lean + curve * ((i + 1) / segs) ** 2;
        const step = h / segs;
        px += Math.sin(theta) * bx * step;
        py += Math.cos(theta) * step;
        pz += Math.sin(theta) * bz * step;
        const v = vertBase + i * 2;
        index.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    vertBase += (segs + 1) * 2;
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setAttribute('aBlade', new BufferAttribute(new Float32Array(aBlade), 2));
  geo.setIndex(index);
  return geo;
}

export class GrassField {
  readonly group = new Group();
  private readonly meshes: InstancedMesh[] = [];
  private readonly fadeEnd: number;

  constructor(isWebGPU: boolean, terrain: Terrain, ground: HeightField) {
    const clumpsPerM2 = isWebGPU ? GRASS.clumpsPerM2WebGPU : GRASS.clumpsPerM2WebGL;
    const maxClumps = isWebGPU ? GRASS.maxClumpsWebGPU : GRASS.maxClumpsWebGL;
    const fadeStart = isWebGPU ? GRASS.fadeStart : GRASS.fadeStartWebGL;
    this.fadeEnd = isWebGPU ? GRASS.fadeEnd : GRASS.fadeEndWebGL;
    const lowFlag = new URLSearchParams(location.search).has('grasslow');
    const density = clumpsPerM2 * (lowFlag ? 0.5 : 1);

    const rand = mulberry32(GRASS.seedScatter);
    const half = ground.size / 2 - 2;
    const chunkCount = GRASS.chunks;
    const chunkSize = (half * 2) / chunkCount;

    // Semis AUTO-ADAPTATIF : candidats uniformes ~densité × aire du monde ;
    // l'acceptation probabiliste sur le canal herbe donne des lisières dégradées
    // vers chemins/sable au lieu d'un seuil binaire
    const attempts = Math.floor(ground.size * ground.size * density);
    const buckets: { x: number; y: number; z: number; yaw: number; s: number; nx: number; ny: number; nz: number }[][] =
      Array.from({ length: chunkCount * chunkCount * 2 }, () => []);
    let placed = 0;
    let tried = 0;
    const normal = new Vector3();
    for (let a = 0; a < attempts && placed < maxClumps; a++) {
      tried++;
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      const g = terrain.getSplat(x, z).grass;
      const p = smooth01((g - GRASS.minGrassWeight) / (GRASS.grassWeightFull - GRASS.minGrassWeight));
      if (rand() >= p) continue;
      if (ground.getWaterSdf(x, z) < WATER.grassMargin) continue;
      const slope = ground.getSlopeDeg(x, z);
      if (slope > GRASS.maxSlopeDeg) continue;
      ground.getNormal(x, z, normal);
      const sink = GRASS.sinkBase + GRASS.clumpRadius * Math.tan(slope * DEG);
      const variant = rand() < GRASS.variantBShare ? 1 : 0;
      const ci = Math.min(Math.floor((x + half) / chunkSize), chunkCount - 1);
      const cj = Math.min(Math.floor((z + half) / chunkSize), chunkCount - 1);
      buckets[(cj * chunkCount + ci) * 2 + variant]!.push({
        x,
        y: ground.getHeight(x, z) - sink,
        z,
        yaw: rand() * Math.PI * 2,
        s: GRASS.scaleMin + rand() * (GRASS.scaleMax - GRASS.scaleMin),
        nx: normal.x,
        ny: normal.y,
        nz: normal.z,
      });
      placed++;
    }

    const geoRng = mulberry32(GRASS.seedGeometry);
    const geometries = [
      clumpGeometry(GRASS.bladesA, 1, geoRng),
      clumpGeometry(GRASS.bladesB, 0.9, geoRng),
    ];
    const material = ToonMaterials.grassBlade(terrain.splatTexture, fadeStart, this.fadeEnd);

    const m = new Matrix4();
    const q = new Quaternion();
    const qYaw = new Quaternion();
    const qAlign = new Quaternion();
    const scale = new Vector3();
    const up = new Vector3(0, 1, 0);
    const n = new Vector3();

    for (let bi = 0; bi < buckets.length; bi++) {
      const bucket = buckets[bi]!;
      if (bucket.length === 0) continue;
      const mesh = new InstancedMesh(geometries[bi % 2]!, material, bucket.length);
      const center = new Vector3();
      for (let i = 0; i < bucket.length; i++) {
        const b = bucket[i]!;
        // Assise : léger slerp vers la normale (les brins restent « vers le ciel »).
        // Destination et cible DOIVENT être des quaternions distincts :
        // slerpQuaternions(qa, qb) fait this.copy(qa) — si this === qb, la cible
        // est écrasée par qa et l'interpolation ne fait plus rien (l'alignement
        // était mort pour TOUS les props, prouvé en revue)
        n.set(b.nx, b.ny, b.nz);
        qAlign.setFromUnitVectors(up, n);
        q.identity().slerp(qAlign, GRASS.alignToNormal);
        qYaw.setFromAxisAngle(up, b.yaw);
        q.multiply(qYaw);
        scale.setScalar(b.s);
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
      mesh.boundingSphere = new Sphere(center.clone(), Math.sqrt(radiusSq) + 1.0);
      mesh.frustumCulled = true;
      mesh.castShadow = false; // brin 5-11 cm vs texel d'ombre 4,4 cm = pointillisme
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      this.group.add(mesh);
      this.meshes.push(mesh);
    }

    const blades = Math.round(placed * (GRASS.bladesA * (1 - GRASS.variantBShare) + GRASS.bladesB * GRASS.variantBShare));
    // Aire herbeuse estimée par Monte-Carlo (taux d'acceptation × aire du monde) :
    // la densité RÉELLE chute sous la cible dès que le cap tronque le semis —
    // le dire explicitement, jamais de plafond silencieux
    const eligible = (placed / tried) * ground.size * ground.size;
    const realized = placed / eligible;
    const capped = placed >= maxClumps;
    console.info(
      `[GrassField] ${placed} touffes (~${blades} brins) sur ~${Math.round(eligible)} m² herbeux`
      + ` — densité ${realized.toFixed(2)}/m² (cible ${density.toFixed(2)})`
      + `${capped ? ` — CAP ${maxClumps} ATTEINT (densité bridée)` : ''}`
      + ` dans ${this.meshes.length} chunks`,
    );
  }

  /** Culling de distance par chunk : borne le coût GPU au disque de fade. */
  update(camPos: Vector3): void {
    for (const mesh of this.meshes) {
      const s = mesh.boundingSphere!;
      mesh.visible = camPos.distanceTo(s.center) - s.radius < this.fadeEnd + 1;
    }
  }
}

const _pos = new Vector3();
