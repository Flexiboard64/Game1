import { Group, InstancedMesh, Matrix4, Mesh, PlaneGeometry, Quaternion, Vector3 } from 'three/webgpu';
import { BELVEDERE, CANYON, CITY, CREVASSE, MESA, RAIL, SEA_ICE, SNOW, WRECK } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { LoadedProp } from '../assets/PropLoader';
import type { ObstacleGrid } from './Obstacles';
import type { TrackSpec } from './TrackSpec';

// Région Snezhnaya (M6, ex-« Val des Flocons » M5) : grand terrain analytique
// rectangulaire hors carte principale. Deux zones empilées sur Z : toundra du
// blizzard (mer gelée, épave, arène) puis Snezhnograd (mesa + canyon + palais).
// Sol = passes analytiques ordonnées (doctrine M3 : smax pour les plateaux,
// force des carves PLAFONNÉE, garde de remblai sur le couloir de voie).
// Implémente GroundSource + CameraGround (via GroundRouter).

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

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

/** smootherstep 0→1 (dérivée nulle aux deux bouts). */
function sstep(t: number): number {
  const k = clamp01(t);
  return k * k * k * (k * (k * 6 - 15) + 10);
}

/** Smooth max polynomial (le plateau GAGNE sur le champ sans arête dure). */
function smax(a: number, b: number, k: number): number {
  const h = clamp01(0.5 + (0.5 * (a - b)) / k);
  return a * h + b * (1 - h) + k * h * (1 - h);
}

/** Bruit de valeur 2D minimal (même recette que HeightField.ValueNoise). */
class SnowNoise {
  private readonly perm: Uint8Array;
  constructor(seed: number) {
    const rand = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j]!, p[i]!];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }
  private hash(ix: number, iz: number): number {
    return this.perm[(this.perm[(ix & 255)]! + iz) & 255]! / 255;
  }
  sample(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fz = z - iz;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = this.hash(ix, iz);
    const b = this.hash(ix + 1, iz);
    const c = this.hash(ix, iz + 1);
    const d = this.hash(ix + 1, iz + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  }
  fbm(x: number, z: number, octaves: number): number {
    let amp = 0.5;
    let freq = 1;
    let acc = 0;
    for (let o = 0; o < octaves; o++) {
      acc += (this.sample(x * freq, z * freq) - 0.5) * 2 * amp;
      amp *= 0.5;
      freq *= 2;
    }
    return acc;
  }
}

export class SnowField {
  readonly group = new Group();
  readonly mesh: Mesh;
  private readonly noise: SnowNoise;

  constructor(
    private readonly track: TrackSpec,
    pine: LoadedProp | null,
    boulder: LoadedProp | null,
    obstacles: ObstacleGrid | null,
    deadTree: LoadedProp | null = null,
    crystalBush: LoadedProp | null = null,
  ) {
    this.noise = new SnowNoise(SNOW.seed);

    // ---- Mesh du terrain (déplacé par LA MÊME fonction getHeight) ----
    const geometry = new PlaneGeometry(SNOW.halfX * 2, SNOW.halfZ * 2, SNOW.resX - 1, SNOW.resZ - 1);
    geometry.rotateX(-Math.PI / 2);
    const pos = geometry.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i);
      const lz = pos.getZ(i);
      pos.setY(i, this.getHeight(SNOW.center.x + lx, SNOW.center.z + lz));
    }
    geometry.computeVertexNormals();
    this.mesh = new Mesh(geometry, ToonMaterials.snow());
    this.mesh.position.set(SNOW.center.x, 0, SNOW.center.z);
    this.mesh.receiveShadow = true;
    this.group.add(this.mesh);

    // ---- Sapins + rochers enneigés (lisière Est de la toundra) ----
    const rand = mulberry32(SNOW.seed + 17);
    if (pine) {
      const albedo = pine.material.map ?? null;
      this.group.add(this.scatter(pine, ToonMaterials.snowFoliage(albedo, pine.height), rand, {
        count: SNOW.pineCount,
        scaleMin: SNOW.pineMinScale,
        scaleMax: SNOW.pineMaxScale,
        sinkFrac: 0.04,
        collisionR: 0.55,
        obstacles,
      }));
    }
    if (boulder) {
      const albedo = boulder.material.map ?? null;
      this.group.add(this.scatter(boulder, ToonMaterials.snowProp(albedo), rand, {
        count: SNOW.boulderCount,
        scaleMin: SNOW.boulderMinScale,
        scaleMax: SNOW.boulderMaxScale,
        sinkFrac: 0.3,
        collisionR: 0.8,
        obstacles,
        fullTundra: true, // congères-rochers dans TOUTE la plaine (densité M6.1)
      }));
    }
    // ---- M6 : arbres morts penchés + buissons de cristaux (toute la toundra) ----
    if (deadTree) {
      const albedo = deadTree.material.map ?? null;
      this.group.add(this.scatter(deadTree, ToonMaterials.snowProp(albedo), rand, {
        count: 34,
        scaleMin: 1.1,
        scaleMax: 2.6,
        sinkFrac: 0.05,
        collisionR: 0.4,
        obstacles,
        fullTundra: true,
        lean: 0.28, // penchés par le vent dominant (réf 2)
      }));
    }
    if (crystalBush) {
      const albedo = crystalBush.material.map ?? null;
      const mat = ToonMaterials.crystalBush(albedo, crystalBush.height);
      this.group.add(this.scatter(crystalBush, mat, rand, {
        count: 44,
        scaleMin: 0.6,
        scaleMax: 1.8,
        sinkFrac: 0.06,
        collisionR: 0.45,
        obstacles,
        fullTundra: true,
      }));
      // 2e vague SERRÉE le long de la côte gelée (les cristaux fleurissent au
      // bord de la glace — réf 2 : touffes givrées sur la ligne de rive)
      this.group.add(this.scatter(crystalBush, mat, rand, {
        count: 22,
        scaleMin: 0.5,
        scaleMax: 1.1,
        sinkFrac: 0.06,
        collisionR: 0,
        obstacles: null,
        coastBand: true,
      }));
    }
  }

  // ---- Requêtes de zone / SDF (partagées gameplay + matériau + minimap) ----

  /** SDF signé de la mer gelée (négatif à l'intérieur), côte irrégulière. */
  seaSdf(x: number, z: number): number {
    const dx = Math.abs(x - SEA_ICE.cx) - SEA_ICE.hx;
    const dz = Math.abs(z - SEA_ICE.cz) - SEA_ICE.hz;
    const ox = Math.max(dx, 0);
    const oz = Math.max(dz, 0);
    const box = Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0) - SEA_ICE.round;
    const wobble = (this.noise.sample(x * SEA_ICE.wobbleFreq, z * SEA_ICE.wobbleFreq) - 0.5) * 2 * SEA_ICE.wobbleAmp;
    return box + wobble;
  }

  /** Distance au centre de la mesa (canyon/plateau partagent ce repère). */
  private mesaDist(x: number, z: number): number {
    return Math.hypot(x - MESA.cx, z - MESA.cz);
  }

  /** Vrai sur le plateau de Snezhnograd (zone chaude : pas de froid, pas d'ennemis). */
  inCity(x: number, z: number): boolean {
    return this.mesaDist(x, z) < MESA.rTop;
  }

  /** Vrai dans la toundra (zone A) : blizzard, camps, froid. */
  inTundra(x: number, z: number): boolean {
    return this.contains(x, z) && z - SNOW.center.z < -15 && !this.inCity(x, z);
  }

  /** Type de surface au sol (glissance) : mer gelée, fond du canyon, crevasse. */
  getSurface(x: number, z: number): 'default' | 'ice' {
    if (this.seaSdf(x, z) < -1) return 'ice';
    const dm = this.mesaDist(x, z);
    if (dm > CANYON.rIn + 2 && dm < CANYON.rOut - 2 && this.getHeight(x, z) < CANYON.floorY + 0.6) return 'ice';
    if (distToSegment(x, z, CREVASSE.ax, CREVASSE.az, CREVASSE.bx, CREVASSE.bz) < CREVASSE.halfW - 1) return 'ice';
    return 'default';
  }

  // ---- GroundSource + CameraGround ----

  /** Vrai si (x,z) est dans l'emprise du terrain neige. */
  contains(x: number, z: number): boolean {
    return Math.abs(x - SNOW.center.x) <= SNOW.halfX && Math.abs(z - SNOW.center.z) <= SNOW.halfZ;
  }

  getHeight(x: number, z: number): number {
    // 1) Base toundra : fBm métrique, bruit ATTÉNUÉ près de la côte ET de la voie
    //    (sinon les creux du bruit raidissent berges et épaulements de remblai)
    const sea = this.seaSdf(x, z);
    const c = this.track.closest(x, z);
    const coast = clamp01((SEA_ICE.shoreW - sea) / (2 * SEA_ICE.shoreW)); // 0 loin → 1 dedans
    const nearTrack = 1 - sstep((c.d - SNOW.railFlatHalf) / 15);
    const damp = Math.max(0.85 * coast, 0.7 * nearTrack);
    const n = this.noise.fbm(x * SNOW.noiseFreqPerM, z * SNOW.noiseFreqPerM, SNOW.noiseOctaves);
    let h = SNOW.baseY + n * SNOW.noiseAmp * (1 - damp);

    // 2) Mer gelée : fondu champ→glace sur shoreW à l'intérieur de la rive
    if (sea < 0) {
      const w = sstep(-sea / SEA_ICE.shoreW);
      const drop = Math.min(h - SEA_ICE.iceY, SEA_ICE.capDrop);
      if (drop > 0) h -= drop * w;
    }

    // 3) Canyon annulaire (zone B) : abaissement à FORCE plafonnée
    const dm = this.mesaDist(x, z);
    if (dm > CANYON.rIn && dm < CANYON.rOut) {
      const wIn = sstep((dm - CANYON.rIn) / CANYON.feather);
      const wOut = sstep((CANYON.rOut - dm) / CANYON.feather);
      const wC = wIn * wOut;
      const drop = Math.min(h - CANYON.floorY, CANYON.maxDrop);
      if (drop > 0) h -= drop * wC;
    }

    // 4) Mesa de la ville : smax (le plateau GAGNE sur le canyon)
    if (dm < MESA.rBase) {
      const micro = (this.noise.sample(x * MESA.microFreq, z * MESA.microFreq) - 0.5) * 2 * MESA.microAmp;
      const t = sstep((dm - MESA.rTop) / (MESA.rBase - MESA.rTop));
      const target = (MESA.topY + micro) * (1 - t) + -10 * t;
      h = smax(h, target, MESA.smaxK);
    }

    // 5) Rues + place (AVANT le tertre : le raccord au palais se joue sur la pente du tertre)
    for (const st of CITY.streets) {
      const sd = distToSegment(x, z, st.ax, st.az, st.bx, st.bz);
      if (sd < st.halfW + st.feather) {
        const w = 1 - sstep((sd - st.halfW) / st.feather);
        h += (CITY.streetY - h) * w;
      }
    }
    const pd = Math.hypot(x - CITY.plaza.x, z - CITY.plaza.z);
    if (pd < CITY.plaza.r + 3) {
      const w = 1 - sstep((pd - (CITY.plaza.r - 3)) / 6);
      h += (CITY.streetY - h) * w;
    }

    // 6) Tertre du palais (ADDITIF au-dessus du plateau : pente ~14°, marchable)
    const pm = MESA.palaceMound;
    const pmd = Math.hypot(x - pm.x, z - pm.z);
    if (pmd < pm.r) h += pm.rise * (1 - sstep(pmd / pm.r));

    // 7) Mesas satellites + falaise Fatui : cônes smax (décor, hors canyon)
    for (const sat of MESA.satellites) {
      const d = Math.hypot(x - sat.x, z - sat.z);
      if (d < sat.r) h = smax(h, sat.peak * (1 - sstep(d / sat.r)), 2);
    }
    const fb = MESA.fatuiBump;
    const fbd = Math.hypot(x - fb.x, z - fb.z);
    if (fbd < fb.r) h = smax(h, fb.peak * (1 - sstep(fbd / fb.r)), 2);

    // 8) Arène du boss (zone A) : aplat doux près de l'épave
    const ar = WRECK.arena;
    const ad = Math.hypot(x - ar.x, z - ar.z);
    if (ad < ar.r + ar.feather) {
      const w = 1 - sstep((ad - (ar.r - ar.feather)) / (2 * ar.feather));
      h += (ar.y - h) * w;
    }

    // 8b) CREVASSE scintillante (M7) : gorge de glace — carve segment à force
    // plafonnée, parois ~65 % raides (grimpables), RAMPES d'accès aux 2 bouts
    // (le carve s'atténue sur rampT : l'entrée est une pente, pas un puits)
    const cv = CREVASSE;
    const cvLen2 = (cv.bx - cv.ax) ** 2 + (cv.bz - cv.az) ** 2;
    const cvT = clamp01(((x - cv.ax) * (cv.bx - cv.ax) + (z - cv.az) * (cv.bz - cv.az)) / cvLen2);
    const cvD = Math.hypot(x - (cv.ax + (cv.bx - cv.ax) * cvT), z - (cv.az + (cv.bz - cv.az) * cvT));
    if (cvD < cv.halfW + cv.wallFeather) {
      const wall = 1 - sstep((cvD - (cv.halfW - 1)) / cv.wallFeather);
      // Rampes LINÉAIRES (une smoothstep culmine à 1,875× la pente moyenne)
      const endRamp = Math.min(cvT / cv.rampT, (1 - cvT) / cv.rampT, 1);
      const drop = Math.min(h - cv.floorY, cv.maxCarve);
      if (drop > 0) h -= drop * wall * endRamp;
    }

    // 9) Rebord périphérique fermé (4 côtés), plus haut côté ville (lerp sur Z)
    const edgeD = Math.min(
      SNOW.halfX - Math.abs(x - SNOW.center.x),
      SNOW.halfZ - Math.abs(z - SNOW.center.z),
    );
    const rt = sstep(1 - edgeD / SNOW.rimBand);
    const rise = SNOW.rimRise
      + (SNOW.rimRiseNight - SNOW.rimRise) * sstep((z - SNOW.rimNightZLo) / (SNOW.rimNightZHi - SNOW.rimNightZLo));
    h += rt * rise * (1 + this.noise.sample(x * 0.08, z * 0.08) * 0.5);

    // 9b) BELVÉDÈRE du Nord (M7) : sommet aplani à topY — APRÈS le rim (le
    // satellite (62,335) est dans la bande du rempart : un aplat avant le rim
    // se faisait re-soulever à 73°). Cœur r PARFAITEMENT plat, fondu au-delà.
    const bv = BELVEDERE;
    const bd = Math.hypot(x - bv.x, z - bv.z);
    if (bd < bv.r + bv.feather) {
      const w = 1 - sstep((bd - bv.r) / bv.feather);
      h += (bv.topY - h) * w;
    }

    // 10) Couloir de la voie — GARDE DE REMBLAI : au-delà de bedFillHi de levée,
    //     le terrain n'est PLUS tiré vers le rail (le viaduc porte la voie).
    //     La coupe (h > railY : tranchée d'arrivée en gare) reste inconditionnelle.
    const k = 1 - clamp01((c.d - SNOW.railFlatHalf) / SNOW.railFlatFeather);
    let w = k * k * (3 - 2 * k);
    const railY = this.track.railY(c.s);
    const lift = railY - h;
    // La garde ne s'active QUE sur la rampe/viaduc (railY > tunnelY+1) : dans la
    // plaine, le remblai de gare reste inconditionnel comme en M5
    if (lift > 0 && railY > RAIL.tunnelY + 1) {
      w *= 1 - sstep((lift - SNOW.bedFillLo) / (SNOW.bedFillHi - SNOW.bedFillLo));
    }
    return h + (railY - h) * w;
  }

  getNormal(x: number, z: number, out: Vector3): Vector3 {
    const e = 0.9;
    const hL = this.getHeight(x - e, z);
    const hR = this.getHeight(x + e, z);
    const hD = this.getHeight(x, z - e);
    const hU = this.getHeight(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  getSlopeDeg(x: number, z: number): number {
    this.getNormal(x, z, _n);
    return (Math.acos(Math.min(Math.max(_n.y, -1), 1)) * 180) / Math.PI;
  }

  inBounds(x: number, z: number): boolean {
    return Math.abs(x - SNOW.center.x) <= SNOW.halfX - 1.5 && Math.abs(z - SNOW.center.z) <= SNOW.halfZ - 1.5;
  }

  // ---- Semis ----

  private scatter(
    prop: LoadedProp,
    material: LoadedProp['material'],
    rand: () => number,
    opts: {
      count: number;
      scaleMin: number;
      scaleMax: number;
      sinkFrac: number;
      collisionR: number;
      obstacles: ObstacleGrid | null;
      /** true = toute la toundra (mer exclue par SDF) ; false = lisière Est. */
      fullTundra?: boolean;
      /** true = bande côtière serrée (sdf mer ∈ [1,8]) — cristaux de rive. */
      coastBand?: boolean;
      /** Inclinaison max (rad) sous le vent dominant — arbres morts (réf 2). */
      lean?: number;
    },
  ): InstancedMesh {
    const placements: { x: number; y: number; z: number; yaw: number; s: number }[] = [];
    let attempts = 0;
    while (placements.length < opts.count && attempts < opts.count * 16) {
      attempts++;
      // Lisière Est par défaut ; les espèces M6 se sèment dans toute la toundra
      const x = opts.fullTundra || opts.coastBand
        ? SNOW.center.x + (rand() * 2 - 1) * (SNOW.halfX - 10)
        : SNOW.center.x + (0.1 + rand() * 0.85) * (SNOW.halfX - 8);
      const z = SNOW.center.z - SNOW.halfZ + 10 + rand() * 140;
      if (this.track.trackDistance(x, z) < SNOW.pineClearRail) continue;
      if (this.getSlopeDeg(x, z) > 34) continue;
      const sdf = this.seaSdf(x, z);
      if (opts.coastBand) {
        if (sdf < 1 || sdf > 8) continue; // uniquement la ligne de rive
      } else if (sdf < 4) continue;
      if (Math.hypot(x - RAIL.stationSnow.x, z - RAIL.stationSnow.z) < 10) continue;
      if (Math.hypot(x - WRECK.arena.x, z - WRECK.arena.z) < WRECK.arena.r + 8) continue;
      if (Math.hypot(x - WRECK.x, z - WRECK.z) < 12) continue;
      if (distToSegment(x, z, CREVASSE.ax, CREVASSE.az, CREVASSE.bx, CREVASSE.bz) < CREVASSE.halfW + CREVASSE.wallFeather + 2) continue;
      let tooClose = false;
      for (const p of placements) {
        if (Math.hypot(p.x - x, p.z - z) < 5) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      const s = opts.scaleMin + rand() * (opts.scaleMax - opts.scaleMin);
      opts.obstacles?.add({ x, z, r: opts.collisionR * s });
      placements.push({
        x,
        y: this.getHeight(x, z) - prop.height * s * opts.sinkFrac,
        z,
        yaw: rand() * Math.PI * 2,
        s,
      });
    }

    const mesh = new InstancedMesh(prop.geometry, material, Math.max(placements.length, 1));
    const m = new Matrix4();
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    const scale = new Vector3();
    const lean = new Quaternion();
    const windAxis = new Vector3(0, 0, 1); // vent dominant d'ouest → penchés vers +X
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]!;
      q.setFromAxisAngle(up, p.yaw);
      if (opts.lean) {
        lean.setFromAxisAngle(windAxis, -opts.lean * (0.55 + 0.45 * ((i * 37) % 10) / 10));
        q.premultiply(lean);
      }
      scale.set(p.s, p.s, p.s);
      m.compose(_pos.set(p.x, p.y, p.z), q, scale);
      mesh.setMatrixAt(i, m);
    }
    mesh.count = placements.length;
    mesh.frustumCulled = false; // loin du frustum de boot : doit compiler au warmup
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.name = 'snow-props';
    return mesh;
  }
}

/** Distance XZ d'un point à un segment. */
function distToSegment(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const abx = bx - ax;
  const abz = bz - az;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 0 ? clamp01(((x - ax) * abx + (z - az) * abz) / len2) : 0;
  return Math.hypot(x - (ax + abx * t), z - (az + abz * t));
}

const _n = new Vector3();
const _pos = new Vector3();
