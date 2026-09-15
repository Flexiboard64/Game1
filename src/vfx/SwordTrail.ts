import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { attribute, clamp, color, mix, oneMinus } from 'three/tsl';
import { VFX } from '../config';
import type { SwordMount } from '../combat/SwordMount';

// Traînée d'épée : ruban CPU qui échantillonne l'OS RÉEL de la main (garde +
// pointe de la lame) à chaque frame de rendu — toujours juste, quelle que soit
// la trajectoire du clip Meshy. Ring buffer de paires de sommets, opacité par
// âge. Fenêtre d'activité ouverte par les événements de swing.

export class SwordTrail {
  readonly mesh: Mesh;
  private readonly positions: Float32Array;
  private readonly ages: Float32Array;
  private readonly posAttr: BufferAttribute;
  private readonly ageAttr: BufferAttribute;
  private activeUntil = -1;
  private elapsed = 0;
  private readonly hilt = new Vector3();
  private readonly tip = new Vector3();

  constructor(private readonly sword: SwordMount) {
    const n = VFX.trailSamples;
    this.positions = new Float32Array(n * 2 * 3);
    this.ages = new Float32Array(n * 2).fill(1e3);
    const aV = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) aV[i * 2 + 1] = 1; // 0 = garde, 1 = pointe

    const geom = new BufferGeometry();
    this.posAttr = new BufferAttribute(this.positions, 3);
    this.ageAttr = new BufferAttribute(this.ages, 1);
    geom.setAttribute('position', this.posAttr);
    geom.setAttribute('aAge', this.ageAttr);
    geom.setAttribute('aV', new BufferAttribute(aV, 1));
    const indices: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geom.setIndex(indices);

    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    m.side = DoubleSide;
    const age = attribute('aAge', 'float') as unknown as Node<'float'>;
    const v = attribute('aV', 'float') as unknown as Node<'float'>;
    const lifeK = clamp(age.div(VFX.trailLifeS), 0, 1);
    m.colorNode = color('#bffbe4').mul(VFX.intensity.trail);
    m.opacityNode = oneMinus(lifeK).mul(mix(0.35, 1.0, v)).mul(0.85);

    this.mesh = new Mesh(geom, m);
    this.mesh.frustumCulled = false; // positions réécrites chaque frame
    this.mesh.renderOrder = 21;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** Ouvre la fenêtre de traînée (appelé sur les événements de swing). */
  activate(durationS: number): void {
    this.activeUntil = Math.max(this.activeUntil, this.elapsed + durationS);
  }

  update(dt: number): void {
    this.elapsed += dt;
    const n = VFX.trailSamples;
    for (let i = 0; i < n * 2; i++) this.ages[i] = this.ages[i]! + dt;

    if (this.elapsed < this.activeUntil && this.sword.sampleBlade(this.hilt, this.tip)) {
      // Décale le ring d'une paire, écrit la plus récente en tête
      this.positions.copyWithin(6, 0, (n - 1) * 2 * 3);
      this.ages.copyWithin(2, 0, (n - 1) * 2);
      this.positions[0] = this.hilt.x;
      this.positions[1] = this.hilt.y;
      this.positions[2] = this.hilt.z;
      this.positions[3] = this.tip.x;
      this.positions[4] = this.tip.y;
      this.positions[5] = this.tip.z;
      this.ages[0] = 0;
      this.ages[1] = 0;
    }
    this.posAttr.needsUpdate = true;
    this.ageAttr.needsUpdate = true;
  }
}
