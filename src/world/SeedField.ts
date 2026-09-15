import { InstancedMesh, PlaneGeometry, SpriteNodeMaterial, Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  cameraPosition,
  color,
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { SEEDS } from '../config';

// Graines/pollen flottants : quads sprite instanciés, position 100 % GPU.
// La position absolue (graine + dérive vent/chute/errance) est enroulée par
// fract() dans une boîte qui SUIT le joueur via un unique uniform — fract est
// à base floor sur les 2 backends (PAS mod : « % » WGSL tronque les négatifs).
// L'enveloppe de bord 12 % sur les 3 axes rend tout wrap invisible.

export class SeedField {
  readonly mesh: InstancedMesh;
  private readonly center = uniform(new Vector3(0, SEEDS.boxLift, 0));

  constructor() {
    const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const h = (n: number) => hash(instanceIndex.add(n));
    const S = vec3(SEEDS.box.x, SEEDS.box.y, SEEDS.box.z);
    const boxMin = this.center.sub(S.mul(0.5));

    // Position absolue non bornée : graine + vent constant + chute lente + errance
    const seedPos = vec3(h(0), h(1), h(2)).mul(S);
    const bobF = mix(float(SEEDS.bobFreqMin), float(SEEDS.bobFreqMax), h(3)).mul(6.2832);
    const drift = vec3(
      time.mul(SEEDS.windX).add(sin(time.mul(0.5).add(h(5).mul(6.2832))).mul(0.8)),
      time.mul(-SEEDS.fallSpeed).add(sin(time.mul(bobF).add(h(4).mul(6.2832))).mul(SEEDS.bobAmp)),
      time.mul(SEEDS.windZ).add(cos(time.mul(0.43).add(h(6).mul(6.2832))).mul(0.8)),
    );
    const wrapped = boxMin.add(fract(seedPos.add(drift).sub(boxMin).div(S)).mul(S));
    m.positionNode = wrapped;
    const size = mix(float(SEEDS.minSize), float(SEEDS.maxSize), h(7));
    m.scaleNode = vec2(size, size);

    // Disque doux procédural (aucune texture)
    const p = uv().sub(0.5);
    const disc = smoothstep(0.18, 0.5, p.length()).oneMinus();

    // Enveloppe de bord de boîte (3 axes) : tue tout pop au wrap, même vertical
    const nrm = wrapped.sub(boxMin).div(S);
    const edge = (c: Node<'float'>) =>
      smoothstep(0.0, 0.12, c).mul(smoothstep(0.88, 1.0, c).oneMinus());
    const envBox = edge(nrm.x).mul(edge(nrm.y)).mul(edge(nrm.z));

    // Fondus caméra : trop près (quad plein écran) et trop loin
    const dist = wrapped.sub(cameraPosition).length();
    const envNear = smoothstep(float(SEEDS.nearFade), float(SEEDS.nearFade + 1.5), dist);
    const envFar = smoothstep(float(SEEDS.fadeStart), float(SEEDS.fadeEnd), dist).oneMinus();

    m.colorNode = color('#ffffff');
    m.opacityNode = disc.mul(envBox).mul(envNear).mul(envFar).mul(SEEDS.baseOpacity);

    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), m, SEEDS.count);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** La seule écriture CPU par frame : recentrer la boîte sur le joueur. */
  follow(x: number, y: number, z: number): void {
    this.center.value.set(x, y + SEEDS.boxLift, z);
  }
}
