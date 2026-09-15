import { InstancedMesh, PlaneGeometry, SpriteNodeMaterial, Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  cameraPosition,
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
  color,
} from 'three/tsl';
import { AMBIENCE, SNOW } from '../config';

// Chutes de neige (M5) : clone paramétré du pattern SeedField — flocons blancs
// enroulés par fract() dans une boîte qui suit le joueur, avec un uniform
// d'intensité (fondu quand on quitte la région neige, AUCUN rebuild).

export class SnowfallField {
  readonly mesh: InstancedMesh;
  private readonly center = uniform(new Vector3(0, SNOW.flakeBoxLift, 0));
  private readonly intensity = uniform(0);
  /** 0 = calme, 1 = bourrasque (vent multiplié, flocons étirés en traînées). */
  private readonly blizzard = uniform(0);

  constructor() {
    const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
    const h = (n: number) => hash(instanceIndex.add(n));
    const S = vec3(SNOW.flakeBox.x, SNOW.flakeBox.y, SNOW.flakeBox.z);
    const boxMin = this.center.sub(S.mul(0.5));

    const seedPos = vec3(h(0), h(1), h(2)).mul(S);
    const swayF = mix(float(0.4), float(0.9), h(3)).mul(6.2832);
    // Bourrasques (M6) : le vent horizontal est démultiplié par l'uniform blizzard
    const windGain = this.blizzard.mul(AMBIENCE.blizzard.windMul).add(1);
    const drift = vec3(
      time.mul(SNOW.flakeWindX).mul(windGain).add(sin(time.mul(swayF).add(h(5).mul(6.2832))).mul(0.7)),
      time.mul(-SNOW.flakeFall),
      time.mul(SNOW.flakeWindZ).mul(windGain).add(cos(time.mul(swayF.mul(0.8)).add(h(6).mul(6.2832))).mul(0.7)),
    );
    const wrapped = boxMin.add(fract(seedPos.add(drift).sub(boxMin).div(S)).mul(S));
    m.positionNode = wrapped;
    const size = mix(float(SNOW.flakeMinSize), float(SNOW.flakeMaxSize), h(7));
    // Étirées en traînées horizontales sous bourrasque (réf 2)
    m.scaleNode = vec2(size.mul(this.blizzard.mul(AMBIENCE.blizzard.stretch).add(1)), size);

    const p = uv().sub(0.5);
    const disc = smoothstep(0.16, 0.5, p.length()).oneMinus();

    const nrm = wrapped.sub(boxMin).div(S);
    const edge = (c: Node<'float'>) =>
      smoothstep(0.0, 0.12, c).mul(smoothstep(0.88, 1.0, c).oneMinus());
    const envBox = edge(nrm.x).mul(edge(nrm.y)).mul(edge(nrm.z));

    const dist = wrapped.sub(cameraPosition).length();
    const envNear = smoothstep(float(1.2), float(2.8), dist);

    m.colorNode = color('#ffffff');
    m.opacityNode = disc.mul(envBox).mul(envNear).mul(SNOW.flakeOpacity).mul(this.intensity);

    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), m, SNOW.flakeCount);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** Recentrage de la boîte + intensité (0 = vallée, 1 = plein flocons) + bourrasque. */
  update(x: number, y: number, z: number, t: number, blizzard = 0): void {
    this.center.value.set(x, y + SNOW.flakeBoxLift, z);
    this.intensity.value = t;
    this.blizzard.value = blizzard;
  }
}
