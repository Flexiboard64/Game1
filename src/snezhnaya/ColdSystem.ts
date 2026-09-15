import { Vector3 } from 'three/webgpu';
import { BRAZIERS, COLD, FATUI, MESA, RAIL } from '../config';
import type { Updatable } from '../core/Engine';
import type { CharacterController } from '../player/CharacterController';
import type { CombatSystem } from '../combat/CombatSystem';
import type { RideController } from '../train/RideController';
import type { SnowField } from '../world/SnowField';

// Froid mordant (M6, type « Sheer Cold » de Dragonspine) : la jauge monte dans
// la région neige hors sources de chaleur (braseros ALLUMÉS, quais de gare,
// brasero géant Fatui, la ville entière, l'intérieur du wagon), redescend vite
// au chaud ; pleine, elle draine les PV (dégâts environnementaux, sans
// i-frames). Le blizzard cyclique double le remplissage — et pilote les
// bourrasques visuelles (flocons étirés). Canaris console [Cold].

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

export class ColdSystem implements Updatable {
  /** Jauge normalisée 0..1 (le HUD tire). */
  cold01 = 0;
  /** Intensité de bourrasque 0..1 (flocons + fog + UI). */
  blizzard01 = 0;
  /** Braseros allumés (partagé avec InteractionManager + respawn). */
  readonly brazierLit: boolean[] = BRAZIERS.map(() => false);
  /** Dernier brasero allumé PAR le joueur (checkpoint de respawn). */
  lastLitIndex = -1;

  private gustT = 0;
  private inGust = false;
  private wasCold = false;
  private readonly rand = mulberry32(90210);

  constructor(
    private readonly player: CharacterController,
    private readonly combat: CombatSystem,
    private readonly ride: RideController,
    private readonly snow: SnowField,
  ) {}

  /** Vrai si (x,z) est au chaud (le froid ne monte pas, il descend). */
  isWarm(x: number, z: number): boolean {
    if (this.snow.inCity(x, z)) return true;
    if (Math.hypot(x - RAIL.stationSnow.x, z - RAIL.stationSnow.z) < COLD.stationWarmR) return true;
    if (Math.hypot(x - RAIL.stationCity.x, z - RAIL.stationCity.z) < COLD.stationWarmR) return true;
    if (Math.hypot(x - FATUI.brazier.x, z - FATUI.brazier.z) < COLD.giantBrazierWarmR) return true;
    for (let i = 0; i < BRAZIERS.length; i++) {
      if (!this.brazierLit[i]) continue;
      const b = BRAZIERS[i]!;
      if (Math.hypot(x - b.x, z - b.z) < COLD.brazierWarmR) return true;
    }
    return false;
  }

  fixedUpdate(dt: number): void {
    // Cycle de bourrasques (toundra uniquement) : calme … rafale … calme
    this.gustT -= dt;
    if (this.gustT <= 0) {
      this.inGust = !this.inGust;
      this.gustT = this.inGust
        ? COLD.blizzard.gustS * (0.7 + this.rand() * 0.6)
        : COLD.blizzard.calmS * (0.7 + this.rand() * 0.6);
      if (this.inGust) console.info('[Cold] bourrasque');
    }
    const gustTarget = this.inGust ? 1 : 0;
    const ramp = dt / COLD.blizzard.rampS;
    this.blizzard01 += Math.min(Math.max(gustTarget - this.blizzard01, -ramp), ramp);

    this.player.worldPosition(_pw);
    const inSnow = this.snow.contains(_pw.x, _pw.z);
    const exposed = inSnow && !this.ride.aboard && !this.isWarm(_pw.x, _pw.z);
    // La ville et le plateau sont chauds ; la nuit du plateau n'a pas de blizzard
    const inTundra = this.snow.inTundra(_pw.x, _pw.z);

    if (exposed) {
      const mult = inTundra ? 1 + this.blizzard01 * (COLD.blizzardMult - 1) : 0.7;
      this.cold01 = Math.min(1, this.cold01 + (COLD.risePerS / COLD.max) * mult * dt);
    } else {
      this.cold01 = Math.max(0, this.cold01 - (COLD.fallPerS / COLD.max) * dt);
    }

    if (this.cold01 >= 1) this.combat.applyEnvironmentalDamage(COLD.hpDrainPerS * dt);
    this.combat.setRegenBlocked(this.cold01 > COLD.regenBlockAt);

    const isCold = this.cold01 > 0.02;
    if (isCold !== this.wasCold) {
      this.wasCold = isCold;
      console.info(`[Cold] ${isCold ? 'jauge active' : 'réchauffé'}`);
    }
  }

  /** Reset au respawn (appel direct de CombatSystem, patron train.onArrive). */
  reset(): void {
    this.cold01 = 0;
  }
}

const _pw = new Vector3();

/** Le plateau (ville) est chaud — helper exporté pour l'UI. */
export function inCityPlateau(x: number, z: number): boolean {
  return Math.hypot(x - MESA.cx, z - MESA.cz) < MESA.rTop;
}
