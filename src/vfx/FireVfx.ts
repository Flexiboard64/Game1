import {
  AdditiveBlending,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  SpriteNodeMaterial,
  Vector3,
} from 'three/webgpu';
import {
  color,
  cos,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { FIRE } from '../config';
import type { SwordMount } from '../combat/SwordMount';

// Feux animés (M10) : vraies flammes procédurales 100 % GPU — cônes ouverts de
// bruit défilant à langues effilochées (pattern TornadoVfx : FrontSide additif,
// JAMAIS DoubleSide qui double l'accumulation) + braises instanciées en hélice
// (pattern WindColumns : SpriteNodeMaterial + positionNode par instanceIndex,
// en espace LOCAL — la matrice modèle du groupe s'applique, prouvé dans la
// source r185). L'apparition passe par un uniform uActive (les meshes restent
// visibles + frustumCulled=false → tout compile au warmup, zéro à-coup au
// premier allumage). Discipline d'exposition M7.2 : couleurs additives ≤ ~1,6.

export class FireVfx {
  readonly group = new Group();
  private readonly uActive: { value: number };
  private target = 0;

  constructor(scale = 1, startActive = false) {
    const F = FIRE.flame;
    const uActive = uniform(startActive ? 1 : 0);
    this.uActive = uActive as unknown as { value: number };
    this.target = startActive ? 1 : 0;

    const makeCone = (s: number, spinSign: number, alpha: number, inner: boolean): Mesh => {
      const h = F.height * (inner ? 0.82 : 1);
      const g = new CylinderGeometry(F.rTop * s, F.rBot * s, h, 16, 6, true);
      g.translate(0, h / 2, 0);
      const m = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        fog: false,
      });
      // uv.x = tour complet, uv.y = hauteur — le bruit MONTE en tournant doucement
      const n = mx_noise_float(vec2(
        uv().x.mul(inner ? 4 : 3).add(time.mul(F.spin * spinSign)),
        uv().y.mul(2.2).sub(time.mul(F.riseSpeed * (inner ? 1.35 : 1))),
      )).mul(0.5).add(0.5);
      const t = uv().y;
      // Ligne de sommet DÉPLACÉE par le bruit : plein en bas, langues qui
      // lèchent et se détachent au sommet — c'est ça qui « fait feu »
      const ragged = t.add(n.sub(0.5).mul(0.7));
      const profile = smoothstep(1.0, inner ? 0.3 : 0.45, ragged);
      const baseFade = smoothstep(0.0, 0.12, t);
      const band = smoothstep(0.3, 0.85, n);
      const heat = smoothstep(0.95, 0.1, ragged);
      const base = mix(color(F.colBase), color(F.colTip), heat);
      m.colorNode = (inner ? mix(base, color(F.colCore), heat.mul(0.8)) : base)
        .mul(band.mul(F.coreBoost - 1).add(1));
      m.opacityNode = profile.mul(baseFade).mul(band.mul(0.5).add(0.5)).mul(uActive).mul(alpha);
      const mesh = new Mesh(g, m);
      mesh.frustumCulled = false; // compile au warmup + apparition par uniform
      mesh.renderOrder = 18;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    };
    this.group.add(makeCone(1, 1, F.alphaOuter, false));
    this.group.add(makeCone(F.innerScale, -1.6, F.alphaInner, true));

    // ---- Braises : hélice ascendante, position 100 % TSL en espace local ----
    const E = FIRE.embers;
    const m = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    const hh = (k: number) => hash(instanceIndex.add(k));
    const period = mix(float(E.riseS * 0.6), float(E.riseS * 1.5), hh(1));
    const yF = fract(hh(0).add(time.div(period)));
    const ang = hh(3).mul(6.2832).add(time.mul(mix(float(0.8), float(2.2), hh(4))));
    // Rayon qui CONVERGE en montant (les braises naissent au bord de la vasque)
    const r = mix(float(0.05), float(FIRE.flame.rBot * 0.95), hh(2)).mul(yF.mul(0.55).oneMinus());
    const sway = sin(time.mul(1.9).add(hh(5).mul(6.2832))).mul(E.drift).mul(yF);
    m.positionNode = vec3(
      cos(ang).mul(r).add(sway),
      yF.mul(E.height).add(FIRE.flame.height * 0.3),
      sin(ang).mul(r).add(cos(time.mul(1.4).add(hh(6).mul(6.2832))).mul(E.drift * 0.6).mul(yF)),
    );
    const size = mix(float(E.sizeMin), float(E.sizeMax), hh(7)).mul(yF.mul(0.6).oneMinus());
    m.scaleNode = vec2(size, size);
    const p = uv().sub(0.5);
    const disc = smoothstep(0.5, 0.16, p.length());
    const fadeEnds = smoothstep(0.0, 0.08, yF).mul(smoothstep(0.72, 1.0, yF).oneMinus());
    m.colorNode = mix(color('#ffd27a'), color('#ff3c00'), yF).mul(E.intensity);
    m.opacityNode = disc.mul(fadeEnds).mul(uActive);
    const embers = new InstancedMesh(new PlaneGeometry(1, 1), m, E.count);
    embers.frustumCulled = false;
    embers.castShadow = false;
    embers.receiveShadow = false;
    embers.renderOrder = 19;
    this.group.add(embers);

    this.group.scale.setScalar(scale);
  }

  setActive(on: boolean): void {
    this.target = on ? 1 : 0;
  }

  get active(): boolean {
    return this.target > 0;
  }

  update(dt: number): void {
    const k = dt / FIRE.fadeS;
    this.uActive.value = Math.min(1, Math.max(0, this.uActive.value + (this.target > 0 ? k : -k)));
  }
}

// ---------------------------------------------------------------------------

const _hilt = new Vector3();
const _tip = new Vector3();
const _dir = new Vector3();
const _down = new Vector3(0, -1, 0);

/**
 * Lame embrasée (infusion Pyro) : groupe MONDE réorienté chaque frame sur l'os
 * réel de la lame (sampleBlade — pattern SwordTrail, toujours juste quelle que
 * soit la trajectoire du clip). Deux plans croisés le long de la lame (le roulis
 * autour de l'axe est indifférent) + braises locales : elles suivent l'épée
 * rigidement et lisent comme des étincelles arrachées au fil.
 */
export class SwordFireVfx {
  readonly group = new Group();
  private readonly uActive: { value: number };
  private target = 0;

  constructor(private readonly sword: SwordMount) {
    const S = FIRE.sword;
    const F = FIRE.flame;
    const uActive = uniform(0);
    this.uActive = uActive as unknown as { value: number };

    // Plans en espace unité : y ∈ [−1, 0] (0 = garde, −1 = pointe + débord) —
    // le groupe est scalé à la longueur réelle de lame chaque frame
    const makePlane = (yawRad: number): Mesh => {
      const g = new PlaneGeometry(S.width, 1);
      g.translate(0, -0.5, 0);
      const m = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        fog: false,
      });
      // v : 0 = pointe (bas du quad), 1 = garde ; u : travers de lame
      const v = uv().y;
      const u = uv().x;
      const edge = u.sub(0.5).abs().mul(2);
      const n = mx_noise_float(vec2(
        v.mul(S.noiseFreq).add(time.mul(S.riseSpeed)), // les langues filent vers la POINTE
        u.mul(3.1).add(time.mul(0.7)),
      )).mul(0.5).add(0.5);
      // Langues latérales effilochées + tongues détachées au-delà de la pointe
      const tongues = smoothstep(1.0, 0.25, edge.add(n.sub(0.5).mul(0.9)));
      const tipRagged = smoothstep(0.0, 0.16, v.add(n.sub(0.5).mul(0.28)));
      const hiltFade = smoothstep(1.0, 0.88, v);
      const heat = edge.oneMinus().mul(n.mul(0.5).add(0.5));
      const base = mix(color(F.colBase), color(F.colTip), heat);
      m.colorNode = mix(base, color(F.colCore), smoothstep(0.45, 0.95, heat))
        .mul(n.mul(S.coreBoost - 1).add(1));
      m.opacityNode = tongues.mul(tipRagged).mul(hiltFade).mul(uActive).mul(S.alpha);
      const mesh = new Mesh(g, m);
      mesh.rotation.y = yawRad;
      mesh.frustumCulled = false; // suit un os + compile au warmup
      mesh.renderOrder = 21;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      return mesh;
    };
    this.group.add(makePlane(0));
    this.group.add(makePlane(Math.PI / 2));

    // Braises locales : accrochées le long de la lame, soufflées en spirale
    const m = new SpriteNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    const hh = (k: number) => hash(instanceIndex.add(k));
    const life = fract(hh(0).add(time.div(mix(float(S.emberRiseS * 0.7), float(S.emberRiseS * 1.4), hh(1)))));
    const along = hh(2); // point d'attache 0..1 le long de la lame
    const a2 = hh(3).mul(6.2832).add(time.mul(3.2));
    const d = life.mul(S.emberR);
    m.positionNode = vec3(
      cos(a2).mul(d),
      along.negate().add(life.mul(0.14)),
      sin(a2).mul(d),
    );
    const size = mix(float(S.emberSize * 0.6), float(S.emberSize), hh(7)).mul(life.mul(0.7).oneMinus());
    m.scaleNode = vec2(size, size);
    const p = uv().sub(0.5);
    const disc = smoothstep(0.5, 0.16, p.length());
    const fadeEnds = smoothstep(0.0, 0.1, life).mul(smoothstep(0.7, 1.0, life).oneMinus());
    m.colorNode = mix(color('#ffe09a'), color('#ff4a10'), life).mul(1.5);
    m.opacityNode = disc.mul(fadeEnds).mul(uActive);
    const embers = new InstancedMesh(new PlaneGeometry(1, 1), m, S.emberCount);
    embers.frustumCulled = false;
    embers.castShadow = false;
    embers.receiveShadow = false;
    embers.renderOrder = 21;
    this.group.add(embers);
  }

  setActive(on: boolean): void {
    this.target = on ? 1 : 0;
  }

  update(dt: number): void {
    const k = dt / 0.25; // accroche/décroche vive (l'infusion est un événement)
    this.uActive.value = Math.min(1, Math.max(0, this.uActive.value + (this.target > 0 ? k : -k)));
    if (this.uActive.value <= 0) return;
    if (!this.sword.sampleBlade(_hilt, _tip)) return;
    _dir.subVectors(_tip, _hilt);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.divideScalar(len);
    this.group.position.copy(_hilt);
    this.group.quaternion.setFromUnitVectors(_down, _dir);
    this.group.scale.set(1, len + FIRE.sword.overshoot, 1);
  }
}
