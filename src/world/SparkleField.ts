import {
  AdditiveBlending,
  InstancedBufferAttribute,
  InstancedMesh,
  PlaneGeometry,
  SpriteNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  color,
  float,
  hash,
  instancedBufferAttribute,
  instanceIndex,
  mix,
  sin,
  smoothstep,
  time,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { SPARKLES } from '../config';

// Étoiles scintillantes des objets ramassables (mufliers) : billboards additifs
// HDR — SpriteNodeMaterial est unlit, le colorNode > 1 EST la voie du glow, le
// bloom seuillé l'attrape. Pulsation d'échelle/opacité par instance, zéro CPU.

export class SparkleField {
  readonly mesh: InstancedMesh | null;

  constructor(anchors: readonly Vector3[]) {
    if (anchors.length === 0) {
      this.mesh = null;
      return;
    }
    const data = new Float32Array(anchors.length * 3);
    for (let i = 0; i < anchors.length; i++) {
      data[i * 3] = anchors[i]!.x;
      data[i * 3 + 1] = anchors[i]!.y;
      data[i * 3 + 2] = anchors[i]!.z;
    }
    const attr = new InstancedBufferAttribute(data, 3);
    // @types/three type la surcharge (attr, type) en Node<string> — cast dimensionnel
    const aAnchor = instancedBufferAttribute(attr, 'vec3') as unknown as Node<'vec3'>;

    const m = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });

    const phase = hash(instanceIndex.add(11)).mul(6.2832);
    const freq = mix(
      float(6.2832 / SPARKLES.periodMax),
      float(6.2832 / SPARKLES.periodMin),
      hash(instanceIndex.add(12)),
    );
    const tw = sin(time.mul(freq).add(phase)).mul(0.5).add(0.5);
    const pulse = tw.mul(tw); // scintillement « allumé/éteint »

    m.positionNode = aAnchor.add(
      vec3(0, float(SPARKLES.hoverBase).add(sin(time.mul(1.3).add(phase)).mul(SPARKLES.hoverAmp)), 0),
    );
    const size = float(SPARKLES.size).mul(mix(0.5, 1.5, tw));
    m.scaleNode = vec2(size, size);
    m.rotationNode = hash(instanceIndex.add(13)).mul(6.2832);

    // Étoile 4 branches procédurale : cœur rond + 2 lames fines croisées
    const q = uv().sub(0.5).mul(2);
    const core = smoothstep(0.05, 0.35, q.length()).oneMinus();
    const bladeV = smoothstep(0.0, 0.08, q.y.abs()).oneMinus()
      .mul(smoothstep(0.1, 1.0, q.x.abs()).oneMinus());
    const bladeH = smoothstep(0.0, 0.08, q.x.abs()).oneMinus()
      .mul(smoothstep(0.1, 1.0, q.y.abs()).oneMinus());
    const star = clamp(core.add(bladeV).add(bladeH), 0, 1);

    const dist = aAnchor.sub(cameraPosition).length();
    const far = smoothstep(float(SPARKLES.fadeStart), float(SPARKLES.fadeEnd), dist).oneMinus();

    m.colorNode = color(SPARKLES.color).mul(SPARKLES.intensity); // HDR → bloom
    m.opacityNode = star.mul(pulse).mul(far);

    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), m, anchors.length);
    this.mesh.frustumCulled = false; // ~40 quads, pas la peine d'une sphère
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }
}
