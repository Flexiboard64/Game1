import { Quaternion, Scene, Vector3 } from 'three/webgpu';
import { COMBAT, ENEMY } from '../config';
import type { Updatable } from '../core/Engine';
import type { CombatGround } from '../world/GroundSource';
import type { CharacterController } from '../player/CharacterController';
import type { CombatEvents } from '../combat/CombatEvents';
import type { SwordMount } from '../combat/SwordMount';
import { SparkPool, PlanePool } from './VfxPools';
import { SwordTrail } from './SwordTrail';
import { TornadoVfx } from './TornadoVfx';
import { SwordFireVfx } from './FireVfx';

// Orchestrateur des VFX de combat : draine CombatEvents en update (pas variable,
// APRÈS les mixers — la traînée échantillonne l'os déjà posé) et exécute les
// recettes. Toute l'horloge VFX avance en dt SCALÉ → gèle pendant le hitstop.

const _q = new Quaternion();
const _qTilt = new Quaternion();
const _p = new Vector3();
const _up = new Vector3(0, 1, 0);
const _axisX = new Vector3(1, 0, 0);
const _flat = new Quaternion().setFromAxisAngle(_axisX, -Math.PI / 2);

export class VfxSystem implements Updatable {
  private readonly sparks = new SparkPool();
  private readonly planes = new PlanePool();
  private readonly trail: SwordTrail;
  private readonly tornado = new TornadoVfx();
  private readonly swordFire: SwordFireVfx;
  private tornadoUntil = -1;
  private elapsed = 0;

  constructor(
    scene: Scene,
    private readonly events: CombatEvents,
    private readonly player: CharacterController,
    private readonly ground: Pick<CombatGround, 'getHeight'>,
    sword: SwordMount,
  ) {
    this.trail = new SwordTrail(sword);
    this.swordFire = new SwordFireVfx(sword);
    scene.add(this.sparks.mesh);
    scene.add(this.planes.mesh);
    scene.add(this.trail.mesh);
    scene.add(this.tornado.group);
    scene.add(this.swordFire.group);
  }

  /** Lame embrasée (infusion Pyro) — piloté chaque frame depuis main. */
  setSwordFire(on: boolean): void {
    this.swordFire.setActive(on);
  }

  /** Warmup : tous les matériaux VFX doivent compiler derrière le chargement. */
  setCompileVisible(v: boolean): void {
    this.tornado.setCompileVisible(v);
    // Pools et traînée : toujours visibles (instances mortes = alpha 0)
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.sparks.uT.value += dt;
    this.planes.uT.value += dt;
    this.tornado.update(dt);
    if (this.tornadoUntil > 0 && this.elapsed >= this.tornadoUntil) {
      this.tornado.deactivate();
      this.tornadoUntil = -1;
    }

    for (const e of this.events.list) {
      switch (e.type) {
        case 'swing': {
          const spec = COMBAT.combo[e.combo]!;
          // Arc de slash au buste, orienté par le cap d'attaque, incliné par coup
          _q.setFromAxisAngle(_up, e.heading);
          const tilt = e.combo === 0 ? -0.5 : e.combo === 1 ? 0.5 : 0;
          _qTilt.setFromAxisAngle(_axisX, tilt);
          _q.multiply(_qTilt);
          _p.copy(this.player.position);
          _p.y += 1.15;
          _p.x += Math.sin(e.heading) * 0.9;
          _p.z += Math.cos(e.heading) * 0.9;
          this.planes.spawn(0, _p, _q, e.combo === 2 ? 2.0 : 2.5);
          this.trail.activate(spec.windup + spec.active + 0.12);
          break;
        }
        case 'skillCast': {
          _q.setFromAxisAngle(_up, e.heading);
          _p.copy(this.player.position);
          _p.y += 1.2;
          _p.x += Math.sin(e.heading) * 1.2;
          _p.z += Math.cos(e.heading) * 1.2;
          this.planes.spawn(3, _p, _q, 3.6);
          // Onde au sol sous le joueur + fenêtre de traînée longue
          _p.copy(this.player.position);
          _p.y = this.ground.getHeight(_p.x, _p.z) + 0.06;
          this.planes.spawn(1, _p, _flat, COMBAT.skill.reach * 2);
          this.trail.activate(COMBAT.skill.windup + COMBAT.skill.active + 0.15);
          break;
        }
        case 'hit': {
          // Flash + gerbe d'étincelles dans le demi-espace du coup
          this.sparks.spawn(1, e.x, e.y, e.z);
          for (let i = 0; i < 8; i++) {
            const a = (i / 8) * Math.PI * 2;
            const spread = 2.6;
            this.sparks.spawn(
              0, e.x, e.y, e.z,
              Math.sin(a) * spread * 0.6 + e.dirX * 2.2,
              1.6 + (i % 3) * 0.8,
              Math.cos(a) * spread * 0.6 + e.dirZ * 2.2,
              (i + 0.5) / 8,
            );
          }
          if (e.kill) {
            for (let i = 0; i < 12; i++) {
              this.sparks.spawn(2, e.x + Math.sin(i) * 0.4, e.y - 0.6 + (i % 4) * 0.35, e.z + Math.cos(i * 2.3) * 0.4, 0, 0, 0, (i + 0.5) / 12);
            }
          }
          _p.set(e.x, this.ground.getHeight(e.x, e.z) + 0.05, e.z);
          this.planes.spawn(1, _p, _flat, e.kill ? 4.5 : 2.2);
          break;
        }
        case 'enemyTelegraph': {
          _p.set(e.x, this.ground.getHeight(e.x, e.z) + 0.05, e.z);
          this.planes.spawn(2, _p, _flat, ENEMY.strikeReach * 2);
          break;
        }
        case 'enemyRoar': {
          _p.set(e.x, this.ground.getHeight(e.x, e.z) + 0.05, e.z);
          this.planes.spawn(1, _p, _flat, 3.0);
          break;
        }
        case 'enemyDeath': {
          this.sparks.spawn(1, e.x, e.y, e.z);
          break;
        }
        case 'parried': {
          // Gerbe d'étincelles serrée : le coup a sonné sur la garde
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            this.sparks.spawn(0, e.x, e.y, e.z, Math.sin(a) * 2.2, 1.4, Math.cos(a) * 2.2, (i + 0.5) / 6);
          }
          break;
        }
        case 'projectileImpact': {
          this.sparks.spawn(3, e.x, e.y, e.z);
          break;
        }
        case 'reaction': {
          // Éclat de réaction : flash + couronne (la couleur fine viendra du polish)
          this.sparks.spawn(1, e.x, e.y, e.z);
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            this.sparks.spawn(3, e.x, e.y, e.z, Math.sin(a) * 3.2, 2.0, Math.cos(a) * 3.2, (i + 0.5) / 10);
          }
          break;
        }
        case 'burstCast': {
          const gy = this.ground.getHeight(e.x, e.z);
          this.tornado.activate(e.x, gy, e.z);
          this.tornadoUntil = this.elapsed + COMBAT.burst.durationS;
          _p.set(e.x, gy + 0.06, e.z);
          this.planes.spawn(1, _p, _flat, COMBAT.burst.radius * 2.4);
          break;
        }
        case 'burstTick': {
          const gy = this.ground.getHeight(e.x, e.z);
          _p.set(e.x, gy + 0.06, e.z);
          this.planes.spawn(1, _p, _flat, COMBAT.burst.radius * 2);
          for (let i = 0; i < 6; i++) {
            this.sparks.spawn(3, e.x, gy + 0.3, e.z, 0, 0, 0, (i + 0.5) / 6);
          }
          break;
        }
        default:
          break; // playerHit/playerDeath/playerRespawn : côté HUD
      }
    }

    this.trail.update(dt);
    this.swordFire.update(dt);
  }
}
