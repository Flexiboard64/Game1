import { Vector3 } from 'three/webgpu';

// Polyligne XZ avec SDF (distance aux segments) et échantillonnage par abscisse
// curviligne — sert au chemin de terre (splat), à la clôture et aux exclusions de semis.

export class PolylinePath {
  /** Longueur cumulée totale (m). */
  readonly length: number;
  private readonly cumulative: number[];

  constructor(readonly points: Vector3[]) {
    this.cumulative = [0];
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      acc += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z);
      this.cumulative.push(acc);
    }
    this.length = acc;
  }

  /** Distance XZ du point (x,z) à la polyligne (min sur les segments). */
  distance(x: number, z: number): number {
    let best = Infinity;
    for (let i = 1; i < this.points.length; i++) {
      const a = this.points[i - 1]!;
      const b = this.points[i]!;
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz;
      const t = len2 > 0 ? Math.min(Math.max(((x - a.x) * abx + (z - a.z) * abz) / len2, 0), 1) : 0;
      const dx = x - (a.x + abx * t);
      const dz = z - (a.z + abz * t);
      const d = Math.hypot(dx, dz);
      if (d < best) best = d;
    }
    return best;
  }

  /** Position + tangente XZ (normalisée) à l'abscisse curviligne s (clampée). */
  sample(s: number, outPos: Vector3, outTan: Vector3): void {
    const cum = this.cumulative;
    const clamped = Math.min(Math.max(s, 0), this.length);
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < clamped) i++;
    const a = this.points[i - 1]!;
    const b = this.points[i]!;
    const segLen = cum[i]! - cum[i - 1]!;
    const t = segLen > 0 ? (clamped - cum[i - 1]!) / segLen : 0;
    outPos.set(a.x + (b.x - a.x) * t, 0, a.z + (b.z - a.z) * t);
    outTan.set(b.x - a.x, 0, b.z - a.z).normalize();
  }
}
