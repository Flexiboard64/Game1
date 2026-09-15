import {
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshToonNodeMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  Texture,
  Vector3,
} from 'three/webgpu';
import { color, mix, positionGeometry, smoothstep } from 'three/tsl';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { PALETTE, WINGS } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import { setEmissiveNode, toonRamp } from '../materials/tsl';
import { loadProp } from '../assets/PropLoader';
import type { CharacterController } from './CharacterController';

// « Aile de Givre » (M9) : vraie aile GLB Meshy (une aile GAUCHE générée, l'autre
// est son MIROIR — chaque côté a son pivot racine → battement articulé), albédo
// auto-émissif (glowProp → bloom sur les facettes claires), et pool CPU de
// plumes qui se détachent et tombent en flottant (pattern fumée du train :
// matrices réécrites/frame, pas d'attribut d'opacité — fondu par échelle).
// Repli intégral : voilures delta procédurales du M7 si le GLB est absent.

/** Épaisseur du profil (Y+Z) près d'une extrémité X — la racine est plus épaisse. */
function endThickness(g: BufferGeometry, xEnd: number, span: number): number {
  const pos = g.getAttribute('position');
  let minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i) - xEnd) > span * 0.12) continue;
    const y = pos.getY(i), z = pos.getZ(i);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return minY === Infinity ? 0 : (maxY - minY) + (maxZ - minZ);
}

/** Miroir X d'une géométrie (positions + normales via la normal matrix).
 *  Le winding s'inverse — le matériau des ailes est DoubleSide, sans incidence. */
function mirrorX(g: BufferGeometry): BufferGeometry {
  const m = g.clone();
  m.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
  return m;
}

/** Plumes détachées : pool d'instances monde (ajouté à la SCÈNE, pas au joueur). */
class FeatherPool {
  readonly mesh: InstancedMesh;
  private readonly dummy = new Object3D();
  private readonly age: Float32Array;
  private readonly base: Float32Array;  // x,y,z de spawn par plume
  private readonly drift: Float32Array; // vx,vz de dérive + phase
  private acc = 0;
  private next = 0;
  private flip = false; // alterne aile gauche/droite

  constructor() {
    const F = WINGS.feathers;
    // Quad effilé en silhouette de plume : rachis étroit en bas, ventre large
    // au tiers, pointe fine en haut (un rectangle nu lisait comme un confetti)
    const geom = new PlaneGeometry(F.sizeW, F.sizeL, 1, 6);
    const pos = geom.getAttribute('position');
    for (let i = 0; i < pos.count; i++) {
      const t = pos.getY(i) / F.sizeL + 0.5; // 0 rachis → 1 pointe
      pos.setX(i, pos.getX(i) * Math.sin(Math.PI * Math.min(1, t * 0.82 + 0.09)) ** 0.7);
    }
    const mat = new MeshToonNodeMaterial({ gradientMap: toonRamp() });
    // Rachis blanc → barbes cryo vers la pointe (gradient le long de la plume)
    mat.colorNode = mix(color('#f6fbff'), color(PALETTE.elements.cryo),
      smoothstep(-F.sizeL / 2, F.sizeL / 2, positionGeometry.y));
    setEmissiveNode(mat, color(PALETTE.elements.cryo).mul(0.28)); // lisible de nuit
    mat.side = DoubleSide;
    this.mesh = new InstancedMesh(geom, mat, F.pool);
    this.mesh.frustumCulled = false; // instances monde éparses, toujours compilé
    this.age = new Float32Array(F.pool).fill(Infinity);
    this.base = new Float32Array(F.pool * 3);
    this.drift = new Float32Array(F.pool * 3);
    // Toutes les instances démarrent à échelle 0 (visibles pour compileAsync,
    // aucun pixel dessiné)
    this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix();
    for (let i = 0; i < F.pool; i++) this.mesh.setMatrixAt(i, this.dummy.matrix);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Détache une plume au bout d'aile p (position MONDE). */
  spawn(p: Vector3): void {
    const F = WINGS.feathers;
    const i = this.next;
    this.next = (this.next + 1) % F.pool;
    this.age[i] = 0;
    this.base[i * 3] = p.x + (Math.random() - 0.5) * 0.24;
    this.base[i * 3 + 1] = p.y + (Math.random() - 0.5) * 0.12;
    this.base[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.24;
    this.drift[i * 3] = (Math.random() - 0.5) * 0.7;      // vx
    this.drift[i * 3 + 1] = (Math.random() - 0.5) * 0.7;  // vz
    this.drift[i * 3 + 2] = Math.random() * Math.PI * 2;  // phase de flottement
  }

  update(dt: number, gliding: boolean, climb01: number, tipL: Vector3, tipR: Vector3): void {
    const F = WINGS.feathers;
    if (gliding) {
      this.acc += (F.rateIdle + (F.rateClimb - F.rateIdle) * climb01) * dt;
      while (this.acc >= 1) {
        this.acc -= 1;
        this.flip = !this.flip;
        this.spawn(this.flip ? tipL : tipR);
      }
    } else {
      this.acc = 0;
    }
    const w = F.swayFreq;
    let dirty = false;
    for (let i = 0; i < F.pool; i++) {
      const a = this.age[i]!;
      if (a === Infinity) continue;
      dirty = true;
      const na = a + dt;
      const d = this.dummy;
      if (na >= F.lifeS) {
        this.age[i] = Infinity;
        d.scale.setScalar(0);
      } else {
        this.age[i] = na;
        const ph = this.drift[i * 3 + 2]!;
        // Chute feuille-morte : descente lente + va-et-vient latéral, la plume
        // se balance (roulis/tangage) en phase avec son propre glissement
        const sway = Math.sin(na * w + ph);
        d.position.set(
          this.base[i * 3]! + this.drift[i * 3]! * na + sway * F.swayAmp,
          this.base[i * 3 + 1]! - F.fallSpeed * na + Math.abs(Math.cos(na * w + ph)) * 0.1,
          this.base[i * 3 + 2]! + this.drift[i * 3 + 1]! * na + Math.cos(na * w * 0.7 + ph) * F.swayAmp * 0.6,
        );
        d.rotation.set(
          Math.cos(na * w * 0.8 + ph) * 0.6,
          ph + na * 0.6,
          sway * 0.9 + Math.PI / 2, // couchée : la plume plane, ne tombe pas en flèche
        );
        // Fondu d'échelle : pop-in 0,15 s, dissolution sur les 25 % finaux
        const inS = Math.min(1, na / 0.15);
        const outS = Math.min(1, (F.lifeS - na) / (F.lifeS * 0.25));
        d.scale.setScalar(inS * outS);
      }
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export class GliderWings {
  readonly group = new Group();
  private readonly pivots: { pivot: Group; side: number }[] = [];
  private readonly tipL = new Object3D();
  private readonly tipR = new Object3D();
  private readonly feathers: FeatherPool;
  private readonly tipWorldL = new Vector3();
  private readonly tipWorldR = new Vector3();
  private phase = 0;
  private t = 0;

  constructor(parent: Object3D, scene: Object3D, gltf: GLTF | null) {
    const built = gltf ? this.buildFromGltf(gltf) : false;
    if (!built) this.buildProcedural();

    // Nacelle centrale (cristal de givre) — discrète, nichée ENTRE les racines
    // (un gros orbe à 1,8 d'émissif faisait une boule de lumière sur la tête)
    const core = new Mesh(new SphereGeometry(0.05, 10, 8), ToonMaterials.lantern(PALETTE.elements.cryo, 1.2));
    core.position.set(0, 0.0, -0.07);
    this.group.add(core);

    this.group.position.set(0, WINGS.mount.y, WINGS.mount.z);
    this.group.visible = false;
    this.group.traverse((o) => {
      o.frustumCulled = false; // suit le modèle : compile au warmup si visible…
    });
    parent.add(this.group);

    this.feathers = new FeatherPool();
    scene.add(this.feathers.mesh); // les plumes vivent en espace MONDE
  }

  /** Vraie aile Meshy : normalisée envergure X, racine à l'origine, miroitée. */
  private buildFromGltf(gltf: GLTF): boolean {
    const lp = loadProp(gltf, { targetHeight: 1 });
    if (!lp) return false;
    const g = lp.geometry;
    g.computeBoundingBox();
    let size = g.boundingBox!.getSize(new Vector3());
    // L'envergure doit porter sur X (pré-rotation si le GLB sort l'aile en Z)
    if (size.z > size.x) {
      g.rotateY(Math.PI / 2);
      g.computeBoundingBox();
      size = g.boundingBox!.getSize(new Vector3());
    }
    const s = WINGS.span / size.x;
    g.scale(s, s, s);
    g.computeBoundingBox();
    let bb = g.boundingBox!;
    // La RACINE (épaulement, profil le plus épais) doit être côté origine :
    // si elle est à max.x on miroite — l'aile de base s'étend vers +X
    const span = bb.max.x - bb.min.x;
    if (endThickness(g, bb.max.x, span) > endThickness(g, bb.min.x, span)) {
      g.applyMatrix4(new Matrix4().makeScale(-1, 1, 1));
      g.computeBoundingBox();
      bb = g.boundingBox!;
    }
    g.translate(-bb.min.x + 0.02, -(bb.min.y + bb.max.y) / 2, -(bb.min.z + bb.max.z) / 2);

    const albedo = (lp.material.map ?? null) as Texture | null;
    const mat = ToonMaterials.glowProp(albedo, WINGS.glowTint, WINGS.glow);
    mat.side = DoubleSide; // le miroir inverse le winding — sans incidence ici

    for (const side of [-1, 1] as const) {
      const pivot = new Group();
      pivot.position.set(side * WINGS.rootGap, 0, 0);
      const wing = new Mesh(side === 1 ? g : mirrorX(g), mat);
      wing.castShadow = true;
      pivot.add(wing);
      const tip = side === 1 ? this.tipR : this.tipL;
      tip.position.set(side * WINGS.span * 0.8, 0, 0);
      pivot.add(tip);
      this.group.add(pivot);
      this.pivots.push({ pivot, side });
    }
    return true;
  }

  /** Repli M7 : voilures delta procédurales (mêmes pivots → même battement). */
  private buildProcedural(): void {
    const ramp = toonRamp();
    const wingMat = new MeshToonNodeMaterial({ gradientMap: ramp });
    // Dégradé le long de l'envergure (géométrie X) : racine blanche → bout cryo
    const spanT = smoothstep(-1.4, 1.4, positionGeometry.x).sub(0.5).abs().mul(2);
    wingMat.colorNode = mix(color('#f2f8ff'), color(PALETTE.elements.cryo), spanT);
    wingMat.side = DoubleSide;

    for (const side of [-1, 1] as const) {
      const pivot = new Group();
      pivot.position.set(side * WINGS.rootGap, 0, 0);
      const wing = new Mesh(new BoxGeometry(1.5, 0.045, 0.55), wingMat);
      wing.position.set(side * 0.66, 0, -0.1);
      wing.castShadow = true;
      pivot.add(wing);
      // Arête avant dorée émissive (signature Genshin, ≥1,5 → bloom)
      const edge = new Mesh(new BoxGeometry(1.46, 0.05, 0.05), ToonMaterials.lantern(PALETTE.gold, 1.7));
      edge.position.set(side * 0.66, 0.012, 0.17);
      pivot.add(edge);
      const tip = side === 1 ? this.tipR : this.tipL;
      tip.position.set(side * 1.3, 0, 0);
      pivot.add(tip);
      this.group.add(pivot);
      this.pivots.push({ pivot, side });
    }
  }

  /** À appeler chaque frame de rendu (après renderPosition du modèle). */
  update(dt: number, player: CharacterController): void {
    const gliding = player.mode === 'glide';
    if (gliding !== this.group.visible) this.group.visible = gliding;
    const v = player.glideVert; // −1 piqué … +1 montée (lissé côté contrôleur)
    const climb01 = Math.max(0, v);
    if (gliding) {
      this.t += dt;
      const F = WINGS.flap;
      // Fréquence variable → PHASE intégrée (sinon le sinus « saute » quand la
      // fréquence change) : battement franc en montée, ondulation douce sinon
      const freq = F.idleFreq + (F.climbFreq - F.idleFreq) * climb01;
      this.phase += freq * Math.PI * 2 * dt;
      const amp = F.idleAmp + (F.climbAmp - F.idleAmp) * climb01;
      const flap = Math.sin(this.phase) * amp;
      const sweep = WINGS.sweepRad + Math.max(0, -v) * F.diveSweep; // plaquées au piqué
      for (const { pivot, side } of this.pivots) {
        pivot.rotation.z = side * (WINGS.dihedralRad + flap);
        pivot.rotation.y = -side * sweep;
      }
      // Assiette : cabrée en montée, piquée au piqué, respiration légère
      this.group.rotation.x = -0.12 - v * 0.22 + Math.sin(this.t * 1.1) * 0.03;
      this.group.rotation.z = Math.sin(this.t * 1.7) * 0.05;
      this.tipL.getWorldPosition(this.tipWorldL);
      this.tipR.getWorldPosition(this.tipWorldR);
    }
    this.feathers.update(dt, gliding, climb01, this.tipWorldL, this.tipWorldR);
  }
}
