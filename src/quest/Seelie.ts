import { Group, Mesh, SphereGeometry, Vector3 } from 'three/webgpu';
import { PALETTE, QUEST7 } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { LoadedProp } from '../assets/PropLoader';
import type { SnowField } from '../world/SnowField';

// Luciole de givre (M7) : seelie façon Genshin — esprit cryo lumineux + traîne de
// motes, suit un chemin waypointé, ATTEND le joueur (> waitD) et repart (< resumeD).
// M9.2 : vrai GLB Meshy (glowProp : l'albédo devient sa carte émissive) animé
// procéduralement (cap lissé vers la direction de vol, roulis, pulse — pas de rig,
// pattern Wraith) ; GLB absent → repli orbe d'origine.

export class Seelie {
  readonly group = new Group();
  /** Porte le modèle : cap + roulis + pulse (le group ne fait que la position). */
  private readonly body = new Group();
  private readonly motes: Mesh[] = [];
  private readonly trail: Vector3[] = [];
  private wp = 0;
  private t = 0;
  private yaw = 0;
  private targetYaw = 0;
  active = false;
  /** Vrai quand la luciole est arrivée au dernier waypoint. */
  arrived = false;

  constructor(private readonly snow: SnowField, prop: LoadedProp | null) {
    if (prop) {
      // GLB normalisé pieds à y=0 par loadProp : pivot ramené au CENTRE (vol)
      const mesh = new Mesh(
        prop.geometry,
        ToonMaterials.glowProp(prop.material.map ?? null, PALETTE.elements.cryo, QUEST7.seelieModel.glow),
      );
      mesh.position.y = -prop.height * 0.5;
      this.body.add(mesh);
    } else {
      this.body.add(new Mesh(new SphereGeometry(0.3, 12, 10), ToonMaterials.lantern(PALETTE.elements.cryo, 2.6)));
    }
    this.group.add(this.body);
    for (let i = 0; i < 6; i++) {
      const m = new Mesh(new SphereGeometry(0.09 - i * 0.008, 8, 6), ToonMaterials.lantern('#bfe8ff', 1.8));
      this.group.add(m);
      this.motes.push(m);
      this.trail.push(new Vector3());
    }
    const s = QUEST7.seeliePath[0]!;
    this.group.position.set(s.x, snow.getHeight(s.x, s.z) + 1.6, s.z);
    this.group.visible = false;
    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  /** Départ de l'escorte (étape 2 de la quête). */
  begin(): void {
    this.active = true;
    this.group.visible = true;
    console.info('[Quest] la Luciole de givre s’élance');
  }

  update(dt: number, playerX: number, playerZ: number): void {
    if (!this.active) return;
    this.t += dt;
    const M = QUEST7.seelieModel;
    const p = this.group.position;
    const dPlayer = Math.hypot(p.x - playerX, p.z - playerZ);

    if (!this.arrived && this.wp < QUEST7.seeliePath.length) {
      // Attend si le joueur décroche, repart quand il se rapproche
      const waiting = dPlayer > QUEST7.seelieWaitD || (this.paused && dPlayer > QUEST7.seelieResumeD);
      this.paused = waiting;
      if (!waiting) {
        const target = QUEST7.seeliePath[this.wp]!;
        const dx = target.x - p.x;
        const dz = target.z - p.z;
        const d = Math.hypot(dx, dz);
        if (d < 1.2) {
          this.wp++;
          if (this.wp >= QUEST7.seeliePath.length) {
            this.arrived = true;
            console.info('[Quest] Luciole arrivée à la crevasse');
          }
        } else {
          p.x += (dx / d) * QUEST7.seelieSpeed * dt;
          p.z += (dz / d) * QUEST7.seelieSpeed * dt;
          this.targetYaw = Math.atan2(dx, dz) + M.yawOffset;
        }
      } else if (dPlayer > 0.5) {
        // À l'attente : se tourne vers le joueur (lisibilité « suis-moi »)
        this.targetYaw = Math.atan2(playerX - p.x, playerZ - p.z) + M.yawOffset;
      }
    }
    // Altitude : 1,6 m au-dessus du sol + bob
    p.y = this.snow.getHeight(p.x, p.z) + 1.6 + Math.sin(this.t * 2.2) * 0.18;

    // Corps : cap lissé (arc le plus court), roulis doux, respiration d'échelle
    let dYaw = this.targetYaw - this.yaw;
    dYaw = Math.atan2(Math.sin(dYaw), Math.cos(dYaw));
    this.yaw += dYaw * (1 - Math.exp(-M.turnLerp * dt));
    const sway = (M.swayDeg * Math.PI) / 180;
    this.body.rotation.set(
      Math.sin(this.t * 1.7 + 1.0) * sway * 0.6,
      this.yaw,
      Math.sin(this.t * 1.3) * sway,
    );
    this.body.scale.setScalar(1 + Math.sin(this.t * 5) * M.pulse);

    // Traîne : chaque mote poursuit la précédente (retard en chaîne)
    let prev = p;
    for (let i = 0; i < this.motes.length; i++) {
      const pos = this.trail[i]!;
      pos.lerp(prev, 1 - Math.exp(-dt / (0.06 + i * 0.03)));
      this.motes[i]!.position.copy(pos).sub(p); // en local du groupe
      prev = pos;
    }
  }

  private paused = false;
}
