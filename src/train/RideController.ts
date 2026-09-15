import { Vector3 } from 'three/webgpu';
import { TRAIN } from '../config';
import type { Updatable } from '../core/Engine';
import type { InputManager } from '../core/InputManager';
import type { CharacterController } from '../player/CharacterController';
import type { ThirdPersonCamera, CameraInterior } from '../player/ThirdPersonCamera';
import type { TrainSystem, StationName } from './TrainSystem';
import type { PlayerFrame } from './PlayerFrame';
import type { WagonInterior } from './WagonInterior';
import type { TrackPose } from '../world/TrackSpec';

// Embarquement/débarquement (M5) : consomme KeyF (enregistré AVANT clearFrame),
// bascule le contrôleur en espace local du wagon et la caméra en mode intérieur,
// pousse doucement un joueur à pied hors du gabarit d'un train en marche.

export class RideController implements Updatable {
  aboard = false;
  /** Libellé du prompt « F · … » (null = pas de prompt) — lu par le HUD. */
  promptLabel: string | null = null;
  /** Gare où l'on vient d'arriver À BORD (titres de région) — consommé par main. */
  onDisembarkable: ((station: StationName) => void) | null = null;

  private readonly frame: PlayerFrame & CameraInterior;
  /** Mode headless (?train=auto) : embarque/débarque sans toucher F. */
  private readonly auto = new URLSearchParams(location.search).get('train') === 'auto';
  /** Gare d'embarquement : à l'arrivée EN FACE, on descend automatiquement
   *  (attente courte + prompt discret = joueurs coincés à bord, retour M5). */
  private boardedAt: StationName = 'valley';
  private prevTrainState: 'run' | 'dwell' = 'dwell';

  constructor(
    private readonly input: InputManager,
    private readonly player: CharacterController,
    private readonly camera: ThirdPersonCamera,
    private readonly train: TrainSystem,
    interior: WagonInterior,
    private readonly platforms: Record<StationName, Vector3>,
    private readonly groundHeight: (x: number, z: number) => number,
  ) {
    const t = train;
    const floorY = t.coachFloorY;
    this.frame = {
      ground: interior.ground,
      obstacles: interior.obstacles,
      yaw: () => t.coachPose(_pose).yaw,
      origin: (out: Vector3) => {
        t.coachPose(_pose);
        return out.set(_pose.x, _pose.y + floorY, _pose.z);
      },
      renderYaw: (alpha: number) => t.coachRenderPose(alpha, _pose).yaw,
      renderOrigin: (alpha: number, out: Vector3) => {
        t.coachRenderPose(alpha, _pose);
        return out.set(_pose.x, _pose.y + floorY, _pose.z);
      },
      ceilingY: t.coachCeilY - t.coachFloorY,
      allowClimb: false,
      halfW: t.coachInteriorHalfW,
      halfL: t.coachInteriorHalfL,
      ceilY: t.coachCeilY - t.coachFloorY,
    };
  }

  fixedUpdate(dt: number): void {
    void dt;
    const train = this.train;
    const justStopped = train.state === 'dwell' && this.prevTrainState === 'run';
    this.prevTrainState = train.state;

    if (this.aboard) {
      // Descente automatique aux TERMINUS seulement (M6) : embarqué en toundra,
      // on reste à bord jusqu'à Snezhnograd (ou la Vallée) quel que soit le sens
      // du train — « des trains réguliers pour la ville ». F descend à tout arrêt.
      const terminus = train.target === 'valley' || train.target === 'city';
      if (justStopped && terminus && train.target !== this.boardedAt) {
        this.disembark();
        return;
      }
      if (train.state === 'dwell') {
        this.promptLabel = 'Descendre';
        if (this.input.wasPressed('KeyF')) this.disembark();
      } else {
        this.promptLabel = null;
      }
      return;
    }

    if (this.auto && train.state === 'dwell' && train.target === 'valley') {
      this.board();
      return;
    }

    this.promptLabel = null;
    this.player.worldPosition(_pw);

    if (train.state === 'dwell') {
      // Porte = centre de la voiture du joueur, alignée sur le quai à l'arrêt
      train.coachPose(_pose);
      const d = Math.hypot(_pw.x - _pose.x, _pw.z - _pose.z);
      if (d < TRAIN.boardRange) {
        this.promptLabel = `Monter à bord · vers ${TRAIN.stationLabels[train.nextTarget]}`;
        if (this.input.wasPressed('KeyF')) this.board();
      }
    } else if (train.moving) {
      // Sécurité : le train ne traverse pas le joueur — poussée amortie hors gabarit
      const d = train.nearestCar(_pw.x, _pw.z, _away);
      if (d < TRAIN.pushRadius) {
        this.player.addImpulse(_away.x * TRAIN.pushImpulse, _away.z * TRAIN.pushImpulse);
      }
    }
  }

  private board(): void {
    this.player.enterFrame(this.frame, 0, 0, 0);
    this.camera.setInterior(this.frame);
    this.train.setCoachInteriorMode(true);
    this.aboard = true;
    this.boardedAt = this.train.target; // à quai, target = gare courante
    console.info('[Train] board');
  }

  private disembark(): void {
    const station = this.train.target; // à quai, target = gare courante
    const p = this.platforms[station];
    const y = Math.max(this.groundHeight(p.x, p.z), p.y);
    // Face au quai (dos au train)
    this.train.coachPose(_pose);
    const heading = Math.atan2(p.x - _pose.x, p.z - _pose.z);
    this.player.exitFrame(p.x, y, p.z, heading);
    this.camera.setInterior(null);
    this.train.setCoachInteriorMode(false);
    this.aboard = false;
    console.info(`[Train] disembark ${station}`);
    this.onDisembarkable?.(station);
  }
}

const _pose: TrackPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const _pw = new Vector3();
const _away = new Vector3();
