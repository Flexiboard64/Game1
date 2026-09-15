import { Vector3 } from 'three/webgpu';
import { CAIRN_KNOLL, CARVE_GUARD, LIP, MOUNTAIN, RAIL, TERRACE, TERRAIN, TROUGH, WATER } from '../config';

// Carte « Vallée en gradins » (M3) : deux étages séparés par une ligne de falaise
// en arc, bassin amont perché (étanchéité STRUCTURELLE par plancher smax), cascade
// perçant l'arc, lac de réception, rivière → marais. Le mesh du terrain ET le
// contrôleur échantillonnent cette même grille : concordance exacte par construction.
// Composition validée par simulation numérique (10/10 gates) puis contre-vérifiée
// (ray-marching de ligne de vue, flood-fill d'étanchéité) — cf. journal M3.

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

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function clamp01(t: number): number {
  return Math.min(Math.max(t, 0), 1);
}

/** min lissé polynomial (raccord C1 sur k) — suit le plus bas des deux. */
function smin(a: number, b: number, k: number): number {
  const hb = clamp01(0.5 + (0.5 * (b - a)) / k);
  return b + (a - b) * hb - k * hb * (1 - hb);
}

/** max lissé polynomial — suit le plus haut des deux (plancher du gradin). */
function smax(a: number, b: number, k: number): number {
  const hb = clamp01(0.5 + (0.5 * (a - b)) / k);
  return b + (a - b) * hb + k * hb * (1 - hb);
}

class ValueNoise {
  private readonly grid: Float32Array;
  private readonly n: number;

  constructor(seed: number, gridSize = 64) {
    this.n = gridSize;
    const rand = mulberry32(seed);
    this.grid = new Float32Array(gridSize * gridSize);
    for (let i = 0; i < this.grid.length; i++) this.grid[i] = rand();
  }

  private at(ix: number, iz: number): number {
    const n = this.n;
    return this.grid[((iz % n + n) % n) * n + ((ix % n + n) % n)]!;
  }

  /** Bruit 2D lissé dans [0,1], période gridSize. */
  sample(x: number, z: number): number {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const fx = smootherstep(x - ix);
    const fz = smootherstep(z - iz);
    const a = this.at(ix, iz);
    const b = this.at(ix + 1, iz);
    const c = this.at(ix, iz + 1);
    const d = this.at(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  fbm(x: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

interface Knot {
  x: number;
  z: number;
  w: number;
}

interface Beach {
  x: number;
  z: number;
  r: number;
}

/** Distance signée à une chaîne de capsules (w interpolée le long des segments). */
function capsuleChainSdf(knots: readonly Knot[], x: number, z: number): number {
  let d = Infinity;
  for (let s = 1; s < knots.length; s++) {
    const a = knots[s - 1]!;
    const b = knots[s]!;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? clamp01(((x - a.x) * abx + (z - a.z) * abz) / len2) : 0;
    const seg = Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)) - (a.w + (b.w - a.w) * t);
    if (seg < d) d = seg;
  }
  return d;
}

/** Poids de plage en PLATEAU : pleine force jusqu'à 40 % du rayon (l'ancienne
 *  formule retombait à 0,5 sur la ligne de rive → gué à 20° au lieu de 13°). */
function beachWeight(beaches: readonly Beach[], x: number, z: number): number {
  let w = 0;
  for (const b of beaches) {
    const t = 1 - Math.hypot(x - b.x, z - b.z) / b.r;
    if (t > 0) w = Math.max(w, smootherstep(clamp01(t / WATER.beachPlateau)));
  }
  return w;
}

export class HeightField {
  readonly size: number;
  readonly resolution: number;
  private readonly heights: Float32Array;
  private readonly cell: number;
  /** Bruit basse fréquence réutilisé par la splatmap (sentes, variation macro). */
  readonly detailNoise: ValueNoise;
  /** SDF de rive des deux plans d'eau (négatif = sous l'eau), grille des hauteurs. */
  private readonly sdfLower: Float32Array;
  private readonly sdfUpper: Float32Array;
  /** Diagnostic : rabotage max des carves hors corridors d'eau (gate 7). */
  readonly carveMaxShaveOutside: number;

  constructor(
    size = TERRAIN.size,
    resolution = TERRAIN.resolution,
    seed = TERRAIN.seed,
    maxHeight = TERRAIN.maxHeight,
  ) {
    this.size = size;
    this.resolution = resolution;
    this.cell = size / (resolution - 1);
    this.heights = new Float32Array(resolution * resolution);
    this.sdfLower = new Float32Array(resolution * resolution);
    this.sdfUpper = new Float32Array(resolution * resolution);

    const base = new ValueNoise(seed);
    const warp = new ValueNoise(seed + 202);
    this.detailNoise = new ValueNoise(seed + 101);
    const half = size / 2;

    const floorUpper = WATER.levelLower + TERRACE.floorAbove; // plancher absolu étage haut

    // Chaînes de capsules des deux systèmes (jonctions vers les cercles incluses)
    const lowerChain: Knot[] = [
      ...WATER.lower.riverKnots,
      { x: WATER.lower.lakeCenter.x, z: WATER.lower.lakeCenter.z, w: WATER.lower.lakeJoinW },
    ];
    const upperFeeder: Knot[] = [
      ...WATER.upper.feederKnots,
      { x: WATER.upper.basinCenter.x, z: WATER.upper.basinCenter.z, w: WATER.upper.basinJoinW },
    ];
    const upperChannel: Knot[] = [
      { x: WATER.upper.basinCenter.x, z: WATER.upper.basinCenter.z, w: WATER.upper.channelKnots[0]!.w },
      ...WATER.upper.channelKnots,
    ];

    const lowerRawSdf = (x: number, z: number): number => {
      const lake = Math.hypot(x - WATER.lower.lakeCenter.x, z - WATER.lower.lakeCenter.z) - WATER.lower.lakeRadius;
      return Math.min(lake, capsuleChainSdf(lowerChain, x, z));
    };
    const upperRawSdf = (x: number, z: number): number => {
      const basin = Math.hypot(x - WATER.upper.basinCenter.x, z - WATER.upper.basinCenter.z) - WATER.upper.basinRadius;
      return Math.min(basin, capsuleChainSdf(upperFeeder, x, z), capsuleChainSdf(upperChannel, x, z));
    };

    const dArcAt = (x: number, z: number): number =>
      Math.hypot(x - TERRACE.cx, z - TERRACE.cz) - TERRACE.radius;

    // Largeur de rampe du gradin selon l'angle sur l'arc (secteurs falaise/accès)
    const sectorWidth = (x: number, z: number): number => {
      const theta = (Math.atan2(z - TERRACE.cz, x - TERRACE.cx) * 180) / Math.PI;
      const angDist = (c: number): number => {
        let d = Math.abs(theta - c) % 360;
        if (d > 180) d = 360 - d;
        return d;
      };
      const sectorW = (s: { centerDeg: number; halfDeg: number; blendDeg: number }): number =>
        1 - smootherstep(clamp01((angDist(s.centerDeg) - s.halfDeg) / s.blendDeg));
      const cliff = sectorW(TERRACE.cliffSector);
      const access = sectorW(TERRACE.accessSector);
      return TERRACE.wDefault
        + (TERRACE.wCliff - TERRACE.wDefault) * cliff
        + (TERRACE.wAccess - TERRACE.wDefault) * access;
    };

    const rimMaskAt = (x: number, z: number): number => {
      const edge = Math.max(Math.abs(x), Math.abs(z)) / half;
      return 1 - smootherstep(clamp01((edge - TERRAIN.carveRimMask.start) / TERRAIN.carveRimMask.feather));
    };

    // ---- Passes 1-4 : base warpée + rim, gradin, knoll du cairn, auge alluviale ----
    for (let iz = 0; iz < resolution; iz++) {
      for (let ix = 0; ix < resolution; ix++) {
        const x = ix * this.cell - half;
        const z = iz * this.cell - half;
        const i = iz * resolution + ix;

        // 1. Base fBm à domaine warpé (gain×lacunarité < 1 : houle ample sans taupinières)
        const nx = (x / size) * TERRAIN.baseFreq;
        const nz = (z / size) * TERRAIN.baseFreq;
        const wx = (warp.fbm(nx + 5.2, nz + 1.3, TERRAIN.warpOctaves) - 0.5) * 2 * TERRAIN.warpAmp;
        const wz = (warp.fbm(nx + 9.1, nz + 4.7, TERRAIN.warpOctaves) - 0.5) * 2 * TERRAIN.warpAmp;
        let h = base.fbm(nx + wx, nz + wz, TERRAIN.baseOctaves, TERRAIN.baseLacunarity, TERRAIN.baseGain) * maxHeight;

        // + lèvre : les bords remontent pour fermer la vallée
        const edge = Math.max(Math.abs(x), Math.abs(z)) / half;
        h += smootherstep(clamp01((edge - TERRAIN.rimStart) / (0.98 - TERRAIN.rimStart))) * TERRAIN.rimHeight;

        // 2. Gradin : l'étage haut monte au plancher absolu (étanchéité structurelle)
        const dArc = dArcAt(x, z);
        if (dArc > 0) {
          const t = smootherstep(clamp01(dArc / sectorWidth(x, z)));
          if (t > 0) h += (smax(h, floorUpper, TERRACE.smaxK) - h) * t;
        }

        // 3. Knoll du cairn (belvédère au-dessus du bassin et de la chute)
        const dKnoll = Math.hypot(x - CAIRN_KNOLL.x, z - CAIRN_KNOLL.z);
        if (dKnoll < CAIRN_KNOLL.r) {
          h += CAIRN_KNOLL.h * smootherstep(1 - dKnoll / CAIRN_KNOLL.r);
        }

        // 3b. Montagne « Dent du Sud » (M4) : cône terrassé smax — risers
        // grimpables (55-75°) séparés par des vires de repos, plateau sommital.
        // Placée AVANT l'auge (l'eau garde le dernier mot sur sa frange nord)
        // et AVANT le snapshot preHeights : la garde de pente des carves voit
        // ses flancs raides et ne les rabotera jamais.
        const dMtnRaw = Math.hypot(x - MOUNTAIN.cx, z - MOUNTAIN.cz);
        if (dMtnRaw < MOUNTAIN.radius + MOUNTAIN.wobbleAmp) {
          const wob = (this.detailNoise.fbm(
            (x / size) * MOUNTAIN.wobbleFreq + 31.4,
            (z / size) * MOUNTAIN.wobbleFreq + 31.4,
            2,
          ) - 0.5) * 2 * MOUNTAIN.wobbleAmp;
          const dMtn = Math.max(0, dMtnRaw + wob);
          if (dMtn < MOUNTAIN.radius) {
            let rise = 0;
            for (const st of MOUNTAIN.steps) {
              if (dMtn <= st.to) { rise = st.rise; continue; }
              if (dMtn < st.from) rise += (st.rise - rise) * smootherstep((st.from - dMtn) / (st.from - st.to));
            }
            if (dMtn < MOUNTAIN.steps[MOUNTAIN.steps.length - 1]!.to) {
              rise += (this.detailNoise.fbm(
                (x / size) * MOUNTAIN.summitNoiseFreq + 44.2,
                (z / size) * MOUNTAIN.summitNoiseFreq + 44.2,
                2,
              ) - 0.5) * 2 * MOUNTAIN.summitNoiseAmp;
            }
            const env = smootherstep(clamp01((MOUNTAIN.radius - dMtn) / MOUNTAIN.envelopeBand));
            h += (smax(h, floorUpper + rise, MOUNTAIN.smaxK) - h) * env;
          }
        }

        // 4. Auge alluviale AUTORÉE (pré-carve) : le val du système bas existe
        // quel que soit le seed → la carve n'aura presque rien à raboter
        const dRaw = lowerRawSdf(x, z);
        if (dRaw < TROUGH.width) {
          const beachW = beachWeight(WATER.lower.beaches, x, z);
          const micro = this.detailNoise.fbm(
            (x * TROUGH.microFreq) / size + 20,
            (z * TROUGH.microFreq) / size + 20,
            2,
          ) * TROUGH.microAmp * (1 - beachW);
          const target = WATER.levelLower + TROUGH.floorAbove + micro;
          const wTrough = smootherstep(clamp01(1 - dRaw / TROUGH.width));
          const arcMaskLow = 1 - smootherstep(clamp01((dArc + 3) / 6));
          const g = wTrough * arcMaskLow * rimMaskAt(x, z);
          if (g > 0) h += (smin(h, target, TROUGH.smoothK) - h) * g;
        }

        this.heights[i] = h;
      }
    }

    // ---- Passe 5 : aplat de spawn en knoll doux (l'œil domine le lac → vue chute) ----
    const spawnH0 = this.rawAt(Math.floor(resolution / 2), Math.floor(resolution / 2));
    const flatR = TERRAIN.spawnFlatRadius * 1.6;
    for (let iz = 0; iz < resolution; iz++) {
      for (let ix = 0; ix < resolution; ix++) {
        const x = ix * this.cell - half;
        const z = iz * this.cell - half;
        const r = Math.hypot(x, z);
        if (r < flatR) {
          const target = spawnH0 + TERRAIN.spawnKnollH * (1 - smootherstep(clamp01(r / 26)));
          const i = iz * resolution + ix;
          this.heights[i] = target + (this.heights[i]! - target) * smootherstep(clamp01(r / flatR));
        }
      }
    }

    // ---- Passe 6 : SDF des deux systèmes (wobble atténué sous les plages) ----
    for (let iz = 0; iz < resolution; iz++) {
      for (let ix = 0; ix < resolution; ix++) {
        const x = ix * this.cell - half;
        const z = iz * this.cell - half;
        const i = iz * resolution + ix;

        const beachL = beachWeight(WATER.lower.beaches, x, z);
        const wobL = (this.detailNoise.fbm(
          (x / size) * WATER.shoreWobbleFreq + WATER.lower.wobbleOffset,
          (z / size) * WATER.shoreWobbleFreq + WATER.lower.wobbleOffset,
          2,
        ) - 0.5) * 2 * WATER.lower.wobbleAmp * (1 - 0.7 * beachL);
        this.sdfLower[i] = lowerRawSdf(x, z) + wobL;

        const beachU = beachWeight(WATER.upper.beaches, x, z);
        const wobU = (this.detailNoise.fbm(
          (x / size) * WATER.shoreWobbleFreq + WATER.upper.wobbleOffset,
          (z / size) * WATER.shoreWobbleFreq + WATER.upper.wobbleOffset,
          2,
        ) - 0.5) * 2 * WATER.upper.wobbleAmp * (1 - 0.7 * beachU);
        this.sdfUpper[i] = upperRawSdf(x, z) + wobU;
      }
    }

    // ---- Passes 7-8 : carves gardés (pente PRÉ-carve, capFade, exemption de lèvre) ----
    // Leçon M2 : un cône smin sans garde rase les remparts. Triple garde + capFade,
    // et on plafonne la FORCE du carve, jamais sa CIBLE (piège prouvé en simulation).
    const preHeights = this.heights.slice();
    const slopePre = (x: number, z: number): number => {
      const e = this.cell;
      const hL = this.bilinear(preHeights, x - e, z);
      const hR = this.bilinear(preHeights, x + e, z);
      const hD = this.bilinear(preHeights, x, z - e);
      const hU = this.bilinear(preHeights, x, z + e);
      const n = _slopeTmp.set(hL - hR, 2 * e, hD - hU).normalize();
      return (Math.acos(Math.min(Math.max(n.y, -1), 1)) * 180) / Math.PI;
    };
    const tanBeach = Math.tan((WATER.beachSlopeDeg * Math.PI) / 180);
    let maxShaveOutside = 0;

    const carve = (
      sdf: Float32Array,
      level: number,
      bankDeg: number,
      beaches: readonly Beach[],
      upperStage: boolean,
    ): void => {
      const tanBank = Math.tan((bankDeg * Math.PI) / 180);
      for (let iz = 0; iz < resolution; iz++) {
        for (let ix = 0; ix < resolution; ix++) {
          const i = iz * resolution + ix;
          const d = sdf[i]!;
          if (d > 50) continue; // le cône ne peut plus rien raboter si loin
          const x = ix * this.cell - half;
          const z = iz * this.cell - half;

          const beachW = beachWeight(beaches, x, z);
          const bankTan = tanBank + (tanBeach - tanBank) * beachW;
          const depth = Math.min(WATER.maxDepth, WATER.shoreDepth + Math.max(-d, 0) * WATER.bedSlope);
          const target = level - depth + Math.max(d, 0) * bankTan;

          const h = this.heights[i]!;
          const cut = Math.max(0, h - target);
          if (cut <= 0) continue;

          const garde = 1 - smootherstep(clamp01((slopePre(x, z) - CARVE_GUARD.slopeLo) / (CARVE_GUARD.slopeHi - CARVE_GUARD.slopeLo)));
          const capFade = 1 - smootherstep(clamp01((cut - 2) / 8)); // jamais de rabot > ~10 m
          const dArc = dArcAt(x, z);
          const arcMask = upperStage
            ? smootherstep(clamp01((dArc + 6) / 6))       // jamais côté étage bas
            : 1 - smootherstep(clamp01((dArc + 3) / 6));  // jamais côté étage haut ni la face
          let g = garde * capFade;
          if (upperStage) {
            // L'encoche du déversoir DOIT percer la crête : exemption locale de garde
            const exempt = smootherstep(clamp01(1 - Math.hypot(x - LIP.x, z - LIP.z) / LIP.notchExemptR));
            g = Math.max(g, exempt);
          }
          g *= arcMask * rimMaskAt(x, z);
          if (g <= 0) continue;

          const smined = smin(target, h, WATER.smoothK);
          const hNew = h + (smined - h) * g;
          this.heights[i] = hNew;

          // Diagnostic gate 7 : rabotage hors corridors d'eau et zone de cascade
          const distLip = Math.hypot(x - LIP.x, z - LIP.z);
          if (d > 10 && distLip > 25) {
            const shave = h - hNew;
            if (shave > maxShaveOutside) maxShaveOutside = shave;
          }
        }
      }
    };

    carve(this.sdfUpper, WATER.levelUpper, WATER.upper.bankSlopeDeg, WATER.upper.beaches, true);
    carve(this.sdfLower, WATER.levelLower, WATER.lower.bankSlopeDeg, WATER.lower.beaches, false);
    this.carveMaxShaveOutside = maxShaveOutside;
  }

  private rawAt(ix: number, iz: number): number {
    const r = this.resolution;
    const cx = Math.min(Math.max(ix, 0), r - 1);
    const cz = Math.min(Math.max(iz, 0), r - 1);
    return this.heights[cz * r + cx]!;
  }

  /** Lecture bilinéaire clampée d'une grille alignée sur celle des hauteurs. */
  private bilinear(arr: Float32Array, x: number, z: number): number {
    const r = this.resolution;
    const half = this.size / 2;
    const gx = (x + half) / this.cell;
    const gz = (z + half) / this.cell;
    const ix = Math.floor(gx);
    const iz = Math.floor(gz);
    const fx = gx - ix;
    const fz = gz - iz;
    const at = (cx: number, cz: number): number =>
      arr[Math.min(Math.max(cz, 0), r - 1) * r + Math.min(Math.max(cx, 0), r - 1)]!;
    const a = at(ix, iz);
    const b = at(ix + 1, iz);
    const c = at(ix, iz + 1);
    const d = at(ix + 1, iz + 1);
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  }

  /** Hauteur bilinéaire en coordonnées monde (x,z centrés sur 0). */
  getHeight(x: number, z: number): number {
    return this.bilinear(this.heights, x, z);
  }

  /** Distance signée à la rive la plus proche, tous plans d'eau confondus. */
  getWaterSdf(x: number, z: number): number {
    return Math.min(this.bilinear(this.sdfLower, x, z), this.bilinear(this.sdfUpper, x, z));
  }

  /** Distance signée à la rive du plan d'eau BAS (lac + rivière + marais). */
  getLowerSdf(x: number, z: number): number {
    return this.bilinear(this.sdfLower, x, z);
  }

  /** Distance signée à la rive du plan d'eau HAUT (bassin amont + déversoir). */
  getUpperSdf(x: number, z: number): number {
    return this.bilinear(this.sdfUpper, x, z);
  }

  /**
   * Niveau d'eau LOCAL — clamp caméra et anneau de wading uniquement.
   * Comparaison gardée : le seuil évite de classer la prairie lointaine au
   * niveau haut (la comparaison naïve sdfU<sdfL le faisait — trouvé au jugement).
   */
  levelAt(x: number, z: number): number {
    // Le corps BAS a priorité dès qu'on est dedans : les capsules du déversoir
    // amont descendent jusqu'à (41,−41), soit 7 m EN AVAL de l'arc, et
    // recouvrent le lobe NE du lac (8,8 % de sa surface classée au niveau haut
    // sans cette garde → saut de caméra de 9,2 m et anneau de wading en plein ciel)
    if (this.bilinear(this.sdfLower, x, z) < 0) return WATER.levelLower;
    return this.bilinear(this.sdfUpper, x, z) < WATER.levelAtUpperSdf
      && this.getHeight(x, z) > WATER.levelUpper - WATER.maxDepth - WATER.levelAtFloorMargin
      ? WATER.levelUpper
      : WATER.levelLower;
  }

  getNormal(x: number, z: number, out = new Vector3()): Vector3 {
    const e = this.cell;
    const hL = this.getHeight(x - e, z);
    const hR = this.getHeight(x + e, z);
    const hD = this.getHeight(x, z - e);
    const hU = this.getHeight(x, z + e);
    return out.set(hL - hR, 2 * e, hD - hU).normalize();
  }

  getSlopeDeg(x: number, z: number): number {
    const n = this.getNormal(x, z, _slopeTmp);
    return (Math.acos(Math.min(Math.max(n.y, -1), 1)) * 180) / Math.PI;
  }

  /** Bornes de marche du monde (GroundSource) — ex-clamp en dur du contrôleur. */
  inBounds(x: number, z: number): boolean {
    const half = this.size / 2 - 1.5;
    return Math.abs(x) <= half && Math.abs(z) <= half;
  }

  /**
   * Passe d'ASSISE DES RAILS (M5) — appelée par main.ts APRÈS le constructeur
   * (le profil de la voie est lissé depuis le terrain final) et AVANT Terrain
   * (le mesh doit refléter l'assise). Hors de carve() : le gate carveShave
   * reste structurellement intact. Blend du terrain vers le profil du rail sur
   * un fond plat bedHalfWidth + feather, avec exemption des berges au pont
   * (poids nul si |lowerSdf| < bridgeWaterSdfLo → gate bankMax protégé) et
   * uniquement sur la portion AVANT le portail (le tube est enterré, aucune
   * tranchée dans le rempart).
   */
  applyRailBed(track: {
    closest(x: number, z: number): { d: number; s: number };
    railY(s: number): number;
    sPortal: number;
  }): void {
    const reach = RAIL.bedHalfWidth + RAIL.bedFeather;
    const half = this.size / 2;
    for (let iz = 0; iz < this.resolution; iz++) {
      const z = -half + iz * this.cell;
      for (let ix = 0; ix < this.resolution; ix++) {
        const x = -half + ix * this.cell;
        const c = track.closest(x, z);
        if (c.d >= reach || c.s >= track.sPortal - 1) continue;
        const sdfLow = Math.abs(this.bilinear(this.sdfLower, x, z));
        if (sdfLow <= RAIL.bridgeWaterSdfLo) continue; // berges/pont : intacts
        const waterW = Math.min(
          Math.max((sdfLow - RAIL.bridgeWaterSdfLo) / (RAIL.bridgeWaterSdfHi - RAIL.bridgeWaterSdfLo), 0),
          1,
        );
        const k = 1 - Math.min(Math.max((c.d - RAIL.bedHalfWidth) / RAIL.bedFeather, 0), 1);
        const w = k * k * (3 - 2 * k) * waterW;
        const target = Math.max(track.railY(c.s), WATER.levelLower + 0.6);
        const idx = iz * this.resolution + ix;
        this.heights[idx] = this.heights[idx]! + (target - this.heights[idx]!) * w;
      }
    }

    // ---- Tertre du portail + TRANCHÉE du bore : le rim ne monte que de ~1 m à
    // l'entrée du tube — la colline d'entrée enterre le caisson… mais un tertre
    // plein REMPLISSAIT la bouche d'une rampe de terrain (retour utilisateur :
    // « pas de trou dans la montagne »). Le long de l'AXE, le terrain est donc
    // COUPÉ au niveau des rails (vrai trou, tunnel marchable à pied) ; le
    // tertre ne monte que sur les flancs, et les dalles du tube habillent la
    // saignée. Aucune interaction avec l'assise (min/max purs) ni les gardes.
    const moundReach = RAIL.tubeRadius + 12;
    // Demi-largeur de la tranchée : 0,9 m PLUS LARGE que les murs de maçonnerie
    // du tube (±3,3) — la paroi de terrain discrétisée (cellule 0,68 m) zigzague
    // d'une cellule et repasserait devant la maçonnerie avec une marge moindre
    const boreHalf = 4.2;
    for (let iz = 0; iz < this.resolution; iz++) {
      const z = -half + iz * this.cell;
      for (let ix = 0; ix < this.resolution; ix++) {
        const x = -half + ix * this.cell;
        const c = track.closest(x, z);
        if (c.d >= moundReach) continue;
        if (c.s < track.sPortal - 2 || c.s > track.sPortal + 60) continue;
        const idx = iz * this.resolution + ix;
        const h = this.heights[idx]!;
        if (c.d < boreHalf) {
          // Tranchée : plancher du bore au niveau des rails, jamais au-dessus
          this.heights[idx] = Math.min(h, track.railY(c.s) - 0.12);
          continue;
        }
        if (c.s < track.sPortal + 1 || c.s > track.sPortal + 40) continue;
        // Tertre latéral : montée derrière la façade, pleine hauteur dès d≈6
        const along = Math.min(Math.max((c.s - (track.sPortal + 1)) / 7, 0), 1);
        const lat = Math.min(Math.max((c.d - boreHalf) / 2.4, 0), 1);
        const latOut = 1 - Math.min(Math.max((c.d - (RAIL.tubeRadius + 2)) / 6, 0), 1);
        const w = along * along * (3 - 2 * along) * (lat * lat * (3 - 2 * lat)) * (latOut * latOut * (3 - 2 * latOut));
        const target = track.railY(c.s) + RAIL.tubeRadius + RAIL.tubeWallDrop + 0.8;
        this.heights[idx] = Math.max(h, h + (target - h) * w);
      }
    }
  }

  /**
   * Cherche le point le plus haut dans un anneau autour du spawn — emplacement du cairn
   * de quête. Déterministe (grille + seed fixes). Sur la carte M3, le knoll autoré
   * (CAIRN_KNOLL) gagne : sans lui le pic élu serait un flanc de rempart inaccessible.
   */
  findQuestPeak(minR = 55, maxR = 105): Vector3 {
    let best = new Vector3(0, -Infinity, 0);
    const step = this.cell * 2;
    const half = this.size / 2;
    for (let z = -half; z <= half; z += step) {
      for (let x = -half; x <= half; x += step) {
        const r = Math.hypot(x, z);
        if (r < minR || r > maxR) continue;
        // Le sommet de la montagne (33 m) est dans l'anneau : sans cette
        // exclusion il volerait le pic de quête au knoll autoré (gate questPeak)
        if (Math.hypot(x - MOUNTAIN.cx, z - MOUNTAIN.cz) < MOUNTAIN.questExcludeR) continue;
        const h = this.getHeight(x, z);
        if (h > best.y) best = new Vector3(x, h, z);
      }
    }
    return best;
  }
}

const _slopeTmp = new Vector3();
