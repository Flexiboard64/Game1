import { AnimationMixer, IcosahedronGeometry, Mesh, MeshBasicNodeMaterial, Object3D, Vector3 } from 'three/webgpu';
import { color } from 'three/tsl';
import { ARENA, BOSS, BRAZIERS, PALETTE } from '../config';
import { fresnel } from '../materials/tsl';
import type { CombatGround } from '../world/GroundSource';
import type { ObstacleGrid } from '../world/Obstacles';
import type { CombatEvents } from './CombatEvents';
import type { ClipPlayer } from './ClipPlayer';
import type { BossClipName } from '../assets/CharacterLoader';
import type { Element } from './Elements';
import type { Foe, GolemMatSet } from './Enemy';
import type { ProjectileManager } from './ProjectileManager';

// BOSS « Garde-Chasse Automate » (M6) : dort près de l'épave jusqu'au trigger
// d'arène, puis 3 phases — P1 mêlée télégraphiée ; P2 (<70 %) BOUCLIER DE GLACE
// (pool séparé : la Fonte le brûle à plein, le reste ×0,15, et il FOND près
// d'un brasero allumé de l'arène — le kiting devient la mécanique) + volées
// d'éclats ; P3 (<35 %) TEMPÊTE tournoyante (contact à tick + onde de choc
// télégraphiée, boss +25 % vulnérable). Pas de hitstun (armure). Canaris [Boss].

type BossState =
  | 'dormant' | 'roar' | 'chase' | 'windup' | 'strike' | 'recover'
  | 'stagger' | 'storm' | 'dying' | 'dissolving' | 'dead';

export class BossEnemy implements Foe {
  readonly position = new Vector3();
  heading: number;
  hp: number = BOSS.hp;
  readonly maxHp: number = BOSS.hp;
  readonly radius: number = BOSS.radius;
  readonly heightM: number = BOSS.heightM;
  state: BossState = 'dormant';
  age = 0;
  lastDamagedAt = -Infinity;
  parriedLastHit = false;
  /** Phase courante 1..3 (BossBar + ArenaController). */
  phase = 1;
  shieldHp = 0;

  private stateT = 0;
  private attackCooldown = 0;
  private volleyT = 0;
  private stormTickT = 0;
  private shockT = 0;
  private shockTelegraphed = false;
  private struckPlayer = false;
  private readonly prevPosition = new Vector3();
  private prevHeading: number;
  private readonly shieldMesh: Mesh;

  constructor(
    readonly root: Object3D,
    readonly mixer: AnimationMixer,
    private readonly anim: ClipPlayer<BossClipName>,
    readonly matSet: GolemMatSet,
    readonly home: { x: number; z: number },
    private readonly ground: CombatGround,
    private readonly obstacles: ObstacleGrid | null,
    private readonly events: CombatEvents,
    private readonly projectiles: ProjectileManager | null,
    private readonly brazierLit: readonly boolean[],
  ) {
    this.position.set(home.x, ground.getHeight(home.x, home.z), home.z);
    this.prevPosition.copy(this.position);
    this.heading = 0.8;
    this.prevHeading = this.heading;
    this.anim.play('idle', { loop: true });

    // Coquille de bouclier (P2) : icosaèdre fresnel cryo, invisible par défaut
    const shieldMat = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    shieldMat.colorNode = color(PALETTE.elements.cryo).mul(1.6);
    shieldMat.opacityNode = fresnel(2.0).mul(0.55).add(0.08);
    this.shieldMesh = new Mesh(new IcosahedronGeometry(BOSS.radius * 2.2, 1), shieldMat);
    this.shieldMesh.position.y = BOSS.heightM * 0.55;
    this.shieldMesh.visible = false;
    this.shieldMesh.frustumCulled = false;
    root.add(this.shieldMesh);
  }

  get alive(): boolean {
    return this.state !== 'dying' && this.state !== 'dissolving' && this.state !== 'dead';
  }

  get aura(): Element | null {
    // Le bouclier de glace EST une aura Cryo : la lame embrasée (Fonte ×2) le
    // brûle à plein — la boucle « allumer les braseros » paie deux fois
    return this.shieldMesh.visible ? 'cryo' : null;
  }

  get engaged(): boolean {
    return this.state !== 'dormant' && this.alive;
  }

  /** Réveil par l'ArenaController. */
  engage(): void {
    if (this.state !== 'dormant') return;
    this.state = 'roar';
    this.stateT = 0;
    this.anim.play('roar', { fade: 0.1, fitDuration: BOSS.roarS + 0.2 });
    this.events.emit({ type: 'enemyRoar', x: this.position.x, z: this.position.z });
    this.events.emit({ type: 'bossPhase', phase: 1 });
    console.info('[Boss] engagé');
  }

  /** Reset complet (mort du joueur) : retour au sommeil, PV pleins. */
  resetFight(): void {
    this.hp = this.maxHp;
    this.shieldHp = 0;
    this.shieldMesh.visible = false;
    this.phase = 1;
    this.state = 'dormant';
    this.stateT = 0;
    this.position.set(this.home.x, this.ground.getHeight(this.home.x, this.home.z), this.home.z);
    this.prevPosition.copy(this.position);
    this.anim.play('idle', { loop: true });
    console.info('[Boss] reset');
  }

  addPush(): void {
    // Armure : le boss ne se pousse pas (ni séparation, ni succion)
  }

  takeHit(dmg: number, _dirX: number, _dirZ: number, _knock: number, _heavy: boolean, element?: Element): boolean {
    if (!this.alive || this.state === 'dormant') return false;
    this.parriedLastHit = false;
    this.lastDamagedAt = this.age;
    this.matSet.hitFlash.value = 0.35;
    if (this.shieldMesh.visible) {
      // Bouclier : la Fonte (le ×2 est déjà dans dmg) passe à plein, le reste ×0,15
      const eff = element === 'pyro' ? dmg : dmg * BOSS.shield.otherDmgMult;
      this.shieldHp -= eff;
      if (this.shieldHp <= 0) this.breakShield();
      return false;
    }
    if (this.state === 'storm') dmg *= BOSS.storm.dmgTakenMult;
    this.hp -= dmg;
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dying';
      this.stateT = 0;
      this.anim.play('death', { fade: 0.1 });
      this.events.emit({ type: 'enemyDeath', x: this.position.x, y: this.position.y + 2, z: this.position.z });
      console.info('[Boss] vaincu');
      return true;
    }
    return false; // pas de hitstun (armure)
  }

  alert(): void {
    // Le boss ne répond qu'au trigger d'arène
  }

  disengage(): void {
    if (this.engaged) this.resetFight();
  }

  fixedUpdate(
    dt: number,
    player: { x: number; z: number; alive: boolean },
    dealPlayerDamage: (dmg: number, dirX: number, dirZ: number, element?: Element) => void,
  ): void {
    this.prevPosition.copy(this.position);
    this.prevHeading = this.heading;
    this.age += dt;
    this.stateT += dt;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);

    const dxP = player.x - this.position.x;
    const dzP = player.z - this.position.z;
    const distP = Math.hypot(dxP, dzP);
    let moveX = 0;
    let moveZ = 0;
    let wantFace: number | null = null;

    // Transitions de phase par seuil de PV (une seule fois chacune)
    if (this.engaged && this.phase === 1 && this.hp <= this.maxHp * BOSS.phase2At) this.enterPhase2();
    if (this.engaged && this.phase === 2 && this.hp <= this.maxHp * BOSS.phase3At && !this.shieldMesh.visible) this.enterPhase3();

    // Fonte passive du bouclier près d'un brasero d'arène ALLUMÉ
    if (this.shieldMesh.visible) {
      for (const bi of ARENA.brazierIndices) {
        if (!this.brazierLit[bi]) continue;
        const b = BRAZIERS[bi]!;
        if (Math.hypot(this.position.x - b.x, this.position.z - b.z) < BOSS.shield.brazierMeltR) {
          this.shieldHp -= BOSS.shield.brazierMeltPerS * dt;
          if (this.shieldHp <= 0) this.breakShield();
          break;
        }
      }
    }

    // Volées d'éclats en P2 (bouclier levé)
    if (this.shieldMesh.visible && player.alive) {
      this.volleyT += dt;
      if (this.volleyT >= BOSS.volley.everyS) {
        this.volleyT = 0;
        const base = Math.atan2(dxP, dzP);
        for (let i = 0; i < BOSS.volley.count; i++) {
          const a = base + ((i - (BOSS.volley.count - 1) / 2) * BOSS.volley.spreadDeg * Math.PI) / 180;
          this.projectiles?.fire(
            this.position.x, this.position.y + 2.2, this.position.z,
            Math.sin(a), -0.06, Math.cos(a), BOSS.volley.speed, BOSS.volley.dmg, BOSS.volley.ttl,
          );
        }
      }
    }

    switch (this.state) {
      case 'dormant':
        break;

      case 'roar':
        wantFace = Math.atan2(dxP, dzP);
        if (this.stateT >= BOSS.roarS) this.toChase();
        break;

      case 'chase': {
        if (!player.alive) break; // l'ArenaController resetFight() à la mort du joueur
        wantFace = Math.atan2(dxP, dzP);
        if (distP < BOSS.smash.reach * 0.8 && this.attackCooldown <= 0) {
          this.state = 'windup';
          this.stateT = 0;
          this.struckPlayer = false;
          this.anim.play('attack', { fade: 0.08, fitDuration: BOSS.smash.windupS + BOSS.smash.strikeS + BOSS.smash.recoverS });
          this.events.emit({ type: 'enemyTelegraph', x: this.position.x, z: this.position.z });
          break;
        }
        const inv = 1 / Math.max(distP, 1e-3);
        const spd = this.phase === 3 ? BOSS.storm.moveSpeed : BOSS.walkSpeed;
        moveX = dxP * inv * spd;
        moveZ = dzP * inv * spd;
        break;
      }

      case 'windup':
        wantFace = Math.atan2(dxP, dzP);
        if (this.stateT >= BOSS.smash.windupS) {
          this.state = 'strike';
          this.stateT = 0;
        }
        break;

      case 'strike': {
        if (!this.struckPlayer && player.alive) {
          let dd = Math.atan2(dxP, dzP) - this.heading;
          while (dd > Math.PI) dd -= 2 * Math.PI;
          while (dd < -Math.PI) dd += 2 * Math.PI;
          if (distP < BOSS.smash.reach && Math.abs(dd) < (BOSS.smash.arcDeg / 2) * (Math.PI / 180)) {
            this.struckPlayer = true;
            const inv = 1 / Math.max(distP, 1e-3);
            dealPlayerDamage(BOSS.smash.dmg, dxP * inv, dzP * inv, 'physical');
          }
        }
        if (this.stateT >= BOSS.smash.strikeS) {
          this.state = 'recover';
          this.stateT = 0;
        }
        break;
      }

      case 'recover':
        if (this.stateT >= BOSS.smash.recoverS) {
          this.attackCooldown = BOSS.smash.cooldownMin + Math.random() * (BOSS.smash.cooldownMax - BOSS.smash.cooldownMin);
          this.toChase();
        }
        break;

      case 'stagger':
        if (this.stateT >= BOSS.shield.breakStaggerS) this.toChase();
        break;

      case 'storm': {
        // Tempête tournoyante : poursuite lente + contact à tick + onde de choc
        if (player.alive) {
          const inv = 1 / Math.max(distP, 1e-3);
          moveX = dxP * inv * BOSS.storm.moveSpeed;
          moveZ = dzP * inv * BOSS.storm.moveSpeed;
          this.stormTickT += dt;
          if (this.stormTickT >= BOSS.storm.tickS) {
            this.stormTickT = 0;
            if (distP < BOSS.storm.radius + 0.5) {
              dealPlayerDamage(BOSS.storm.contactDmg, dxP / Math.max(distP, 1e-3), dzP / Math.max(distP, 1e-3), 'electro');
            }
          }
          this.shockT += dt;
          if (!this.shockTelegraphed && this.shockT >= BOSS.storm.shockwave.everyS - BOSS.storm.shockwave.telegraphS) {
            this.shockTelegraphed = true;
            this.events.emit({ type: 'enemyTelegraph', x: this.position.x, z: this.position.z });
          }
          if (this.shockT >= BOSS.storm.shockwave.everyS) {
            this.shockT = 0;
            this.shockTelegraphed = false;
            this.events.emit({ type: 'burstTick', x: this.position.x, z: this.position.z });
            if (distP < BOSS.storm.shockwave.r) {
              dealPlayerDamage(BOSS.storm.shockwave.dmg, dxP / Math.max(distP, 1e-3), dzP / Math.max(distP, 1e-3), 'electro');
            }
          }
        }
        break;
      }

      case 'dying':
        if (this.stateT >= BOSS.dieS) {
          this.state = 'dissolving';
          this.stateT = 0;
        }
        break;

      case 'dissolving':
        this.matSet.dissolve.value = Math.min(1.001, (this.stateT / BOSS.dissolveS) * 1.001);
        if (this.stateT >= BOSS.dissolveS) {
          this.state = 'dead';
          this.root.visible = false;
        }
        break;

      case 'dead':
        break; // pas de respawn : boss unique (reset uniquement à la mort du joueur)
    }

    if (moveX !== 0 || moveZ !== 0) this.tryMove(moveX * dt, moveZ * dt);
    this.position.y = this.ground.getHeight(this.position.x, this.position.z);

    if (wantFace !== null) {
      let diff = wantFace - this.heading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.heading += diff * (1 - Math.exp(-dt / BOSS.turnSmoothTime));
    }
  }

  applyVisual(alpha: number, dt: number): void {
    this.root.position.copy(this.prevPosition).lerp(this.position, alpha);
    if (this.state === 'storm') {
      // Rotation procédurale de la tempête (le clip attack boucle par-dessus)
      this.root.rotation.y += dt * 9;
    } else {
      let diff = this.heading - this.prevHeading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.root.rotation.y = this.prevHeading + diff * alpha;
    }
    this.matSet.hitFlash.value = Math.max(0, this.matSet.hitFlash.value - dt * 6);
    this.mixer.update(dt);
  }

  private toChase(): void {
    this.state = this.phase === 3 ? 'storm' : 'chase';
    this.stateT = 0;
    this.anim.play(this.phase === 3 ? 'attack' : 'walk', { loop: true });
  }

  private enterPhase2(): void {
    this.phase = 2;
    this.shieldHp = BOSS.shield.hp;
    this.shieldMesh.visible = true;
    this.volleyT = 0;
    this.events.emit({ type: 'bossPhase', phase: 2 });
    console.info('[Boss] phase 2 — bouclier de glace');
  }

  private breakShield(): void {
    this.shieldHp = 0;
    this.shieldMesh.visible = false;
    this.state = 'stagger';
    this.stateT = 0;
    this.anim.play('idle', { loop: true });
    this.events.emit({ type: 'shieldBreak', x: this.position.x, y: this.position.y + 2, z: this.position.z });
    console.info('[Boss] bouclier BRISÉ (stagger)');
  }

  private enterPhase3(): void {
    this.phase = 3;
    this.state = 'roar';
    this.stateT = 0;
    this.shockT = 0;
    this.anim.play('roar', { fade: 0.1, fitDuration: BOSS.roarS + 0.2 });
    this.events.emit({ type: 'bossPhase', phase: 3 });
    console.info('[Boss] phase 3 — tempête');
  }

  private tryMove(dx: number, dz: number): void {
    const attempt = (ax: number, az: number): boolean => {
      const nx = this.position.x + ax;
      const nz = this.position.z + az;
      if (!this.ground.inBounds(nx, nz)) return false;
      if (this.obstacles?.blocked(nx, nz, this.radius)) return false;
      if (this.ground.getSlopeDeg(nx, nz) > 42 && this.ground.getHeight(nx, nz) > this.position.y + 0.001) return false;
      this.position.x = nx;
      this.position.z = nz;
      return true;
    };
    if (!attempt(dx, dz)) {
      attempt(dx, 0);
      attempt(0, dz);
    }
  }
}
