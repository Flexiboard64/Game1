import {
  AdditiveBlending,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SpriteNodeMaterial,
  Vector3,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  color,
  cos,
  float,
  instancedBufferAttribute,
  mix,
  mx_noise_float,
  oneMinus,
  positionLocal,
  select,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { PALETTE, VFX } from '../config';

// Pools de VFX de combat : écriture CPU AU SPAWN seulement (attributs par
// instance birth/kind/seed/pos/dir), toute l'évolution est GPU en fonction de
// (uT − aBirth). uT est un uniform CPU incrémenté du dt SCALÉ (gèle au hitstop,
// contrairement au nœud `time` du renderer). Instances mortes = alpha 0.
// Pièges respectés : transparents à positions shader → renderOrder explicite ;
// frustumCulled=false (bounding fausse) ; visibles en permanence (compile warmup).

const DEAD = -1e4;

/** Billboards additifs (SpriteNodeMaterial) : étincelles, flashs, motes, débris. */
export class SparkPool {
  readonly mesh: InstancedMesh;
  readonly uT: { value: number };
  private cursor = 0;
  private readonly birth: InstancedBufferAttribute;
  private readonly kind: InstancedBufferAttribute;
  private readonly seed: InstancedBufferAttribute;
  private readonly pos: InstancedBufferAttribute;
  private readonly dir: InstancedBufferAttribute;

  constructor() {
    const n = VFX.sparkCount;
    this.birth = new InstancedBufferAttribute(new Float32Array(n).fill(DEAD), 1);
    this.kind = new InstancedBufferAttribute(new Float32Array(n), 1);
    this.seed = new InstancedBufferAttribute(new Float32Array(n), 1);
    this.pos = new InstancedBufferAttribute(new Float32Array(n * 3), 3);
    this.dir = new InstancedBufferAttribute(new Float32Array(n * 3), 3);

    const uT = uniform(0);
    this.uT = uT as unknown as { value: number };
    const aBirth = instancedBufferAttribute(this.birth, 'float') as unknown as Node<'float'>;
    const aKind = instancedBufferAttribute(this.kind, 'float') as unknown as Node<'float'>;
    const aSeed = instancedBufferAttribute(this.seed, 'float') as unknown as Node<'float'>;
    const aPos = instancedBufferAttribute(this.pos, 'vec3') as unknown as Node<'vec3'>;
    const aDir = instancedBufferAttribute(this.dir, 'vec3') as unknown as Node<'vec3'>;

    const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });

    const t = uT.sub(aBirth);
    const is1 = aKind.sub(1).abs().lessThan(0.5);
    const is2 = aKind.sub(2).abs().lessThan(0.5);
    const is3 = aKind.sub(3).abs().lessThan(0.5);
    const life = select(is1, float(0.12), select(is2, float(1.2), select(is3, float(0.9), float(0.35))));
    const k = clamp(t.div(life), 0, 1);
    const aliveN = select(t.greaterThanEqual(0).and(t.lessThan(life)), float(1), float(0));
    const phase = aSeed.mul(6.2832);

    // Trajectoires par kind : balistique / statique / montée / spirale aspirée
    const sparkPos = aPos.add(aDir.mul(t)).add(vec3(0, -4, 0).mul(t.mul(t)));
    const motePos = aPos.add(vec3(sin(t.mul(4).add(phase)).mul(0.25), t.mul(0.9), cos(t.mul(3.3).add(phase)).mul(0.25)));
    const swirlAng = phase.add(t.mul(6));
    const swirlR = oneMinus(k.mul(0.6)).mul(1.9);
    const debrisPos = aPos.add(vec3(sin(swirlAng).mul(swirlR), k.mul(3.2), cos(swirlAng).mul(swirlR)));
    m.positionNode = select(is1, aPos, select(is2, motePos, select(is3, debrisPos, sparkPos)));

    const sparkScale = float(0.12).mul(mix(0.7, 1.3, aSeed)).mul(oneMinus(k.mul(0.4)));
    const flashScale = float(0.35).add(k.mul(0.85));
    const moteScale = float(0.16).mul(mix(0.8, 1.2, aSeed));
    const s = select(is1, flashScale, select(is2, moteScale, select(is3, float(0.15), sparkScale)));
    m.scaleNode = vec2(s, s);
    m.rotationNode = phase;

    // Étoile 4 branches procédurale (formule SparkleField) + disque doux (flash)
    const q = uv().sub(0.5).mul(2);
    const core = smoothstep(0.05, 0.35, q.length()).oneMinus();
    const bladeV = smoothstep(0.0, 0.08, q.y.abs()).oneMinus().mul(smoothstep(0.1, 1.0, q.x.abs()).oneMinus());
    const bladeH = smoothstep(0.0, 0.08, q.x.abs()).oneMinus().mul(smoothstep(0.1, 1.0, q.y.abs()).oneMinus());
    const star = clamp(core.add(bladeV).add(bladeH), 0, 1);
    const disc = smoothstep(1.0, 0.25, q.length());
    const shape = select(is1, disc, star);

    const cSpark = color('#eafff7').mul(VFX.intensity.spark);
    const cFlash = color('#f0fff8').mul(VFX.intensity.flash);
    const cMote = color(PALETTE.elements.anemo).mul(VFX.intensity.mote);
    const cDebris = color('#cdeec2').mul(2.2);
    m.colorNode = select(is1, cFlash, select(is2, cMote, select(is3, cDebris, cSpark)));
    m.opacityNode = shape.mul(oneMinus(k)).mul(aliveN);

    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), m, n);
    this.mesh.geometry.setAttribute('aBirth', this.birth);
    this.mesh.geometry.setAttribute('aKind', this.kind);
    this.mesh.geometry.setAttribute('aSeed', this.seed);
    this.mesh.geometry.setAttribute('aPos', this.pos);
    this.mesh.geometry.setAttribute('aDir', this.dir);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 20;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** kind : 0 étincelle, 1 flash, 2 mote, 3 débris de tornade. */
  spawn(kind: number, x: number, y: number, z: number, dx = 0, dy = 0, dz = 0, seed = Math.abs(Math.sin(this.cursor * 12.9898)) % 1): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % VFX.sparkCount;
    (this.birth.array as Float32Array)[i] = this.uT.value;
    (this.kind.array as Float32Array)[i] = kind;
    (this.seed.array as Float32Array)[i] = seed;
    const p = this.pos.array as Float32Array;
    p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    const d = this.dir.array as Float32Array;
    d[i * 3] = dx; d[i * 3 + 1] = dy; d[i * 3 + 2] = dz;
    this.birth.needsUpdate = true;
    this.kind.needsUpdate = true;
    this.seed.needsUpdate = true;
    this.pos.needsUpdate = true;
    this.dir.needsUpdate = true;
  }
}

/** Quads ORIENTÉS (arcs de slash, anneaux d'onde de choc, télégraphes au sol).
 *  L'orientation vit dans l'instanceMatrix (composée CPU au spawn) ; la
 *  croissance GPU utilise l'attribut aPos (origine monde) car positionLocal
 *  est DÉJÀ en monde après l'instancing (piège M2). */
export class PlanePool {
  readonly mesh: InstancedMesh;
  readonly uT: { value: number };
  private cursor = 0;
  private readonly birth: InstancedBufferAttribute;
  private readonly kind: InstancedBufferAttribute;
  private readonly seed: InstancedBufferAttribute;
  private readonly pos: InstancedBufferAttribute;

  constructor() {
    const n = VFX.planeCount;
    this.birth = new InstancedBufferAttribute(new Float32Array(n).fill(DEAD), 1);
    this.kind = new InstancedBufferAttribute(new Float32Array(n), 1);
    this.seed = new InstancedBufferAttribute(new Float32Array(n), 1);
    this.pos = new InstancedBufferAttribute(new Float32Array(n * 3), 3);

    const uT = uniform(0);
    this.uT = uT as unknown as { value: number };
    const aBirth = instancedBufferAttribute(this.birth, 'float') as unknown as Node<'float'>;
    const aKind = instancedBufferAttribute(this.kind, 'float') as unknown as Node<'float'>;
    const aSeed = instancedBufferAttribute(this.seed, 'float') as unknown as Node<'float'>;
    const aPos = instancedBufferAttribute(this.pos, 'vec3') as unknown as Node<'vec3'>;

    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: AdditiveBlending });
    m.side = DoubleSide;

    const t = uT.sub(aBirth);
    const isRing = aKind.sub(1).abs().lessThan(0.5);
    const isTele = aKind.sub(2).abs().lessThan(0.5);
    const isSkill = aKind.sub(3).abs().lessThan(0.5);
    const life = select(isRing, float(0.5), select(isTele, float(0.6), select(isSkill, float(0.3), float(0.22))));
    const k = clamp(t.div(life), 0, 1);
    const aliveN = select(t.greaterThanEqual(0).and(t.lessThan(life)), float(1), float(0));

    // Croissance du quad autour de son origine monde (slash/skill seulement)
    const growth = select(isRing.or(isTele), float(1), float(1).add(k.mul(0.4)));
    m.positionNode = aPos.add(positionLocal.sub(aPos).mul(growth));

    const q = uv().sub(0.5).mul(2);
    const r = q.length();
    const cosAng = q.y.div(r.max(1e-4)); // 1 en haut du quad, −1 en bas

    // Croissant de slash : bande radiale × masque angulaire × érosion au bruit
    const rrSlash = mix(0.45, 0.62, k);
    const bandSlash = smoothstep(0.05, 0.17, r.sub(rrSlash).abs()).oneMinus();
    const angMask = smoothstep(-0.35, 0.35, cosAng);
    const erode = mx_noise_float(q.mul(6).add(aSeed.mul(37.7))).mul(k.mul(0.55));
    const slashShape = bandSlash.mul(angMask).sub(erode).max(0).mul(oneMinus(k).pow(2));

    // Anneau d'onde de choc en expansion
    const rrRing = k.mul(0.62);
    const ringShape = smoothstep(0.02, 0.09, r.sub(rrRing).abs()).oneMinus().mul(oneMinus(k));

    // Télégraphe : anneau or fixe pulsé
    const teleBand = smoothstep(0.03, 0.1, r.sub(0.42).abs()).oneMinus();
    const pulse = sin(t.mul(12).add(aSeed.mul(6.28))).mul(0.25).add(0.75);
    const teleShape = teleBand.mul(pulse).mul(oneMinus(k.mul(k)));

    const shape = select(isRing, ringShape, select(isTele, teleShape, slashShape));
    const cSlash = color('#d9fff1').mul(VFX.intensity.slash);
    const cRing = color('#eafff7').mul(VFX.intensity.ring);
    const cTele = color('#ffd257').mul(VFX.intensity.telegraph);
    const cSkill = color('#c8ffe9').mul(VFX.intensity.slash * 1.15);
    m.colorNode = select(isRing, cRing, select(isTele, cTele, select(isSkill, cSkill, cSlash)));
    m.opacityNode = shape.mul(aliveN);

    this.mesh = new InstancedMesh(new PlaneGeometry(1, 1), m, n);
    this.mesh.geometry.setAttribute('aBirth', this.birth);
    this.mesh.geometry.setAttribute('aKind', this.kind);
    this.mesh.geometry.setAttribute('aSeed', this.seed);
    this.mesh.geometry.setAttribute('aPos', this.pos);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 19;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
  }

  /** kind : 0 slash, 1 anneau, 2 télégraphe, 3 croissant du E. */
  spawn(kind: number, position: Vector3, quat: Quaternion, scale: number, seed = Math.abs(Math.sin(this.cursor * 78.233)) % 1): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % VFX.planeCount;
    _m.compose(position, quat, _s.setScalar(scale));
    this.mesh.setMatrixAt(i, _m);
    this.mesh.instanceMatrix.needsUpdate = true;
    (this.birth.array as Float32Array)[i] = this.uT.value;
    (this.kind.array as Float32Array)[i] = kind;
    (this.seed.array as Float32Array)[i] = seed;
    const p = this.pos.array as Float32Array;
    p[i * 3] = position.x; p[i * 3 + 1] = position.y; p[i * 3 + 2] = position.z;
    this.birth.needsUpdate = true;
    this.kind.needsUpdate = true;
    this.seed.needsUpdate = true;
    this.pos.needsUpdate = true;
  }
}

const _m = new Matrix4();
const _s = new Vector3();
