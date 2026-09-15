// Collision statique par cercles XZ (troncs, rochers, clôture) : le terrain
// reste la seule « physique », tryMove teste en plus cette grille — le slide
// par axes existant fournit le contournement gratuitement.

export interface CircleObstacle {
  x: number;
  z: number;
  r: number;
}

const CELL = 8; // m — assez grand pour que blocked() ne visite que 3×3 cellules

export class ObstacleGrid {
  private readonly cells = new Map<number, CircleObstacle[]>();

  private key(cx: number, cz: number): number {
    // Décalage pour rester positif sur ±130 m (16 384 cellules de marge)
    return (cx + 2048) * 4096 + (cz + 2048);
  }

  add(o: CircleObstacle): void {
    const cx = Math.floor(o.x / CELL);
    const cz = Math.floor(o.z / CELL);
    const k = this.key(cx, cz);
    let list = this.cells.get(k);
    if (!list) {
      list = [];
      this.cells.set(k, list);
    }
    list.push(o);
  }

  /** Retire un obstacle précédemment ajouté (murs d'arène M6). */
  remove(o: CircleObstacle): void {
    const cx = Math.floor(o.x / CELL);
    const cz = Math.floor(o.z / CELL);
    const list = this.cells.get(this.key(cx, cz));
    if (!list) return;
    const i = list.indexOf(o);
    if (i >= 0) list.splice(i, 1);
  }

  /** Vrai si le disque (x,z,radius) touche un obstacle. */
  blocked(x: number, z: number, radius: number): boolean {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.key(cx + dx, cz + dz));
        if (!list) continue;
        for (const o of list) {
          const rr = o.r + radius;
          const ddx = x - o.x;
          const ddz = z - o.z;
          if (ddx * ddx + ddz * ddz < rr * rr) return true;
        }
      }
    }
    return false;
  }
}
