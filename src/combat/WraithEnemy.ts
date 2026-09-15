import { Group, Mesh, Vector3 } from 'three/webgpu';
import { WRAITH } from '../config';
import type { CombatGround } from '../world/GroundSource';
import type { CombatEvents } from './CombatEvents';
import type { Element } from './Elements';
import type { Foe, GolemMatSet } from './Enemy';
import type { ProjectileManager } from './ProjectileManager';

// Cryo Wraith (M6) : spectre flottant SANS rig Meshy — « animations » 100 %
// procédurales (bobbing, gonflement du cast, dissolution). Kite le joueur
// (recule sous retreatUnder, orbite à preferredR) et tire des éclats de glace
// LENTS et esquivables (tir mené sur la position + lead, jamais guidé).

type WraithState = 'idle' | 'drift' | 'cast' | 'recover' | 'hitstun' | 'dying' | 'dissolving' | 'dead';

export class WraithEnemy implements Foe {
  readonly position = new Vector3();
  heading: number;
  hp: number = WRAITH.hp;
  readonly maxHp: number = WRAITH.hp;
  readonly radius: number = WRAITH.radius;
  readonly heightM: number = WRAITH.heightM + WRAITH.hoverY;
  readonly aura: Element | null = 'cryo';
  state: WraithState = 'idle';
  age = 0;
  lastDamagedAt = -Infinity;
  parriedLastHit = false;

  private stateT = 0;
  private castCooldown = 0;
  private prevPlayerX = 0;
  private prevPlayerZ = 0;
  private readonly prevPosition = new Vector3();
  private prevHeading: number;
  private pushX = 0;
  private pushZ = 0;
  private impulseX = 0;
  private impulseZ = 0;

  constructor(
    readonly root: Group,
    private readonly bodyMesh: Mesh,
    readonly matSet: GolemMatSet,
    readonly home: { x: number; z: number },
    heading0: number,
    private readonly ground: CombatGround,
    private readonly events: CombatEvents,
    private readonly projectiles: ProjectileManager | null,
    private readonly rand: () => number,
  ) {
    this.position.set(home.x, ground.getHeight(home.x, home.z), home.z);
    this.prevPosition.copy(this.position);
    this.heading = heading0;
    this.prevHeading = heading0;
  }

  get alive(): boolean {
    return this.state !== 'dying' && this.state !== 'dissolving' && this.state !== 'dead';
  }

  addPush(vx: number, vz: number): void {
    this.pushX += vx;
    this.pushZ += vz;
  }

  takeHit(dmg: number, dirX: number, dirZ: number, knock: number, heavy: boolean, _element?: Element): boolean {
    void heavy;
    if (!this.alive) return false;
    this.parriedLastHit = false;
    this.hp -= dmg;
    this.lastDamagedAt = this.age;
    this.matSet.hitFlash.value = 0.4;
    this.impulseX += dirX * knock * 1.4; // léger : plus balloté qu'un golem
    this.impulseZ += dirZ * knock * 1.4;
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dying';
      this.stateT = 0;
      this.events.emit({ type: 'enemyDeath', x: this.position.x, y: this.position.y + 1.4, z: this.position.z });
      return true;
    }
    this.state = 'hitstun';
    this.stateT = 0;
    return false;
  }

  alert(): void {
    if (this.state === 'idle') this.state = 'drift';
  }

  disengage(): void {
    if (this.state === 'drift' || this.state === 'cast' || this.state === 'recover' || this.state === 'hitstun') {
      this.state = 'idle';
      this.stateT = 0;
    }
  }

  fixedUpdate(
    dt: number,
    player: { x: number; z: number; alive: boolean },
    dealPlayerDamage: (dmg: number, dirX: number, dirZ: number, element?: Element) => void,
  ): void {
    void dealPlayerDamage; // les dégâts passent par les projectiles
    this.prevPosition.copy(this.position);
    this.prevHeading = this.heading;
    this.age += dt;
    this.stateT += dt;
    this.castCooldown = Math.max(0, this.castCooldown - dt);

    const dxP = player.x - this.position.x;
    const dzP = player.z - this.position.z;
    const distP = Math.hypot(dxP, dzP);
    let moveX = 0;
    let moveZ = 0;

    switch (this.state) {
      case 'idle':
        if (player.alive && distP < WRAITH.aggroRange) this.state = 'drift';
        break;

      case 'drift': {
        if (!player.alive || distP > WRAITH.leashRange) {
          this.state = 'idle';
          break;
        }
        this.heading = Math.atan2(dxP, dzP);
        const inv = 1 / Math.max(distP, 1e-3);
        if (distP < WRAITH.retreatUnder) {
          moveX = -dxP * inv * WRAITH.driftSpeed;
          moveZ = -dzP * inv * WRAITH.driftSpeed;
        } else if (distP > WRAITH.preferredR + 1.5) {
          moveX = dxP * inv * WRAITH.driftSpeed * 0.7;
          moveZ = dzP * inv * WRAITH.driftSpeed * 0.7;
        } else {
          // Orbite lente autour du joueur
          moveX = -dzP * inv * WRAITH.driftSpeed * 0.5;
          moveZ = dxP * inv * WRAITH.driftSpeed * 0.5;
        }
        if (this.castCooldown <= 0 && distP < WRAITH.preferredR + 4) {
          this.state = 'cast';
          this.stateT = 0;
          this.prevPlayerX = player.x;
          this.prevPlayerZ = player.z;
          this.events.emit({ type: 'enemyTelegraph', x: this.position.x, z: this.position.z });
        }
        break;
      }

      case 'cast': {
        this.heading = Math.atan2(dxP, dzP);
        if (this.stateT >= WRAITH.castS) {
          // Tir MENÉ : position + vitesse estimée × lead — esquivable au sprint
          const velX = (player.x - this.prevPlayerX) / Math.max(this.stateT, 1e-3);
          const velZ = (player.z - this.prevPlayerZ) / Math.max(this.stateT, 1e-3);
          const tx = player.x + velX * WRAITH.projLead;
          const tz = player.z + velZ * WRAITH.projLead;
          const oy = this.position.y + WRAITH.hoverY + 0.6;
          const ty = this.ground.getHeight(tx, tz) + 1.1;
          const dx = tx - this.position.x;
          const dy = ty - oy;
          const dz = tz - this.position.z;
          const d = Math.max(Math.hypot(dx, dy, dz), 1e-3);
          this.projectiles?.fire(this.position.x, oy, this.position.z, dx / d, dy / d, dz / d, WRAITH.projSpeed, WRAITH.projDmg, WRAITH.projTtl);
          this.state = 'recover';
          this.stateT = 0;
          this.castCooldown = WRAITH.cooldownMin + this.rand() * (WRAITH.cooldownMax - WRAITH.cooldownMin);
        }
        break;
      }

      case 'recover':
        if (this.stateT >= 0.4) this.state = 'drift';
        break;

      case 'hitstun':
        if (this.stateT >= WRAITH.hitstunS) this.state = 'drift';
        break;

      case 'dying':
        if (this.stateT >= WRAITH.dieS) {
          this.state = 'dissolving';
          this.stateT = 0;
        }
        break;

      case 'dissolving':
        this.matSet.dissolve.value = Math.min(1.001, (this.stateT / WRAITH.dissolveS) * 1.001);
        if (this.stateT >= WRAITH.dissolveS) {
          this.state = 'dead';
          this.stateT = 0;
          this.root.visible = false;
        }
        break;

      case 'dead':
        if (this.stateT >= WRAITH.respawnS) {
          this.position.set(this.home.x, this.ground.getHeight(this.home.x, this.home.z), this.home.z);
          this.prevPosition.copy(this.position);
          this.hp = this.maxHp;
          this.state = 'idle';
          this.stateT = 0;
          this.root.visible = true;
          this.matSet.dissolve.value = 0;
        }
        break;
    }

    // Déplacement plané (pas d'obstacles : le spectre traverse les congères)
    const nx = this.position.x + (moveX + this.pushX + this.impulseX) * dt;
    const nz = this.position.z + (moveZ + this.pushZ + this.impulseZ) * dt;
    if (this.ground.inBounds(nx, nz)) {
      this.position.x = nx;
      this.position.z = nz;
    }
    const decay = Math.exp(-dt / 0.12);
    this.impulseX *= decay;
    this.impulseZ *= decay;
    this.pushX = 0;
    this.pushZ = 0;
    this.position.y = this.ground.getHeight(this.position.x, this.position.z);
  }

  applyVisual(alpha: number, dt: number): void {
    this.root.position.copy(this.prevPosition).lerp(this.position, alpha);
    // Lévitation : hover + bob sinusoïdal (l'« animation » du spectre)
    this.root.position.y += WRAITH.hoverY + Math.sin(this.age * WRAITH.bobFreq * Math.PI * 2) * WRAITH.bobAmp;
    let diff = this.heading - this.prevHeading;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this.root.rotation.y = this.prevHeading + diff * alpha;
    // Gonflement pendant le cast (télégraphe lisible sans clip)
    const castPulse = this.state === 'cast' ? 1 + 0.16 * Math.sin((this.stateT / WRAITH.castS) * Math.PI) : 1;
    this.bodyMesh.scale.setScalar(castPulse);
    this.matSet.hitFlash.value = Math.max(0, this.matSet.hitFlash.value - dt * 6);
  }
}
