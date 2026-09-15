import { CatmullRomCurve3, Vector3 } from 'three/webgpu';
import { RAIL } from '../config';

// Spécification de la voie ferrée : courbe XZ (CatmullRom centripète sur les
// knots de config) échantillonnée en table s→pose au pas fixe, profil
// d'élévation (terrain lissé sur carte, constant du portail au heurtoir neige)
// et SDF XZ. Zéro dépendance interne — partagée par HeightField (assise),
// Terrain (splat ballast), les exclusions de semis, RailTrack et TrainSystem.

export interface TrackPose {
  x: number;
  y: number;
  z: number;
  /** Cap de la tangente (convention heading : 0 = +Z), DÉROULÉ (pas de wrap ±π). */
  yaw: number;
  /** Assiette de la ligne (visuel roues/bogies uniquement — les caisses restent yaw-only). */
  pitch: number;
}

export class TrackSpec {
  /** Longueur totale de la ligne (m). */
  readonly length: number;
  /** Abscisses curvilignes des lieux nommés. */
  readonly sValley: number;
  readonly sSnow: number;
  readonly sCity: number;
  readonly sPortal: number;
  readonly sTubeExit: number;

  private readonly step: number;
  private readonly xs: Float32Array;
  private readonly ys: Float32Array;
  private readonly zs: Float32Array;
  private readonly yaws: Float32Array;
  private readonly pitches: Float32Array;
  // Sous-échantillonnage pour le SDF/closest (segments ~2 m : les requêtes de
  // semis sont O(n) par appel, uniquement au boot)
  private readonly coarse: { x: number; z: number; s: number }[] = [];

  constructor(sampleHeight: (x: number, z: number) => number) {
    const pts = RAIL.knots.map((k) => new Vector3(k.x, 0, k.z));
    const curve = new CatmullRomCurve3(pts, false, 'centripetal');
    curve.arcLengthDivisions = 2000;
    const totalLen = curve.getLength();
    this.step = RAIL.sampleStep;
    const n = Math.ceil(totalLen / this.step) + 1;
    this.xs = new Float32Array(n);
    this.ys = new Float32Array(n);
    this.zs = new Float32Array(n);
    this.yaws = new Float32Array(n);
    this.pitches = new Float32Array(n);

    // ---- Échantillonnage XZ arc-length + yaw déroulé cumulativement ----
    const p = new Vector3();
    const t = new Vector3();
    let prevYaw = 0;
    for (let i = 0; i < n; i++) {
      const u = Math.min(i / (n - 1), 1);
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t);
      this.xs[i] = p.x;
      this.zs[i] = p.z;
      let yaw = Math.atan2(t.x, t.z);
      if (i > 0) {
        let d = yaw - (prevYaw % (2 * Math.PI));
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        yaw = prevYaw + d;
      }
      this.yaws[i] = yaw;
      prevYaw = yaw;
    }
    this.length = totalLen;

    // ---- Abscisses des lieux nommés (point de table le plus proche) ----
    const findS = (kx: number, kz: number): number => {
      let best = Infinity;
      let bestI = 0;
      for (let i = 0; i < n; i++) {
        const d = (this.xs[i]! - kx) ** 2 + (this.zs[i]! - kz) ** 2;
        if (d < best) {
          best = d;
          bestI = i;
        }
      }
      return bestI * this.step;
    };
    this.sValley = findS(RAIL.stationValley.x, RAIL.stationValley.z);
    this.sSnow = findS(RAIL.stationSnow.x, RAIL.stationSnow.z);
    this.sCity = findS(RAIL.stationCity.x, RAIL.stationCity.z);
    this.sPortal = findS(RAIL.portal.x, RAIL.portal.z);
    this.sTubeExit = findS(RAIL.tubeExit.x, RAIL.tubeExit.z);

    // ---- Profil d'élévation ----
    // 1) brut : terrain sur carte, tunnelY après le portail, puis rampe LINÉAIRE
    //    du viaduc vers cityY (≈3,9° — une smoothstep culminerait à 5,9° et
    //    serait hachée par le clamp : déficit ~2,5 m en gare, prouvé au plan)
    const raw = new Float32Array(n);
    const blendStart = this.sPortal - RAIL.tunnelBlend;
    const rampStart = this.sSnow + RAIL.rampFromSnow;
    const rampEnd = this.sCity - RAIL.cityFlat;
    for (let i = 0; i < n; i++) {
      const s = i * this.step;
      if (s >= this.sPortal) {
        if (s <= rampStart) {
          raw[i] = RAIL.tunnelY;
        } else if (s >= rampEnd) {
          raw[i] = RAIL.cityY;
        } else {
          const k = (s - rampStart) / (rampEnd - rampStart);
          raw[i] = RAIL.tunnelY + (RAIL.cityY - RAIL.tunnelY) * k;
        }
      } else {
        const h = sampleHeight(this.xs[i]!, this.zs[i]!);
        if (s <= blendStart) {
          raw[i] = h;
        } else {
          const k = (s - blendStart) / RAIL.tunnelBlend;
          const sm = k * k * (3 - 2 * k);
          raw[i] = h + (RAIL.tunnelY - h) * sm;
        }
      }
    }
    // 2) moyenne glissante (fenêtre smoothWin) — n'aplanit que la portion terrain
    const win = Math.max(1, Math.round(RAIL.smoothWin / this.step / 2));
    for (let i = 0; i < n; i++) {
      let acc = 0;
      let cnt = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) {
        acc += raw[j]!;
        cnt++;
      }
      this.ys[i] = acc / cnt;
    }
    // 3) clamp de pente bidirectionnel (maxGradeDeg)
    const maxDy = Math.tan((RAIL.maxGradeDeg * Math.PI) / 180) * this.step;
    for (let i = 1; i < n; i++) {
      const lo = this.ys[i - 1]! - maxDy;
      const hi = this.ys[i - 1]! + maxDy;
      this.ys[i] = Math.min(Math.max(this.ys[i]!, lo), hi);
    }
    for (let i = n - 2; i >= 0; i--) {
      const lo = this.ys[i + 1]! - maxDy;
      const hi = this.ys[i + 1]! + maxDy;
      this.ys[i] = Math.min(Math.max(this.ys[i]!, lo), hi);
    }
    // 4) pitch depuis le profil final (différence centrée)
    for (let i = 0; i < n; i++) {
      const a = this.ys[Math.max(0, i - 1)]!;
      const b = this.ys[Math.min(n - 1, i + 1)]!;
      const ds = this.step * (Math.min(n - 1, i + 1) - Math.max(0, i - 1));
      this.pitches[i] = ds > 0 ? Math.atan((b - a) / ds) : 0;
    }

    // ---- Polyligne grossière pour le SDF (segments ~2 m) ----
    const coarseEvery = Math.max(1, Math.round(2 / this.step));
    for (let i = 0; i < n; i += coarseEvery) {
      this.coarse.push({ x: this.xs[i]!, z: this.zs[i]!, s: i * this.step });
    }
    const last = n - 1;
    if ((last % coarseEvery) !== 0) {
      this.coarse.push({ x: this.xs[last]!, z: this.zs[last]!, s: last * this.step });
    }
  }

  /** Pose interpolée à l'abscisse s (clampée) — yaw continu par construction. */
  pose(s: number, out: TrackPose): TrackPose {
    const n = this.xs.length;
    const f = Math.min(Math.max(s / this.step, 0), n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    const t = f - i;
    out.x = this.xs[i]! + (this.xs[i + 1]! - this.xs[i]!) * t;
    out.y = this.ys[i]! + (this.ys[i + 1]! - this.ys[i]!) * t;
    out.z = this.zs[i]! + (this.zs[i + 1]! - this.zs[i]!) * t;
    out.yaw = this.yaws[i]! + (this.yaws[i + 1]! - this.yaws[i]!) * t;
    out.pitch = this.pitches[i]! + (this.pitches[i + 1]! - this.pitches[i]!) * t;
    return out;
  }

  /** Altitude du rail à l'abscisse s. */
  railY(s: number): number {
    const n = this.ys.length;
    const f = Math.min(Math.max(s / this.step, 0), n - 1);
    const i = Math.min(Math.floor(f), n - 2);
    return this.ys[i]! + (this.ys[i + 1]! - this.ys[i]!) * (f - i);
  }

  /** Distance XZ à l'axe de la voie + abscisse du point le plus proche. */
  closest(x: number, z: number): { d: number; s: number } {
    let best = Infinity;
    let bestS = 0;
    const c = this.coarse;
    for (let i = 1; i < c.length; i++) {
      const a = c[i - 1]!;
      const b = c[i]!;
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 0 ? Math.min(Math.max(((x - a.x) * abx + (z - a.z) * abz) / len2, 0), 1) : 0;
      const dx = x - (a.x + abx * t);
      const dz = z - (a.z + abz * t);
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        bestS = a.s + (b.s - a.s) * t;
      }
    }
    return { d: Math.sqrt(best), s: bestS };
  }

  /** Distance XZ à l'axe de la voie (exclusions de semis, splat ballast). */
  trackDistance(x: number, z: number): number {
    return this.closest(x, z).d;
  }
}
