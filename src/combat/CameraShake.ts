import type { PerspectiveCamera } from 'three/webgpu';
import { VFX } from '../config';
import type { Updatable } from '../core/Engine';

// Screen shake au modèle « trauma » : les impacts AJOUTENT du trauma ∈ [0,1],
// l'offset appliqué vaut trauma² (les petits coups tremblent à peine, les gros
// secouent) et décroît linéairement. Enregistré APRÈS ThirdPersonCamera (le
// lookAt vient d'orienter la caméra) et AVANT hud.update (les projections
// monde→écran suivent la caméra secouée — barres et nombres tremblent avec le
// monde, c'est correct).

export class CameraShake implements Updatable {
  private trauma = 0;
  private t = 0;

  constructor(private readonly camera: PerspectiveCamera) {}

  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  update(dt: number): void {
    if (this.trauma <= 0) return;
    this.t += dt;
    const s = this.trauma * this.trauma;
    // Deux fréquences non commensurables — jamais de motif répétitif
    const nx = Math.sin(this.t * Math.PI * 2 * 28) * 0.6 + Math.sin(this.t * Math.PI * 2 * 17.3 + 1.7) * 0.4;
    const ny = Math.sin(this.t * Math.PI * 2 * 23.7 + 4.1) * 0.6 + Math.sin(this.t * Math.PI * 2 * 31.1 + 2.3) * 0.4;
    const amp = VFX.shake.maxOffsetM * s;
    // Offsets en espace caméra (la caméra vient d'être posée + orientée)
    this.camera.translateX(nx * amp);
    this.camera.translateY(ny * amp);
    this.camera.rotateZ(nx * s * (VFX.shake.rollDeg * Math.PI) / 180);
    this.trauma = Math.max(0, this.trauma - VFX.shake.decayPerS * dt);
  }
}
