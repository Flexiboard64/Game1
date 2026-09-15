import { Group, Mesh, OctahedronGeometry, CylinderGeometry, Material, Vector3 } from 'three/webgpu';
import { PALETTE, QUEST7 } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { LoadedProp } from '../assets/PropLoader';
import type { SnowField } from '../world/SnowField';

// Séquence interactive (M7) : 4 cristaux de résonance dans la crevasse — le
// premier éveillé lance un chrono ; des RAYONS de lumière relient les cristaux
// éveillés ; chrono écoulé → reset (les rayons s'éteignent). Canaris [Quest].
// M7.1 : amas de cristaux en vrai GLB Meshy (posé au sol, pas de rotation) ;
// GLB absent → repli octaèdre flottant d'origine.

export class ResonancePuzzle {
  readonly group = new Group();
  /** Vrai quand les 4 cristaux sont éveillés (l'autel s'active). */
  solved = false;
  /** Temps restant (−1 = pas commencé) — affiché dans l'objectif. */
  timeLeft = -1;
  /** Hooks audio (M8) : note i (0..3), accord de réussite, échec du chrono. */
  onNote: ((i: number) => void) | null = null;
  onSolved: (() => void) | null = null;
  onFail: (() => void) | null = null;

  private readonly crystals: { x: number; z: number; mesh: Mesh; beamY: number; lit: boolean }[] = [];
  private readonly beams: Mesh[] = [];
  private readonly dimMat: Material;
  private readonly litMat: Material;
  private readonly usesProp: boolean;
  private t = 0;

  constructor(snow: SnowField, crystalProp: LoadedProp | null) {
    this.usesProp = crystalProp !== null;
    if (crystalProp) {
      const map = crystalProp.material.map ?? null;
      this.dimMat = ToonMaterials.prop(map);
      this.litMat = ToonMaterials.glowProp(map, PALETTE.elements.cryo, 2.2);
    } else {
      this.dimMat = ToonMaterials.lantern('#5e93b8', 0.9); // éteint mais LISIBLE (pas noir)
      this.litMat = ToonMaterials.lantern(PALETTE.elements.cryo, 2.6);
    }
    for (const c of QUEST7.crystals) {
      const ground = snow.getHeight(c.x, c.z);
      let mesh: Mesh;
      let beamY: number;
      if (crystalProp) {
        // GLB normalisé pieds à y=0 : posé au sol, rayons à 60 % de la hauteur
        mesh = new Mesh(crystalProp.geometry, this.dimMat);
        mesh.position.set(c.x, ground - 0.06, c.z);
        mesh.rotation.y = (c.x * 7.3 + c.z * 3.1) % 6.28; // variété de pose gratuite
        mesh.castShadow = true;
        beamY = ground + crystalProp.height * 0.6;
      } else {
        mesh = new Mesh(new OctahedronGeometry(0.42, 0), this.dimMat);
        mesh.position.set(c.x, ground + 0.9, c.z);
        beamY = ground + 0.9;
      }
      this.group.add(mesh);
      this.crystals.push({ x: c.x, z: c.z, mesh, beamY, lit: false });
    }
    // Rayons pré-créés (compile au warmup), invisibles par échelle nulle
    const beamMat = ToonMaterials.lantern('#bfe8ff', 1.9);
    for (let i = 0; i < QUEST7.crystals.length - 1; i++) {
      const beam = new Mesh(new CylinderGeometry(0.05, 0.05, 1, 6), beamMat);
      beam.scale.setScalar(1e-4);
      this.group.add(beam);
      this.beams.push(beam);
    }
    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  /** Cristal non éveillé le plus proche en portée d'interaction (prompt F). */
  nearestUnlit(px: number, pz: number, range: number): number {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < this.crystals.length; i++) {
      const c = this.crystals[i]!;
      if (c.lit) continue;
      const d = Math.hypot(px - c.x, pz - c.z);
      if (d < range && d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  /** Éveille le cristal i (F) — lance le chrono au premier. */
  awaken(i: number): void {
    const c = this.crystals[i];
    if (!c || c.lit || this.solved) return;
    c.lit = true;
    c.mesh.material = this.litMat;
    if (this.timeLeft < 0) this.timeLeft = QUEST7.resonanceTimerS;
    const litCount = this.crystals.filter((k) => k.lit).length;
    console.info(`[Quest] cristal de résonance ${litCount}/4`);
    this.onNote?.(litCount - 1);
    this.rebuildBeams();
    if (litCount === this.crystals.length) {
      this.solved = true;
      this.timeLeft = -1;
      console.info('[Quest] résonance ACCOMPLIE');
      this.onSolved?.();
    }
  }

  update(dt: number): void {
    this.t += dt;
    for (const c of this.crystals) {
      if (this.usesProp) {
        // Amas posé au sol : pas de rotation — pulse d'échelle discret si éveillé
        if (c.lit) c.mesh.scale.setScalar(1 + Math.sin(this.t * 4) * 0.03);
      } else {
        c.mesh.rotation.y += dt * (c.lit ? 1.4 : 0.3);
        if (c.lit) c.mesh.scale.setScalar(1 + Math.sin(this.t * 4) * 0.07);
      }
    }
    if (this.solved || this.timeLeft < 0) return;
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) {
      // Échec : tout s'éteint (flash géré par le pulse du reset)
      this.timeLeft = -1;
      for (const c of this.crystals) {
        c.lit = false;
        c.mesh.material = this.dimMat;
        c.mesh.scale.setScalar(1);
      }
      this.rebuildBeams();
      console.info('[Quest] résonance ÉCHOUÉE — cristaux réinitialisés');
      this.onFail?.();
    }
  }

  /** Rayons entre cristaux éveillés CONSÉCUTIFS (relais lumineux). */
  private rebuildBeams(): void {
    for (let i = 0; i < this.beams.length; i++) {
      const a = this.crystals[i]!;
      const b = this.crystals[i + 1]!;
      const beam = this.beams[i]!;
      if (!(a.lit && b.lit)) {
        beam.scale.setScalar(1e-4);
        continue;
      }
      _a.set(a.x, a.beamY, a.z);
      _b.set(b.x, b.beamY, b.z);
      const len = _a.distanceTo(_b);
      beam.position.copy(_a).add(_b).multiplyScalar(0.5);
      beam.scale.set(1, len, 1);
      beam.lookAt(_b);
      beam.rotateX(Math.PI / 2); // cylindre Y → axe du regard
    }
  }
}

const _a = new Vector3();
const _b = new Vector3();
