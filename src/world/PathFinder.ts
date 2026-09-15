import { Vector3 } from 'three/webgpu';
import { PATH } from '../config';
import type { HeightField } from './HeightField';

// Tracé de chemin par A* sur le VRAI terrain (pas de nœuds figés en config :
// ils dérivaient dès qu'une constante de relief bougeait). Les arêtes trop
// pentues sont interdites, le coût pénalise la montée et l'eau → le chemin
// contourne les raidillons et passe par les gués. Déterministe (grille + coûts
// fixes, départage stable), quelques ms au boot.

interface Node {
  i: number;
  g: number;
  f: number;
}

/** File de priorité binaire minimale (évite un tri O(n log n) par extraction). */
class MinHeap {
  private readonly items: Node[] = [];

  push(n: Node): void {
    this.items.push(n);
    let c = this.items.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (this.items[p]!.f <= this.items[c]!.f) break;
      [this.items[p], this.items[c]] = [this.items[c]!, this.items[p]!];
      c = p;
    }
  }

  pop(): Node | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let p = 0;
      for (;;) {
        const l = p * 2 + 1;
        const r = l + 1;
        let s = p;
        if (l < this.items.length && this.items[l]!.f < this.items[s]!.f) s = l;
        if (r < this.items.length && this.items[r]!.f < this.items[s]!.f) s = r;
        if (s === p) break;
        [this.items[p], this.items[s]] = [this.items[s]!, this.items[p]!];
        p = s;
      }
    }
    return top;
  }

  get size(): number {
    return this.items.length;
  }
}

const STEP = 2; // m entre nœuds de la grille de recherche

/**
 * Chemin marchable entre deux points monde. Renvoie les positions XZ (y=0) ;
 * null si aucun tracé ne respecte la pente maximale.
 */
export function findWalkablePath(
  ground: HeightField,
  from: { x: number; z: number },
  to: { x: number; z: number },
  maxSlopeDeg = PATH.maxSlopeDeg,
): Vector3[] | null {
  const half = ground.size / 2 - 4;
  const dim = Math.floor((half * 2) / STEP) + 1;
  const toIdx = (ix: number, iz: number): number => iz * dim + ix;
  const worldX = (ix: number): number => -half + ix * STEP;
  const worldZ = (iz: number): number => -half + iz * STEP;
  const clampIdx = (v: number): number => Math.min(Math.max(Math.round((v + half) / STEP), 0), dim - 1);

  const sx = clampIdx(from.x);
  const sz = clampIdx(from.z);
  const gx = clampIdx(to.x);
  const gz = clampIdx(to.z);
  const goal = toIdx(gx, gz);

  const heights = new Float32Array(dim * dim);
  for (let iz = 0; iz < dim; iz++) {
    for (let ix = 0; ix < dim; ix++) {
      heights[toIdx(ix, iz)] = ground.getHeight(worldX(ix), worldZ(iz));
    }
  }

  const gScore = new Float32Array(dim * dim).fill(Infinity);
  const cameFrom = new Int32Array(dim * dim).fill(-1);
  const closed = new Uint8Array(dim * dim);
  const maxRise = Math.tan((maxSlopeDeg * Math.PI) / 180);

  const heuristic = (ix: number, iz: number): number =>
    Math.hypot(worldX(ix) - worldX(gx), worldZ(iz) - worldZ(gz));

  const open = new MinHeap();
  gScore[toIdx(sx, sz)] = 0;
  open.push({ i: toIdx(sx, sz), g: 0, f: heuristic(sx, sz) });

  const neighbours = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ] as const;

  /**
   * Une arête n'est marchable que si AUCUN de ses sous-segments ne dépasse la
   * pente : tester seulement les extrémités laissait passer les bosses
   * intermédiaires (le profil final, échantillonné au mètre, les révélait).
   */
  const edgeWalkable = (ax: number, az: number, bx: number, bz: number): boolean => {
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(len / PATH.edgeSampleStep));
    let prev = ground.getHeight(ax, az);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const h = ground.getHeight(ax + (bx - ax) * t, az + (bz - az) * t);
      if (Math.abs(h - prev) / (len / steps) > maxRise) return false;
      prev = h;
    }
    return true;
  };

  while (open.size > 0) {
    const cur = open.pop()!;
    if (cur.i === goal) break;
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
    const cix = cur.i % dim;
    const ciz = (cur.i - cix) / dim;
    const ch = heights[cur.i]!;

    for (const [dx, dz] of neighbours) {
      const nix = cix + dx;
      const niz = ciz + dz;
      if (nix < 0 || niz < 0 || nix >= dim || niz >= dim) continue;
      const ni = toIdx(nix, niz);
      if (closed[ni]) continue;
      const dist = Math.hypot(dx, dz) * STEP;
      const dh = heights[ni]! - ch;
      if (Math.abs(dh) / dist > maxRise) continue; // rejet rapide (extrémités)
      const nx = worldX(nix);
      const nz = worldZ(niz);
      if (!edgeWalkable(worldX(cix), worldZ(ciz), nx, nz)) continue; // bosses intermédiaires

      // Coût : distance + pénalité de dénivelé + forte pénalité dans l'eau
      // (le chemin ne traverse que là où c'est peu profond : les gués).
      // La pénalité doit porter sur la PROFONDEUR, pas sur la distance à la
      // rive : un gué large et peu profond coûtait plus cher qu'un point
      // étroit et profond, donc le tracé contournait au lieu de traverser.
      const sdf = ground.getWaterSdf(nx, nz);
      const depth = sdf < 0 ? Math.max(0, ground.levelAt(nx, nz) - heights[ni]!) : 0;
      const cost = dist * (1 + PATH.slopeCost * (Math.abs(dh) / dist)) + depth * PATH.waterCost;
      const tentative = cur.g + cost;
      if (tentative < gScore[ni]!) {
        gScore[ni] = tentative;
        cameFrom[ni] = cur.i;
        open.push({ i: ni, g: tentative, f: tentative + heuristic(nix, niz) });
      }
    }
  }

  if (cameFrom[goal] === -1 && goal !== toIdx(sx, sz)) return null;

  const out: Vector3[] = [];
  let node = goal;
  while (node !== -1) {
    const ix = node % dim;
    const iz = (node - ix) / dim;
    out.push(new Vector3(worldX(ix), 0, worldZ(iz)));
    if (node === toIdx(sx, sz)) break;
    node = cameFrom[node]!;
  }
  out.reverse();
  return simplify(out, ground, maxSlopeDeg);
}

/**
 * Retire les nœuds dont la suppression ne creuse ni virage ni pente excessive
 * (les micro-zigzags de grille) — la pente reste re-vérifiée après chaque fusion.
 */
function simplify(pts: Vector3[], ground: HeightField, maxSlopeDeg: number): Vector3[] {
  if (pts.length < 3) return pts;
  const maxRise = Math.tan((maxSlopeDeg * Math.PI) / 180);
  const out: Vector3[] = [pts[0]!];
  let anchor = pts[0]!;
  for (let i = 1; i < pts.length - 1; i++) {
    const cand = pts[i + 1]!;
    // Le segment anchor→cand doit rester marchable ET proche du tracé d'origine
    const len = Math.hypot(cand.x - anchor.x, cand.z - anchor.z);
    let ok = len <= PATH.simplifyMaxSpan;
    if (ok) {
      const steps = Math.max(2, Math.ceil(len / PATH.edgeSampleStep));
      const segLen = len / steps;
      let prevH = ground.getHeight(anchor.x, anchor.z);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const x = anchor.x + (cand.x - anchor.x) * t;
        const z = anchor.z + (cand.z - anchor.z) * t;
        const h = ground.getHeight(x, z);
        if (Math.abs(h - prevH) / segLen > maxRise) {
          ok = false;
          break;
        }
        prevH = h;
      }
    }
    if (!ok) {
      out.push(pts[i]!);
      anchor = pts[i]!;
    }
  }
  out.push(pts[pts.length - 1]!);
  return out;
}
