import {
  AdditiveBlending,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
} from 'three/webgpu';
import { color, mix, mx_noise_float, smoothstep, uniform, uv, vec2 } from 'three/tsl';
import { PALETTE, VFX } from '../config';

// Tornade anémo de l'ultime Q : deux cônes ouverts contra-rotatifs, opacité en
// stries de bruit polaire qui SCROLLENT (uT propre, gèle au hitstop), cœur HDR.
// Mesh réellement transformé (matrixWorld vraie) — renderOrder explicite quand
// même pour rester déterministe face aux pools (18 < plans 19 < sparks 20).

export class TornadoVfx {
  readonly group = new Group();
  private readonly uT: { value: number };
  private readonly uActive: { value: number };
  private targetActive = 0;

  constructor() {
    const uT = uniform(0);
    const uActive = uniform(0);
    this.uT = uT as unknown as { value: number };
    this.uActive = uActive as unknown as { value: number };

    const makeCone = (scale: number, spinSign: number, alphaMul: number): Mesh => {
      const g = new CylinderGeometry(VFX.tornado.rTop * scale, VFX.tornado.rBot * scale, VFX.tornado.height, 24, 6, true);
      g.translate(0, VFX.tornado.height / 2, 0);
      // FrontSide seul : en DoubleSide additif, les faces arrière DOUBLENT
      // l'accumulation et les deux cônes superposés crament l'écran en blanc
      const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
      // uv.x = tour complet (0..1), uv.y = hauteur — stries qui montent en tournant
      const n = mx_noise_float(vec2(
        uv().x.mul(3).add(uT.mul(VFX.tornado.spin * spinSign)),
        uv().y.mul(2.5).sub(uT.mul(1.2)),
      ));
      // Bornes serrées : la tornade doit lire en STRIES, pas en nappe pleine
      const band = smoothstep(0.38, 0.8, n.mul(0.5).add(0.5));
      const edges = smoothstep(0.0, 0.15, uv().y).mul(smoothstep(1.0, 0.72, uv().y));
      m.colorNode = mix(color(PALETTE.elements.anemo), color('#eafff7'), band)
        .mul(band.mul(VFX.tornado.coreBoost - 1).add(0.9));
      m.opacityNode = band.mul(edges).mul(uActive).mul(VFX.tornado.alpha * alphaMul);
      const mesh = new Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.renderOrder = 18;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    };
    this.group.add(makeCone(1, 1, 1));
    this.group.add(makeCone(0.62, -1.4, 0.75));
  }

  activate(x: number, y: number, z: number): void {
    this.group.position.set(x, y, z);
    this.targetActive = 1;
  }

  deactivate(): void {
    this.targetActive = 0;
  }

  /** Pour le warmup de compile : opacité forcée pendant engine.compile()
   *  (le groupe reste toujours visible — c'est l'opacité qui fait l'apparition). */
  setCompileVisible(v: boolean): void {
    if (v) this.uActive.value = 1;
    else if (this.targetActive === 0) this.uActive.value = 0;
  }

  update(dt: number): void {
    this.uT.value += dt;
    // Fondu d'apparition/disparition (0,15 s / 0,3 s)
    const k = this.targetActive > this.uActive.value ? dt / 0.15 : -dt / 0.3;
    this.uActive.value = Math.min(1, Math.max(0, this.uActive.value + k));
    this.group.rotation.y += dt * 2.2;
  }
}
