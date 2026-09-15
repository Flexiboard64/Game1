import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three/webgpu';
import { RAIL, TRAIN } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import { loadProp } from '../assets/PropLoader';
import type { TrainAssets } from '../core/AssetManager';
import type { Updatable } from '../core/Engine';
import type { TrackSpec, TrackPose } from '../world/TrackSpec';

// Le train (M5) : navette continue gare Vallée ↔ gare Neige. Profil de vitesse
// trapézoïdal, caisses articulées posées par CORDE DE BOGIES (chaque caisse
// suit la courbe à son propre s), transform de rendu interpolée entre les deux
// derniers pas fixes (même alpha que le joueur — zéro nage à bord), fumée de
// cheminée en pool CPU, bandeaux de fenêtres émissifs (contrat bloom ≥ 1,5).

interface CarSpec {
  root: Group;
  /** Distance du CENTRE de la caisse à l'avant du convoi (m). */
  centerOffset: number;
  len: number;
  halfW: number;
  height: number;
  /** Coquille GLB (masquée quand le joueur est À BORD de cette caisse). */
  shell: Mesh | null;
}

interface SmokeParticle {
  x: number;
  y: number;
  z: number;
  /** Dérive horizontale propre à la bouffée (casse la « corde » rectiligne). */
  vx: number;
  vz: number;
  age: number;
  live: boolean;
}

export type StationName = 'valley' | 'snow' | 'city';

/** Ordre des arrêts sur la ligne (navette ping-pong M6). */
const STOPS: readonly StationName[] = ['valley', 'snow', 'city'];

export class TrainSystem implements Updatable {
  readonly group = new Group();
  /** État de la navette — 'dwell' = à quai (embarquement possible). */
  state: 'run' | 'dwell' = 'dwell';
  target: StationName = 'valley';
  onArrive: ((station: StationName) => void) | null = null;
  onDepart: ((to: StationName) => void) | null = null;

  private readonly cars: CarSpec[] = [];
  private sHead = 0;
  private prevSHead = 0;
  private v = 0;
  private dwellT = 0;
  private routeDir: 1 | -1 = 1;
  private introWait = TRAIN.introDelayS;
  private intro = true;
  private tunnelFlag = false;
  /** Longueur avant→centre de la voiture 1 (alignement porte/quai). */
  private coachCenterOffset = 0;
  private coachHalfW = 1.2;
  private coachLen = 8;
  private coachHeight: number = TRAIN.carHeight;

  private readonly smoke: SmokeParticle[] = [];
  private readonly smokeMesh: InstancedMesh;
  private smokeAcc = 0;

  constructor(private readonly track: TrackSpec, assets: TrainAssets) {
    // ---- Caisses : GLB Meshy normalisés (repli boxes toon si absents) ----
    const loco = this.buildCar(assets, 'loco');
    let offset = loco.len / 2;
    loco.centerOffset = offset;
    offset += loco.len / 2;
    this.cars.push(loco);
    for (let i = 0; i < TRAIN.coachCount; i++) {
      const car = this.buildCar(assets, 'car');
      offset += TRAIN.coupling + car.len / 2;
      car.centerOffset = offset;
      offset += car.len / 2;
      this.cars.push(car);
      if (i === 0) {
        this.coachCenterOffset = car.centerOffset;
        this.coachHalfW = car.halfW;
        this.coachLen = car.len;
        this.coachHeight = car.height;
      }
    }
    for (const c of this.cars) this.group.add(c.root);

    // ---- Fumée : BOULES toon instanciées (pas de sprites — SpriteNodeMaterial
    // instancié ignore les matrices d'instance, la fumée était invisible) ----
    this.smokeMesh = new InstancedMesh(
      new SphereGeometry(1, 10, 8),
      ToonMaterials.smokePuff(),
      TRAIN.smoke.count,
    );
    for (let i = 0; i < TRAIN.smoke.count; i++) {
      this.smoke.push({ x: 0, y: 0, z: 0, vx: 0, vz: 0, age: 0, live: false });
      this.smokeMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
    }
    this.smokeMesh.castShadow = false;
    this.smokeMesh.receiveShadow = false;
    this.group.add(this.smokeMesh);

    // Le train bouge en permanence : jamais de culling (et compile au warmup)
    this.group.traverse((o) => {
      o.frustumCulled = false;
    });

    // ---- Position de boot : convoi complet à l'est (heurtoir), intro vers la gare ----
    this.sHead = offset + 2.5;
    this.prevSHead = this.sHead;
    this.state = 'run';
    this.target = 'valley';
    this.poseCars(this.sHead);
  }

  /** sHead d'arrêt pour qu'une gare soit alignée sur la VOITURE 1 (porte/quai). */
  private stopS(station: StationName): number {
    const sStation =
      station === 'valley' ? this.track.sValley : station === 'snow' ? this.track.sSnow : this.track.sCity;
    return sStation + this.coachCenterOffset;
  }

  /** Prochain arrêt (lecture PURE — affiché au prompt d'embarquement). */
  get nextTarget(): StationName {
    const i = STOPS.indexOf(this.target);
    const dir = i >= STOPS.length - 1 ? -1 : i <= 0 ? 1 : this.routeDir;
    return STOPS[i + dir]!;
  }

  /** Arrêt suivant sur la ligne (ping-pong aux terminus). */
  private nextStation(): StationName {
    const i = STOPS.indexOf(this.target);
    if (i >= STOPS.length - 1) this.routeDir = -1;
    else if (i <= 0) this.routeDir = 1;
    return STOPS[i + this.routeDir]!;
  }

  /** Pose monde 60 Hz de la voiture du joueur (PlayerFrame — task frame). */
  coachPose(out: TrackPose): TrackPose {
    return this.poseCarAt(this.sHead - this.coachCenterOffset, out);
  }

  /** Pose interpolée de la voiture du joueur (rendu). */
  coachRenderPose(alpha: number, out: TrackPose): TrackPose {
    const s = this.prevSHead + (this.sHead - this.prevSHead) * alpha;
    return this.poseCarAt(s - this.coachCenterOffset, out);
  }

  get coachInteriorHalfW(): number {
    return Math.max(this.coachHalfW - 0.35, 0.8);
  }

  get coachInteriorHalfL(): number {
    return Math.max(this.coachLen / 2 - 0.8, 2.2);
  }

  get coachFloorY(): number {
    return this.coachHeight * 0.28; // plancher au-dessus des bogies
  }

  get coachCeilY(): number {
    return this.coachHeight * 0.92;
  }

  get moving(): boolean {
    return this.state === 'run' && this.v > 0.1;
  }

  /** Vitesse curviligne courante (m/s) — lecture audio/HUD. */
  get speed(): number {
    return Math.abs(this.v);
  }

  /** La tête du convoi est dans le tube du tunnel (lowpass audio). */
  get inTunnel(): boolean {
    return this.tunnelFlag;
  }

  /** Root de la voiture du joueur (parent de l'intérieur procédural). */
  get coachRoot(): Group {
    return (this.cars[1] ?? this.cars[0])!.root;
  }

  /**
   * Mode intérieur (joueur à bord) : la coquille GLB de la voiture est masquée —
   * elle est single/double-side sombre vue de l'intérieur et boucherait la vue
   * par les fenêtres ; l'habillage procédural (WagonInterior) prend le relais.
   */
  setCoachInteriorMode(aboard: boolean): void {
    const coach = this.cars[1] ?? this.cars[0];
    if (coach?.shell) coach.shell.visible = !aboard;
  }

  /**
   * Distance à la caisse la plus proche de (x,z) ; `outAway` reçoit la
   * direction horizontale normalisée caisse→point (poussée de sécurité).
   */
  nearestCar(x: number, z: number, outAway: Vector3): number {
    let best = Infinity;
    for (const c of this.cars) {
      const dx = x - c.root.position.x;
      const dz = z - c.root.position.z;
      const d = Math.hypot(dx, dz);
      if (d < best) {
        best = d;
        outAway.set(d > 1e-4 ? dx / d : 1, 0, d > 1e-4 ? dz / d : 0);
      }
    }
    return best;
  }

  // ---- Simulation ----

  fixedUpdate(dt: number): void {
    this.prevSHead = this.sHead;

    if (this.intro) {
      this.introWait -= dt;
      if (this.introWait > 0) return;
    }

    if (this.state === 'dwell') {
      this.dwellT -= dt;
      if (this.dwellT <= 0) {
        this.target = this.nextStation();
        this.state = 'run';
        this.onDepart?.(this.target);
        console.info(`[Train] depart ${this.target}`);
      }
      return;
    }

    // Trapèze : accélère vers vMax, freine quand la distance restante l'exige
    const sTarget = this.stopS(this.target);
    const remaining = sTarget - this.sHead;
    const dir = Math.sign(remaining) || 1;
    const brakeDist = (this.v * this.v) / (2 * TRAIN.accel);
    if (Math.abs(remaining) <= brakeDist + 0.3) {
      this.v = Math.max(this.v - TRAIN.accel * dt, 1.4);
    } else {
      this.v = Math.min(this.v + TRAIN.accel * dt, TRAIN.vMax);
    }
    this.sHead += dir * this.v * dt;

    // Canaris tunnel (front du convoi)
    const inTunnel = this.sHead > this.track.sPortal && this.sHead - this.coachCenterOffset < this.track.sTubeExit;
    if (inTunnel !== this.tunnelFlag) {
      this.tunnelFlag = inTunnel;
      console.info(`[Train] ${inTunnel ? 'tunnel-enter' : 'tunnel-exit'}`);
    }

    // Arrivée : snap + attente
    if ((dir > 0 && this.sHead >= sTarget) || (dir < 0 && this.sHead <= sTarget)) {
      this.sHead = sTarget;
      this.v = 0;
      this.state = 'dwell';
      this.dwellT = TRAIN.dwellS;
      const at = this.target;
      if (this.intro) this.intro = false;
      this.onArrive?.(at);
      console.info(`[Train] arrive ${at}`);
    }
  }

  // ---- Rendu ----

  update(dt: number, alpha: number): void {
    const s = this.prevSHead + (this.sHead - this.prevSHead) * alpha;
    this.poseCars(s);
    this.updateSmoke(dt, s);
  }

  private poseCars(sHead: number): void {
    for (const c of this.cars) {
      this.poseCarAt(sHead - c.centerOffset, _pose);
      c.root.position.set(_pose.x, _pose.y, _pose.z);
      c.root.rotation.set(0, _pose.yaw, 0);
    }
  }

  /** Pose par corde de bogies : milieu des deux appuis, yaw de la corde. */
  private poseCarAt(sCenter: number, out: TrackPose): TrackPose {
    const b = TRAIN.wheelbaseHalf;
    this.track.pose(sCenter + b, _pa);
    this.track.pose(sCenter - b, _pb);
    out.x = (_pa.x + _pb.x) / 2;
    out.y = Math.min(_pa.y, _pb.y) + RAIL.sleeper.h + RAIL.railH;
    out.z = (_pa.z + _pb.z) / 2;
    out.yaw = Math.atan2(_pa.x - _pb.x, _pa.z - _pb.z);
    out.pitch = 0; // caisses yaw-only (repère du joueur assorti)
    return out;
  }

  private updateSmoke(dt: number, sHead: number): void {
    const cfg = TRAIN.smoke;
    // Émission depuis la cheminée de la loco (plus dense en roulant)
    const loco = this.cars[0]!;
    const running = this.state === 'run' && this.v > 0.5;
    this.smokeAcc += dt;
    const rate = running ? cfg.rate : cfg.rate * 3.5;
    if (this.smokeAcc >= rate) {
      this.smokeAcc = 0;
      const p = this.smoke.find((sp) => !sp.live);
      if (p) {
        this.poseCarAt(sHead - loco.centerOffset, _pose);
        const fwdX = Math.sin(_pose.yaw);
        const fwdZ = Math.cos(_pose.yaw);
        p.x = _pose.x + fwdX * loco.len * cfg.chimney.back + (Math.random() - 0.5) * 0.3;
        p.y = _pose.y + loco.height * cfg.chimney.up;
        p.z = _pose.z + fwdZ * loco.len * cfg.chimney.back + (Math.random() - 0.5) * 0.3;
        // Dérive propre à la bouffée : vent léger + dispersion aléatoire
        p.vx = cfg.drift * 0.5 + (Math.random() - 0.5) * 0.8;
        p.vz = cfg.drift * 0.25 + (Math.random() - 0.5) * 0.8;
        p.age = 0;
        p.live = true;
      }
    }
    // Vie des particules : montée + dérive + gonflement puis résorption
    for (let i = 0; i < this.smoke.length; i++) {
      const p = this.smoke[i]!;
      if (!p.live) {
        this.smokeMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      p.age += dt;
      if (p.age >= cfg.life) {
        p.live = false;
        this.smokeMesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      const t = p.age / cfg.life;
      p.y += cfg.rise * dt;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      // Gonfle sur 70 % de la vie puis se résorbe (pas d'attribut d'opacité)
      const grow = Math.min(t / 0.7, 1);
      const shrink = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      const size = (cfg.size0 + (cfg.size1 - cfg.size0) * grow) * shrink;
      _p.set(p.x, p.y, p.z);
      _m.compose(_p, _qi, _s3.set(size, size, size));
      this.smokeMesh.setMatrixAt(i, _m);
    }
    this.smokeMesh.instanceMatrix.needsUpdate = true;
  }

  // ---- Construction des caisses ----

  private buildCar(assets: TrainAssets, kind: 'loco' | 'car'): CarSpec {
    const root = new Group();
    const gltf = kind === 'loco' ? assets.loco : assets.car;
    const targetH = kind === 'loco' ? TRAIN.locoHeight : TRAIN.carHeight;
    let len = kind === 'loco' ? 9 : 8.5;
    let halfW = 1.35;

    let shell: Mesh | null = null;
    const prop = gltf ? loadProp(gltf, { targetHeight: targetH }) : null;
    if (prop) {
      // Axe long attendu le long de Z (tangente de la voie) : pré-rotation si besoin
      prop.geometry.computeBoundingBox();
      const size = prop.geometry.boundingBox!.getSize(_p);
      if (size.x > size.z) {
        prop.geometry.rotateY(Math.PI / 2);
        prop.geometry.computeBoundingBox();
        prop.geometry.boundingBox!.getSize(size);
      }
      const yawFix = kind === 'loco' ? TRAIN.locoYaw : TRAIN.carYaw;
      if (yawFix !== 0) prop.geometry.rotateY(yawFix);
      len = size.z;
      halfW = size.x / 2;
      const mesh = new Mesh(prop.geometry, prop.material);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      root.add(mesh);
      shell = mesh;
    } else {
      // Repli procédural : caisse rouge sombre + toit — le jeu ne crashe jamais
      console.warn(`[Train] GLB ${kind} absent — caisse procédurale de secours`);
      len = kind === 'loco' ? 8.5 : 8;
      halfW = 1.3;
      const body = new Mesh(new BoxGeometry(halfW * 2, targetH * 0.62, len), ToonMaterials.prop(null));
      body.position.y = targetH * 0.5;
      body.castShadow = true;
      root.add(body);
      const roof = new Mesh(new BoxGeometry(halfW * 2.1, targetH * 0.14, len * 1.02), ToonMaterials.railWood());
      roof.position.y = targetH * 0.88;
      root.add(roof);
    }

    // Bandeaux de fenêtres émissifs UNIQUEMENT en repli procédural (le GLB
    // Meshy embarque déjà des fenêtres peintes allumées — un bandeau plaqué
    // par-dessus éblouissait et bouchait la vue) / lanterne frontale (loco)
    if (kind === 'car' && !prop) {
      const band = new BoxGeometry(0.04, TRAIN.windowBandH, len * TRAIN.windowLenFrac);
      const mat = ToonMaterials.lantern(TRAIN.windowColor, TRAIN.windowIntensity);
      for (const side of [-1, 1]) {
        const strip = new Mesh(band, mat);
        strip.position.set(side * (halfW + 0.02), targetH * TRAIN.windowYFrac, 0);
        root.add(strip);
      }
    } else if (kind === 'loco') {
      const lamp = new Mesh(
        new BoxGeometry(0.4, 0.4, 0.2),
        ToonMaterials.lantern('#fff2c8', TRAIN.headlampIntensity),
      );
      lamp.position.set(0, targetH * 0.62, len / 2 + 0.08);
      root.add(lamp);
    }

    return { root, centerOffset: 0, len, halfW, height: targetH, shell };
  }
}

const _pose: TrackPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const _pa: TrackPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const _pb: TrackPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const _p = new Vector3();
const _m = new Matrix4();
const _qi = new Quaternion();
const _s3 = new Vector3();
