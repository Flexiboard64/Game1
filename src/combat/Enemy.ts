import { AnimationMixer, Object3D, Vector3 } from 'three/webgpu';
import { ENEMY } from '../config';
import type { CombatGround } from '../world/GroundSource';
import type { ObstacleGrid } from '../world/Obstacles';
import type { CombatEvents } from './CombatEvents';
import type { ClipPlayer } from './ClipPlayer';
import type { GolemClipName } from '../assets/CharacterLoader';
import type { Element } from './Elements';

// FSM mêlée « hilichurl » (patrouille → rugissement d'aggro → poursuite →
// attaque télégraphée → récupération), réactions de coup interruptibles, mort
// en deux temps (anim puis dissolution), respawn au camp. M6 : PARAMÉTRÉ par un
// bloc de stats (golem, volkodlak, opératif…), lunge optionnel (dash verrouillé
// du loup), parade optionnelle (l'opératif annule un coup léger et riposte),
// élément d'attaque + aura innée (réactions), sol abstrait (CombatGround).
// Les clips restent les 6 slots GolemClipName — les archétypes REMAPPENT leurs
// clips dessus à l'assemblage (howl→roar, run→walk, parry→roar…).

export type EnemyState =
  | 'idle' | 'roar' | 'chase' | 'windup' | 'strike' | 'recover'
  | 'lungeWindup' | 'lungeDash' | 'parry'
  | 'hitstun' | 'return' | 'dying' | 'dissolving' | 'dead';

export interface GolemMatSet {
  dissolve: { value: number };
  hitFlash: { value: number };
}

/** Stats d'un archétype mêlée — structurellement un spread d'ENEMY (élargi en number). */
export interface EnemyStats {
  hp: number; radius: number; heightM: number;
  walkSpeed: number; walkRefSpeed: number; turnSmoothTime: number;
  aggroRange: number; packRange: number; leashRange: number; homeLeash: number;
  roarS: number; attackRange: number;
  windupS: number; strikeS: number; recoverS: number;
  strikeReach: number; strikeArcDeg: number; strikeDmg: number;
  cooldownMin: number; cooldownMax: number;
  hitstunS: number; hitstunSkillS: number;
  maxSlopeDeg: number; waterSdfMin: number;
  separationR: number; separationK: number;
  dieS: number; dissolveS: number; respawnS: number; rematerializeS: number;
  hpBarShowDist: number; hpBarRecentS: number;
  lunge?: {
    minR: number; maxR: number; windupS: number; dashSpeed: number; dashMaxS: number;
    hitRadius: number; dmg: number; recoverS: number; cooldownMin: number; cooldownMax: number;
  };
  parry?: { chance: number; cooldownS: number; stanceS: number; riposteWindupS: number; riposteDmg: number; pierceMult: number };
}

/** Contrat commun de tous les ennemis (mêlée, wraith, boss) — EnemyManager. */
export interface Foe {
  readonly root: Object3D;
  readonly position: Vector3;
  heading: number;
  hp: number;
  readonly maxHp: number;
  readonly radius: number;
  readonly heightM: number;
  readonly aura: Element | null;
  state: string;
  age: number;
  lastDamagedAt: number;
  readonly alive: boolean;
  parriedLastHit: boolean;
  addPush(vx: number, vz: number): void;
  takeHit(dmg: number, dirX: number, dirZ: number, knock: number, heavy: boolean, element?: Element): boolean;
  alert(): void;
  disengage(): void;
  fixedUpdate(
    dt: number,
    player: { x: number; z: number; alive: boolean },
    dealPlayerDamage: (dmg: number, dirX: number, dirZ: number, element?: Element) => void,
  ): void;
  applyVisual(alpha: number, dt: number): void;
}

export class Enemy implements Foe {
  readonly position = new Vector3();
  heading: number;
  hp: number;
  readonly maxHp: number;
  readonly radius: number;
  readonly heightM: number;
  readonly aura: Element | null;
  state: EnemyState = 'idle';
  /** Horloge locale — barres de PV (« frappé récemment »). */
  age = 0;
  lastDamagedAt = -Infinity;
  parriedLastHit = false;

  private stateT = 0;
  private hitstunDur: number;
  private attackCooldown = 0;
  private lungeCooldown = 0;
  private parryCooldown = 0;
  private riposte = false;
  private struckPlayer = false;
  private lungeDirX = 0;
  private lungeDirZ = 0;
  private lungeDist = 0;
  private lungeTravel = 0;
  private rematT = -1; // rampe de rematérialisation après respawn
  private readonly prevPosition = new Vector3();
  private prevHeading: number;
  // Knockback (amorti) + poussée consommée au tick (succion tornade, séparation)
  private impulseX = 0;
  private impulseZ = 0;
  private pushX = 0;
  private pushZ = 0;

  constructor(
    readonly root: Object3D,
    readonly mixer: AnimationMixer,
    private readonly anim: ClipPlayer<GolemClipName>,
    readonly matSet: GolemMatSet,
    readonly home: { x: number; z: number },
    heading0: number,
    private readonly ground: CombatGround,
    private readonly obstacles: ObstacleGrid | null,
    private readonly events: CombatEvents,
    private readonly rand: () => number,
    private readonly stats: EnemyStats = ENEMY,
    readonly element: Element = 'physical',
    aura: Element | null = null,
  ) {
    this.hp = stats.hp;
    this.maxHp = stats.hp;
    this.radius = stats.radius;
    this.heightM = stats.heightM;
    this.aura = aura;
    this.hitstunDur = stats.hitstunS;
    this.position.set(home.x, ground.getHeight(home.x, home.z), home.z);
    this.prevPosition.copy(this.position);
    this.heading = heading0;
    this.prevHeading = heading0;
    this.anim.play('idle', { loop: true });
  }

  get alive(): boolean {
    return this.state !== 'dying' && this.state !== 'dissolving' && this.state !== 'dead';
  }

  /** Poussée externe (m/s) appliquée CE pas : succion de tornade, séparation. */
  addPush(vx: number, vz: number): void {
    this.pushX += vx;
    this.pushZ += vz;
  }

  /** Coup reçu — retourne true si ce coup tue. */
  takeHit(dmg: number, dirX: number, dirZ: number, knock: number, heavy: boolean, _element?: Element): boolean {
    if (!this.alive) return false;
    this.parriedLastHit = false;
    const s = this.stats;
    // Parade (opératif) : annule un coup LÉGER en garde, entre en posture
    if (s.parry && !heavy && this.parryCooldown <= 0
      && (this.state === 'chase' || this.state === 'windup' || this.state === 'recover')
      && this.rand() < s.parry.chance) {
      this.parriedLastHit = true;
      this.parryCooldown = s.parry.cooldownS;
      this.state = 'parry';
      this.stateT = 0;
      this.anim.play('roar', { fade: 0.05, fitDuration: s.parry.stanceS + 0.1 }); // slot roar = clip parade
      this.events.emit({ type: 'parried', x: this.position.x, y: this.position.y + 1.2, z: this.position.z });
      return false;
    }
    // En posture de parade : les coups sont fortement atténués, jamais d'interruption
    if (this.state === 'parry' && s.parry) {
      dmg = Math.round(dmg * (heavy ? s.parry.pierceMult : 0.15));
    }
    this.hp -= dmg;
    this.lastDamagedAt = this.age;
    this.matSet.hitFlash.value = 0.4; // au-delà, l'ennemi lit comme un aplat blanc
    this.impulseX += dirX * knock;
    this.impulseZ += dirZ * knock;
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dying';
      this.stateT = 0;
      this.anim.play('death', { fade: 0.08 });
      this.events.emit({ type: 'enemyDeath', x: this.position.x, y: this.position.y + 1.1, z: this.position.z });
      return true;
    }
    if (this.state === 'parry') return false;
    // Hit-stun réarmable : interrompt tout (chain-stun assumé, feel « badass »)
    this.state = 'hitstun';
    this.stateT = 0;
    this.hitstunDur = heavy ? s.hitstunSkillS : s.hitstunS;
    this.anim.play('hit', { fade: 0.06 });
    return false;
  }

  /** Aggro externe (meute) : rugit si tranquille. */
  alert(): void {
    if (this.state === 'idle') this.startRoar();
  }

  /** Fin d'aggro forcée (mort du joueur) : rentre au camp. */
  disengage(): void {
    if (this.state === 'roar' || this.state === 'chase' || this.state === 'windup'
      || this.state === 'strike' || this.state === 'recover' || this.state === 'hitstun'
      || this.state === 'lungeWindup' || this.state === 'lungeDash' || this.state === 'parry') {
      this.startReturn();
    }
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
    const s = this.stats;
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.lungeCooldown = Math.max(0, this.lungeCooldown - dt);
    this.parryCooldown = Math.max(0, this.parryCooldown - dt);

    const dxP = player.x - this.position.x;
    const dzP = player.z - this.position.z;
    const distP = Math.hypot(dxP, dzP);
    let moveX = 0;
    let moveZ = 0;
    let wantFace: number | null = null;

    switch (this.state) {
      case 'idle':
        if (player.alive && distP < s.aggroRange) this.startRoar();
        break;

      case 'roar':
        wantFace = Math.atan2(dxP, dzP);
        if (this.stateT >= s.roarS) {
          this.state = 'chase';
          this.stateT = 0;
          this.anim.play('walk', { loop: true });
        }
        break;

      case 'chase': {
        if (!player.alive) {
          this.startReturn();
          break;
        }
        const dHome = Math.hypot(this.position.x - this.home.x, this.position.z - this.home.z);
        if (distP > s.leashRange || dHome > s.homeLeash) {
          this.startReturn();
          break;
        }
        // Lunge du volkodlak : dash télégraphé depuis la moyenne distance
        if (s.lunge && this.lungeCooldown <= 0 && distP >= s.lunge.minR && distP <= s.lunge.maxR) {
          this.state = 'lungeWindup';
          this.stateT = 0;
          this.anim.play('attack', { fade: 0.06, fitDuration: s.lunge.windupS + s.lunge.dashMaxS + 0.2 });
          this.events.emit({ type: 'enemyTelegraph', x: this.position.x, z: this.position.z });
          break;
        }
        if (distP < s.attackRange && this.attackCooldown <= 0) {
          this.state = 'windup';
          this.stateT = 0;
          this.riposte = false;
          this.struckPlayer = false;
          this.anim.play('attack', { fade: 0.08, fitDuration: s.windupS + s.strikeS + s.recoverS });
          this.events.emit({ type: 'enemyTelegraph', x: this.position.x, z: this.position.z });
          break;
        }
        const inv = 1 / Math.max(distP, 1e-3);
        moveX = dxP * inv * s.walkSpeed;
        moveZ = dzP * inv * s.walkSpeed;
        wantFace = Math.atan2(dxP, dzP);
        break;
      }

      case 'lungeWindup': {
        wantFace = Math.atan2(dxP, dzP);
        if (s.lunge && this.stateT >= s.lunge.windupS) {
          // Direction VERROUILLÉE au départ du dash (esquive latérale possible)
          const inv = 1 / Math.max(distP, 1e-3);
          this.lungeDirX = dxP * inv;
          this.lungeDirZ = dzP * inv;
          this.lungeDist = distP + 1.5;
          this.lungeTravel = 0;
          this.struckPlayer = false;
          this.state = 'lungeDash';
          this.stateT = 0;
        }
        break;
      }

      case 'lungeDash': {
        if (!s.lunge) {
          this.state = 'chase';
          break;
        }
        moveX = this.lungeDirX * s.lunge.dashSpeed;
        moveZ = this.lungeDirZ * s.lunge.dashSpeed;
        this.lungeTravel += s.lunge.dashSpeed * dt;
        if (!this.struckPlayer && player.alive && distP < s.lunge.hitRadius) {
          this.struckPlayer = true;
          const inv = 1 / Math.max(distP, 1e-3);
          dealPlayerDamage(s.lunge.dmg, dxP * inv, dzP * inv, this.element);
        }
        if (this.stateT >= s.lunge.dashMaxS || this.lungeTravel >= this.lungeDist || this.struckPlayer) {
          this.state = 'recover';
          this.stateT = 0;
          this.lungeCooldown = s.lunge.cooldownMin + this.rand() * (s.lunge.cooldownMax - s.lunge.cooldownMin);
        }
        break;
      }

      case 'parry': {
        wantFace = Math.atan2(dxP, dzP);
        if (s.parry && this.stateT >= s.parry.stanceS) {
          // Riposte : frappe rapide au sortir de la garde
          this.state = 'windup';
          this.stateT = s.windupS - s.parry.riposteWindupS; // fenêtre raccourcie
          this.riposte = true;
          this.struckPlayer = false;
          this.anim.play('attack', { fade: 0.05, fitDuration: s.parry.riposteWindupS + s.strikeS + s.recoverS });
        }
        break;
      }

      case 'windup':
        wantFace = Math.atan2(dxP, dzP); // suit le joueur pendant le télégraphe
        if (this.stateT >= s.windupS) {
          this.state = 'strike';
          this.stateT = 0;
        }
        break;

      case 'strike': {
        if (!this.struckPlayer && player.alive) {
          let dd = Math.atan2(dxP, dzP) - this.heading;
          while (dd > Math.PI) dd -= 2 * Math.PI;
          while (dd < -Math.PI) dd += 2 * Math.PI;
          if (distP < s.strikeReach && Math.abs(dd) < (s.strikeArcDeg / 2) * (Math.PI / 180)) {
            this.struckPlayer = true;
            const inv = 1 / Math.max(distP, 1e-3);
            const dmg = this.riposte && s.parry ? s.parry.riposteDmg : s.strikeDmg;
            dealPlayerDamage(dmg, dxP * inv, dzP * inv, this.element);
          }
        }
        if (this.stateT >= s.strikeS) {
          this.state = 'recover';
          this.stateT = 0;
        }
        break;
      }

      case 'recover':
        if (this.stateT >= (this.riposte && s.parry ? s.parry.riposteWindupS + s.recoverS : s.recoverS)) {
          this.riposte = false;
          this.state = 'chase';
          this.stateT = 0;
          this.attackCooldown = s.cooldownMin + this.rand() * (s.cooldownMax - s.cooldownMin);
          this.anim.play('walk', { loop: true });
        }
        break;

      case 'hitstun':
        if (this.stateT >= this.hitstunDur) {
          if (player.alive) {
            this.state = 'chase';
            this.stateT = 0;
            this.anim.play('walk', { loop: true });
          } else {
            this.startReturn();
          }
        }
        break;

      case 'return': {
        if (player.alive && distP < s.aggroRange * 0.8) {
          this.state = 'chase';
          this.stateT = 0;
          this.anim.play('walk', { loop: true });
          break;
        }
        const dHx = this.home.x - this.position.x;
        const dHz = this.home.z - this.position.z;
        const dH = Math.hypot(dHx, dHz);
        if (dH < 0.8) {
          // Arrivé au camp : PV pleins (logique Genshin du leash)
          this.state = 'idle';
          this.stateT = 0;
          this.hp = this.maxHp;
          this.anim.play('idle', { loop: true });
          break;
        }
        moveX = (dHx / dH) * s.walkSpeed;
        moveZ = (dHz / dH) * s.walkSpeed;
        wantFace = Math.atan2(dHx, dHz);
        break;
      }

      case 'dying':
        if (this.stateT >= s.dieS) {
          this.state = 'dissolving';
          this.stateT = 0;
        }
        break;

      case 'dissolving':
        this.matSet.dissolve.value = Math.min(1.001, (this.stateT / s.dissolveS) * 1.001);
        if (this.stateT >= s.dissolveS) {
          this.state = 'dead';
          this.stateT = 0;
          this.root.visible = false;
        }
        break;

      case 'dead':
        if (this.stateT >= s.respawnS) this.respawn();
        break;
    }

    // ---- Déplacement (poussées incluses) + physique sol ----
    const totalX = moveX + this.impulseX + this.pushX;
    const totalZ = moveZ + this.impulseZ + this.pushZ;
    if (totalX !== 0 || totalZ !== 0) this.tryMoveEnemy(totalX * dt, totalZ * dt);
    const decay = Math.exp(-dt / 0.12);
    this.impulseX *= decay;
    this.impulseZ *= decay;
    this.pushX = 0;
    this.pushZ = 0;
    this.position.y = this.ground.getHeight(this.position.x, this.position.z);

    if (wantFace !== null) {
      let diff = wantFace - this.heading;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      this.heading += diff * (1 - Math.exp(-dt / s.turnSmoothTime));
    }
  }

  /** Transform visuelle interpolée + décroissances des uniforms (pas variable). */
  applyVisual(alpha: number, dt: number): void {
    this.root.position.copy(this.prevPosition).lerp(this.position, alpha);
    let diff = this.heading - this.prevHeading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this.root.rotation.y = this.prevHeading + diff * alpha;

    this.matSet.hitFlash.value = Math.max(0, this.matSet.hitFlash.value - dt * 6);
    if (this.rematT >= 0) {
      this.rematT += dt;
      this.matSet.dissolve.value = Math.max(0, 1 - this.rematT / this.stats.rematerializeS);
      if (this.rematT >= this.stats.rematerializeS) this.rematT = -1;
    }
    this.mixer.update(dt);
  }

  private startRoar(): void {
    this.state = 'roar';
    this.stateT = 0;
    this.anim.play('roar', { fade: 0.1, fitDuration: this.stats.roarS + 0.2 });
    this.events.emit({ type: 'enemyRoar', x: this.position.x, z: this.position.z });
  }

  private startReturn(): void {
    this.state = 'return';
    this.stateT = 0;
    this.riposte = false;
    this.anim.play('walk', { loop: true });
  }

  private respawn(): void {
    this.position.set(this.home.x, this.ground.getHeight(this.home.x, this.home.z), this.home.z);
    this.prevPosition.copy(this.position);
    this.hp = this.maxHp;
    this.state = 'idle';
    this.stateT = 0;
    this.root.visible = true;
    this.rematT = 0; // dissolution inverse (rematérialisation)
    this.anim.play('idle', { loop: true });
  }

  /** Patron tryMove du joueur : slide par axes, murs de pente, obstacles, eau. */
  private tryMoveEnemy(dx: number, dz: number): void {
    const attempt = (ax: number, az: number): boolean => {
      const nx = this.position.x + ax;
      const nz = this.position.z + az;
      if (!this.ground.inBounds(nx, nz)) return false;
      if (this.obstacles?.blocked(nx, nz, this.radius)) return false;
      // Mur logique : les ennemis n'entrent jamais dans l'eau (succion et
      // knockback passent par ici aussi — jamais tirés dans le lac)
      if (this.ground.getWaterSdf(nx, nz) < this.stats.waterSdfMin) return false;
      const slope = this.ground.getSlopeDeg(nx, nz);
      if (slope > this.stats.maxSlopeDeg && this.ground.getHeight(nx, nz) > this.position.y + 0.001) return false;
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
