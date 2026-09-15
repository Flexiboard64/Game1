import { CAMP, RAIL } from '../config';
import { inVistaCorridor } from './PropField';
import type { HeightField } from './HeightField';
import type { Terrain } from './Terrain';
import type { ObstacleGrid } from './Obstacles';

// Camps de golems : semis déterministe façon PropField — plat, sec, hors chemin,
// hors spawn, hors corridor de vue de la cascade, espacés entre eux. Tamponne la
// terre battue dans la splat (AVANT l'herbe et le compile — l'herbe évite les
// camps via getSplat, contrat identique aux halos de rochers).

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

export interface CampSlot {
  x: number;
  z: number;
  heading: number;
  camp: number; // index du camp (aggro de meute)
}

export class CampField {
  readonly camps: { x: number; z: number }[] = [];
  readonly slots: CampSlot[] = [];

  constructor(
    terrain: Terrain,
    ground: HeightField,
    obstacles: ObstacleGrid,
    trackDistance: ((x: number, z: number) => number) | null = null,
  ) {
    const rand = mulberry32(CAMP.seed);
    const half = ground.size / 2 - CAMP.edgeMargin;
    let attempts = 0;

    while (this.camps.length < CAMP.count && attempts < CAMP.budget) {
      attempts++;
      const x = (rand() * 2 - 1) * half;
      const z = (rand() * 2 - 1) * half;
      if (Math.hypot(x, z) < CAMP.spawnClear) continue;
      if (inVistaCorridor(x, z)) continue; // un camp ne masque pas la chute
      if (terrain.pathDistance(x, z) < CAMP.pathClear) continue;
      if (trackDistance && trackDistance(x, z) < RAIL.clearCamp) continue; // pas de camp sur la voie
      if (ground.getWaterSdf(x, z) < CAMP.waterClear) continue;
      if (ground.getSlopeDeg(x, z) > CAMP.maxSlopeDeg) continue;
      if (obstacles.blocked(x, z, CAMP.slotRadius + 0.8)) continue;
      if (this.camps.some((c) => Math.hypot(c.x - x, c.z - z) < CAMP.interCamp)) continue;

      // Slots des golems sur un anneau — chaque slot doit rester praticable
      const n = CAMP.golemsMin + Math.floor(rand() * (CAMP.golemsMax - CAMP.golemsMin + 1));
      const baseAng = rand() * Math.PI * 2;
      const slots: CampSlot[] = [];
      let ok = true;
      for (let k = 0; k < n; k++) {
        const ang = baseAng + (k / n) * Math.PI * 2;
        const sx = x + Math.cos(ang) * CAMP.slotRadius;
        const sz = z + Math.sin(ang) * CAMP.slotRadius;
        if (ground.getSlopeDeg(sx, sz) > CAMP.maxSlopeDeg + 8 || ground.getWaterSdf(sx, sz) < 1.2) {
          ok = false;
          break;
        }
        slots.push({ x: sx, z: sz, heading: rand() * Math.PI * 2, camp: this.camps.length });
      }
      if (!ok) continue;

      this.camps.push({ x, z });
      this.slots.push(...slots);
      // Terre battue du camp (splat mutable gratuitement avant compile)
      terrain.stampSplat(x, z, CAMP.stampR, 0.85, 0.1);
    }

    console.info(`[CampField] camps : ${this.camps.length}/${CAMP.count} posés, ${this.slots.length} golems (${attempts} tentatives)`);
  }
}
