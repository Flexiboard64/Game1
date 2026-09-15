import { PerspectiveCamera, Vector3 } from 'three/webgpu';
import { CAMERA } from '../config';
import type { InputManager } from '../core/InputManager';
import type { Updatable } from '../core/Engine';
import type { CameraGround } from '../world/GroundSource';
import type { CharacterController } from './CharacterController';

/** Fourni par le train à l'embarquement : pose du wagon + AABB intérieur. */
export interface CameraInterior {
  renderYaw(alpha: number): number;
  renderOrigin(alpha: number, out: Vector3): Vector3;
  readonly halfW: number;
  readonly halfL: number;
  readonly ceilY: number;
}

// Caméra orbitale 3e personne : yaw/pitch directs (feel réactif), distance et
// cible amorties exponentiellement. Position caméra :
//   target + (sin yaw · cos pitch, sin pitch, cos yaw · cos pitch) · distance
// → le forward projeté XZ utilisé par le contrôleur vaut (-sin yaw, -cos yaw).

export class ThirdPersonCamera implements Updatable {
  yaw = Math.PI; // dos au spawn : le personnage regarde +Z... caméra derrière lui
  pitch = 0.32;
  private targetDistance: number = CAMERA.defaultDistance;
  private distance: number = CAMERA.defaultDistance;
  private collisionDist: number = CAMERA.maxDistance;
  private readonly smoothedTarget = new Vector3();
  // M5 : à bord du wagon, le lissage de cible se fait en espace LOCAL (sinon le
  // pivot traîne de v/posDamping ≈ 1 m vers l'arrière du wagon à 12 m/s)
  private interior: CameraInterior | null = null;
  private readonly smoothedLocal = new Vector3();

  /** Embarquement/débarquement : bascule les sondes terrain ↔ AABB du wagon. */
  setInterior(provider: CameraInterior | null): void {
    this.interior = provider;
    if (provider) {
      // Re-seed du lissage local sur la position locale courante du joueur
      this.player.renderLocalPosition(1, this.smoothedLocal);
      this.smoothedLocal.y += CAMERA.pivotHeight * 0.82; // pivot sous le plafond
      this.targetDistance = Math.min(this.targetDistance, 3.4); // cadrage wagon
    } else {
      this.player.renderPosition(1, this.smoothedTarget);
      this.smoothedTarget.y += CAMERA.pivotHeight;
      this.collisionDist = CAMERA.maxDistance;
    }
  }

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly input: InputManager,
    private readonly player: CharacterController,
    private readonly ground: CameraGround,
  ) {
    this.smoothedTarget.copy(player.position).y += CAMERA.pivotHeight;
    this.applyTransform(0);
  }

  update(dt: number, alpha = 1): void {
    if (this.input.pointerLocked) {
      const { dx, dy } = this.input.consumeMouseDelta();
      this.yaw -= dx * CAMERA.sensitivity;
      this.pitch = Math.min(
        Math.max(this.pitch + dy * CAMERA.sensitivity, CAMERA.minPitch),
        CAMERA.maxPitch,
      );
      const wheel = this.input.consumeWheelDelta();
      this.targetDistance = Math.min(
        Math.max(this.targetDistance + wheel * CAMERA.zoomSpeed, CAMERA.minDistance),
        CAMERA.maxDistance,
      );
    } else {
      this.input.consumeMouseDelta();
      this.input.consumeWheelDelta();
    }

    // Amortissements exponentiels (indépendants du framerate)
    const kPos = 1 - Math.exp(-CAMERA.posDamping * dt);
    const kRot = 1 - Math.exp(-CAMERA.rotDamping * dt);

    if (this.interior) {
      // Lissage en espace LOCAL wagon puis composition par la pose interpolée
      this.player.renderLocalPosition(alpha, _pivot);
      _pivot.y += CAMERA.pivotHeight * 0.82;
      this.smoothedLocal.lerp(_pivot, kPos);
      const th = this.interior.renderYaw(alpha);
      this.interior.renderOrigin(alpha, _origin);
      const c = Math.cos(th);
      const s = Math.sin(th);
      this.smoothedTarget.set(
        _origin.x + c * this.smoothedLocal.x + s * this.smoothedLocal.z,
        _origin.y + this.smoothedLocal.y,
        _origin.z - s * this.smoothedLocal.x + c * this.smoothedLocal.z,
      );
      this.distance += (this.targetDistance - this.distance) * kRot;
      this.applyInteriorTransform(th, _origin);
      return;
    }

    // Cible = position visuelle interpolée (même état que le modèle rendu),
    // pas l'état brut 60 Hz — sinon la cible « strobe » à 120 Hz
    this.player.renderPosition(alpha, _pivot);
    _pivot.y += CAMERA.pivotHeight;
    this.smoothedTarget.lerp(_pivot, kPos);
    this.distance += (this.targetDistance - this.distance) * kRot;

    this.applyTransform(dt);
  }

  /**
   * À bord : les sondes terrain sont REMPLACÉES par un ray-vs-AABB de
   * l'intérieur du wagon (les désactiver seulement ne suffit pas — dans le
   * tunnel, getHeight lit la SURFACE du rempart 20 m au-dessus : le clamp
   * plancher catapulterait la caméra hors du tube).
   */
  private applyInteriorTransform(th: number, origin: Vector3): void {
    const cp = Math.cos(this.pitch);
    _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);

    // Rayon cible→caméra exprimé en local wagon (rotation inverse −θ)
    const c = Math.cos(th);
    const s = Math.sin(th);
    _lo.set(
      c * (this.smoothedTarget.x - origin.x) - s * (this.smoothedTarget.z - origin.z),
      this.smoothedTarget.y - origin.y,
      s * (this.smoothedTarget.x - origin.x) + c * (this.smoothedTarget.z - origin.z),
    );
    _ld.set(c * _dir.x - s * _dir.z, _dir.y, s * _dir.x + c * _dir.z);

    // Sortie de l'AABB intérieur (le rayon part de l'intérieur) — marge 0,15
    const hx = this.interior!.halfW - 0.12;
    const hz = this.interior!.halfL - 0.12;
    const y0 = 0.12;
    const y1 = this.interior!.ceilY - 0.08;
    let tExit = Infinity;
    const slab = (o: number, d: number, mn: number, mx: number): number => {
      if (Math.abs(d) < 1e-6) return Infinity;
      return Math.max((mn - o) / d, (mx - o) / d);
    };
    tExit = Math.min(tExit, slab(_lo.x, _ld.x, -hx, hx));
    tExit = Math.min(tExit, slab(_lo.y, _ld.y, y0, y1));
    tExit = Math.min(tExit, slab(_lo.z, _ld.z, -hz, hz));
    const allowed = Math.max(Math.min(this.distance, tExit - 0.15), 0.35);

    _camPos.copy(this.smoothedTarget).addScaledVector(_dir, allowed);
    this.camera.position.copy(_camPos);
    this.camera.lookAt(this.smoothedTarget);
  }

  private applyTransform(dt: number): void {
    const cp = Math.cos(this.pitch);
    _dir.set(
      Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      Math.cos(this.yaw) * cp,
    ); // unitaire par construction (cp² + sin²pitch = 1)

    // Clairance de perche (M4) : marche le long du boom en échantillonnant le
    // heightfield (analytique, ~13 lectures). Sans elle, la caméra traverse la
    // falaise dès qu'on grimpe (near 0.2 + backfaces → on voit l'intérieur).
    let allowed = this.distance;
    for (let i = 1; i <= CAMERA.boomProbes; i++) {
      const t = (i / CAMERA.boomProbes) * this.distance;
      const py = this.smoothedTarget.y + _dir.y * t;
      const gh = this.ground.getHeight(this.smoothedTarget.x + _dir.x * t, this.smoothedTarget.z + _dir.z * t);
      if (py < gh + CAMERA.boomGuard) {
        let lo = ((i - 1) / CAMERA.boomProbes) * this.distance;
        let hi = t;
        for (let b = 0; b < 2; b++) {
          const mid = (lo + hi) / 2;
          const my = this.smoothedTarget.y + _dir.y * mid;
          const mh = this.ground.getHeight(this.smoothedTarget.x + _dir.x * mid, this.smoothedTarget.z + _dir.z * mid);
          if (my < mh + CAMERA.boomGuard) hi = mid;
          else lo = mid;
        }
        allowed = lo;
        break;
      }
    }
    // Amorti asymétrique : rapproche vite (l'intérieur de la falaise ne reste
    // jamais à l'écran), éloigne lentement avec zone morte (zéro pompage)
    if (dt > 0) {
      if (allowed < this.collisionDist) {
        this.collisionDist += (allowed - this.collisionDist) * (1 - Math.exp(-CAMERA.collideInK * dt));
      } else if (allowed > this.collisionDist + CAMERA.collideDeadband) {
        this.collisionDist += (allowed - this.collisionDist) * (1 - Math.exp(-CAMERA.collideOutK * dt));
      }
    } else {
      this.collisionDist = allowed;
    }
    this.collisionDist = Math.min(Math.max(this.collisionDist, CAMERA.collideMinDist), CAMERA.maxDistance);

    _camPos.copy(this.smoothedTarget).addScaledVector(_dir, Math.min(this.distance, this.collisionDist));

    // Dégagement terrain : jamais sous le sol — ni sous la surface de l'eau
    // LOCALE (levelAt : deux plans d'eau à des niveaux différents sur la carte M3)
    let floorY = this.ground.getHeight(_camPos.x, _camPos.z) + CAMERA.terrainClearance;
    if (this.ground.getWaterSdf(_camPos.x, _camPos.z) < 0) {
      floorY = Math.max(floorY, this.ground.levelAt(_camPos.x, _camPos.z) + CAMERA.terrainClearance);
    }
    if (_camPos.y < floorY) _camPos.y = floorY;

    this.camera.position.copy(_camPos);
    this.camera.lookAt(this.smoothedTarget);
  }
}

const _pivot = new Vector3();
const _dir = new Vector3();
const _camPos = new Vector3();
const _origin = new Vector3();
const _lo = new Vector3();
const _ld = new Vector3();
