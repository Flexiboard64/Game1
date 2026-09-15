import { Vector3 } from 'three/webgpu';
import { COMBAT, VFX } from '../config';
import type { Updatable, Engine } from '../core/Engine';
import type { InputManager } from '../core/InputManager';
import type { CharacterController } from '../player/CharacterController';
import type { AnimationStateMachine } from '../player/AnimationStateMachine';
import type { CombatGround } from '../world/GroundSource';
import type { Element } from './Elements';
import { resolveHit, REACTIONS } from './Elements';
import type { EnemyManager } from './EnemyManager';
import type { CombatEvents } from './CombatEvents';
import type { CameraShake } from './CameraShake';
import type { ClipName } from '../assets/CharacterLoader';

// Combat du joueur, façon Genshin : combo d'épée 3 coups au clic (buffer
// d'input + fenêtre de chaîne), compétence E à cooldown, ultime Q à énergie
// (tornade à ticks + succion), auto-aim en cône, hitstop, shake, i-frames,
// PV + mort/respawn au spawn. Timings SIM autoritaires ; tout effet visuel/DOM
// part dans CombatEvents (drainée en update par VfxSystem et le HUD).
// Enregistré AVANT input.clearFrame() (consomme Mouse0/E/Q en wasPressed).

interface StrikeSpec {
  mult: number;
  windup: number;
  active: number;
  recover: number;
  reach: number;
  arcDeg: number;
  knock: number;
  hitstopS: number;
  stepSpeed: number;
}

type Phase = 'idle' | 'combo' | 'skill' | 'burstCast' | 'dead';

const COMBO_CLIPS: ClipName[] = ['attack1', 'attack2', 'attack3'];

export class CombatSystem implements Updatable {
  hp: number = COMBAT.playerHp;
  energy = 0; // 0..COMBAT.energyMax
  cooldownE = 0;
  phase: Phase = 'idle';
  /** Point de respawn selon la position de mort (injecté par main.ts). */
  respawnResolver: ((x: number, z: number) => { x: number; z: number }) | null = null;
  /** Appel direct au respawn (reset de la jauge de froid — patron train.onArrive). */
  onRespawn: (() => void) | null = null;

  private comboIndex = 0;
  private phaseT = 0;
  private struckThisSwing = new Set<object>();
  private bufferedClickAt = -Infinity;
  private elapsed = 0;
  private aimHeading = 0;
  private lastHurtAt = -Infinity;
  private lastFrozenAt = -Infinity;
  private regenBlocked = false;
  private infusionElement: Element = 'pyro';
  private infusionLeft = 0;
  private deadT = 0;
  private mulberry: () => number;
  // Tornade du Q : vit indépendamment de la phase (le joueur rejoue pendant)
  private burstLeft = 0;
  private burstTickT = 0;
  private burstX = 0;
  private burstZ = 0;

  constructor(
    private readonly input: InputManager,
    private readonly player: CharacterController,
    private readonly yawProvider: { readonly yaw: number },
    private readonly animations: AnimationStateMachine | null,
    private readonly enemies: EnemyManager,
    private readonly events: CombatEvents,
    private readonly shake: CameraShake,
    private readonly engine: Engine,
    private readonly ground: CombatGround,
    fightFlag: boolean,
  ) {
    // Déterministe (pas de Math.random : crit/variance rejouables au smoke test)
    let seed = 0x9e3779b9;
    this.mulberry = () => {
      seed += 0x6d2b79f5;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    if (fightFlag) this.energy = COMBAT.energyMax; // smoke test : Q disponible
  }

  get alive(): boolean {
    return this.phase !== 'dead';
  }

  get burstActive(): boolean {
    return this.burstLeft > 0;
  }

  fixedUpdate(dt: number): void {
    this.elapsed += dt;
    this.cooldownE = Math.max(0, this.cooldownE - dt);
    if (this.burstLeft > 0) this.updateTornado(dt);

    if (this.phase === 'dead') {
      this.deadT += dt;
      if (this.deadT >= COMBAT.deathS) this.respawn();
      return;
    }

    // Régén hors combat + énergie passive (bloquée quand la jauge de froid grimpe)
    if (!this.regenBlocked && this.hp < COMBAT.playerHp && this.elapsed - this.lastHurtAt > COMBAT.hpRegenDelayS) {
      this.hp = Math.min(COMBAT.playerHp, this.hp + COMBAT.hpRegenPerS * dt);
    }
    this.infusionLeft = Math.max(0, this.infusionLeft - dt);
    this.energy = Math.min(COMBAT.energyMax, this.energy + COMBAT.energyPassivePerS * dt);

    if (this.input.wasPressed('Mouse0')) this.bufferedClickAt = this.elapsed;
    const wantSkill = this.input.wasPressed('KeyE');
    // R et non Q : en AZERTY la touche étiquetée Q est le code KeyA (gauche
    // ZQSD) — R porte la même étiquette sur les deux dispositions
    const wantBurst = this.input.wasPressed('KeyR');

    switch (this.phase) {
      case 'idle': {
        if (wantBurst && this.energy >= COMBAT.energyMax && this.player.canAttack) this.startBurst();
        else if (wantSkill && this.cooldownE <= 0 && this.player.canAttack) this.startSkill();
        else if (this.hasBufferedClick() && this.player.canAttack) this.startStrike(0);
        break;
      }
      case 'combo':
        this.updateStrike(dt, COMBAT.combo[this.comboIndex]!, false, true);
        break;
      case 'skill':
        this.updateStrike(dt, COMBAT.skill, true, false);
        break;
      case 'burstCast': {
        this.phaseT += dt;
        this.player.setCombatDrive(true, this.aimHeading);
        if (this.phaseT >= COMBAT.burst.castS) {
          this.spawnTornado();
          this.exitToIdle();
        }
        break;
      }
    }
  }

  /** Dégâts subis (appel DIRECT d'EnemyManager — jamais via la file sim→rendu). */
  applyPlayerDamage(dmg: number, dirX: number, dirZ: number, element?: Element): void {
    if (this.phase === 'dead') return;
    if (this.elapsed - this.lastHurtAt < COMBAT.iFramesS) return; // i-frames
    this.lastHurtAt = this.elapsed;
    this.hp = Math.max(0, this.hp - dmg);
    this.player.addImpulse(dirX * COMBAT.knockbackPlayer, dirZ * COMBAT.knockbackPlayer);
    this.shake.add(VFX.shake.playerHit);
    this.events.emit({ type: 'playerHit', dmg });
    // Coup Cryo : GEL bref du joueur (root, jamais en grimpe), à cooldown global
    if (element === 'cryo' && this.elapsed - this.lastFrozenAt > REACTIONS.playerFreeze.cooldownS) {
      this.lastFrozenAt = this.elapsed;
      this.player.applyRoot(REACTIONS.playerFreeze.rootS);
      this.events.emit({ type: 'playerFrozen' });
      console.info('[Combat] joueur GELÉ');
    }
    console.info(`[Combat] joueur touché ${dmg} (PV ${this.hp.toFixed(0)})`);
    if (this.hp <= 0) this.die();
  }

  /**
   * Dégâts ENVIRONNEMENTAUX (froid mordant M6) : pas d'i-frames, pas de
   * knockback, pas de shake — un drain, qui coupe quand même la régén.
   */
  applyEnvironmentalDamage(dmg: number): void {
    if (this.phase === 'dead') return;
    this.lastHurtAt = this.elapsed;
    this.hp = Math.max(0, this.hp - dmg);
    if (this.hp <= 0) this.die();
  }

  /** Régén bloquée par le froid (> seuil de jauge) — ColdSystem. */
  setRegenBlocked(blocked: boolean): void {
    this.regenBlocked = blocked;
  }

  /** « Embraser la lame » (brasero allumé) : les coups deviennent Pyro. */
  infuse(element: Element, durationS: number): void {
    this.infusionElement = element;
    this.infusionLeft = durationS;
    console.info(`[Combat] infusion ${element} ${durationS}s`);
  }

  get infusion(): { element: Element; left: number } | null {
    return this.infusionLeft > 0 ? { element: this.infusionElement, left: this.infusionLeft } : null;
  }

  /** Élément des coups du joueur (anémo de base, pyro sous infusion). */
  private get attackElement(): Element {
    return this.infusionLeft > 0 ? this.infusionElement : 'anemo';
  }

  // ---- Attaques ----

  private hasBufferedClick(): boolean {
    if (this.elapsed - this.bufferedClickAt > COMBAT.inputBufferS) return false;
    this.bufferedClickAt = -Infinity; // consommé
    return true;
  }

  private acquireAim(): void {
    const px = this.player.position.x;
    const pz = this.player.position.z;
    const camHeading = Math.atan2(-Math.sin(this.yawProvider.yaw), -Math.cos(this.yawProvider.yaw));
    const target =
      this.enemies.nearestInCone(px, pz, this.player.heading, COMBAT.aimConeDeg, COMBAT.aimRange)
      ?? this.enemies.nearestInCone(px, pz, camHeading, COMBAT.aimConeDeg, COMBAT.aimRange);
    if (target) {
      this.aimHeading = Math.atan2(target.position.x - px, target.position.z - pz);
      const dist = Math.hypot(target.position.x - px, target.position.z - pz);
      if (dist > COMBAT.closeRange && this.phase !== 'burstCast') {
        const spec = this.phase === 'combo' ? COMBAT.combo[this.comboIndex]! : null;
        const v = spec ? spec.stepSpeed : 0;
        if (v > 0) this.player.addImpulse(Math.sin(this.aimHeading) * v, Math.cos(this.aimHeading) * v);
      }
    } else {
      this.aimHeading = this.player.heading;
      if (this.phase === 'combo') {
        const v = COMBAT.combo[this.comboIndex]!.stepSpeed;
        this.player.addImpulse(Math.sin(this.aimHeading) * v, Math.cos(this.aimHeading) * v);
      }
    }
  }

  private startStrike(index: number): void {
    this.phase = 'combo';
    this.comboIndex = index;
    this.phaseT = 0;
    this.struckThisSwing.clear();
    this.acquireAim();
    const spec = COMBAT.combo[index]!;
    this.animations?.playOneShot(COMBO_CLIPS[index]!, {
      fade: 0.08,
      fitDuration: spec.windup + spec.active + spec.recover + COMBAT.chainWindowS * 0.5,
    });
    this.events.emit({ type: 'swing', combo: index, heading: this.aimHeading });
  }

  private startSkill(): void {
    this.phase = 'skill';
    this.phaseT = 0;
    this.struckThisSwing.clear();
    this.acquireAim();
    this.cooldownE = 0; // posé à la FIN du cast (annulation impossible ici, autant tout de suite)
    const s = COMBAT.skill;
    this.animations?.playOneShot('skill', { fade: 0.08, fitDuration: s.windup + s.active + s.recover });
    this.events.emit({ type: 'skillCast', heading: this.aimHeading });
    this.shake.add(VFX.shake.skill);
    console.info('[Combat] compétence E');
  }

  private startBurst(): void {
    this.phase = 'burstCast';
    this.phaseT = 0;
    this.energy = 0;
    this.acquireAim();
    this.animations?.playOneShot('burst', { fade: 0.1, fitDuration: COMBAT.burst.castS + 0.4 });
    this.shake.add(VFX.shake.burstCast);
    console.info('[Combat] ultime R');
  }

  private updateStrike(dt: number, spec: StrikeSpec, isSkill: boolean, chainable: boolean): void {
    this.phaseT += dt;
    this.player.setCombatDrive(true, this.aimHeading);

    const activeStart = spec.windup;
    const activeEnd = spec.windup + spec.active;
    const total = activeEnd + spec.recover;

    // Fenêtre ACTIVE : balayage d'arc, une touche par golem par coup
    if (this.phaseT >= activeStart && this.phaseT < activeEnd) {
      this.performHits(spec, isSkill);
    }

    if (this.phaseT >= activeEnd) {
      // Chaîne du combo dès la fin de la phase active (buffer consommé)
      if (chainable && this.comboIndex < COMBAT.combo.length - 1 && this.hasBufferedClick()) {
        this.startStrike(this.comboIndex + 1);
        return;
      }
      // Le déplacement écourte le recover (annulation façon Genshin)
      const moveHeld = this.input.isDown('KeyW') || this.input.isDown('KeyA')
        || this.input.isDown('KeyS') || this.input.isDown('KeyD');
      if (moveHeld && this.phaseT >= activeEnd + COMBAT.recoverCancelS) {
        this.exitToIdle();
        return;
      }
    }
    if (this.phaseT >= total) {
      if (chainable && this.hasBufferedClick()) {
        this.startStrike((this.comboIndex + 1) % COMBAT.combo.length);
        return;
      }
      this.exitToIdle();
    }
  }

  private performHits(spec: StrikeSpec, isSkill: boolean): void {
    const px = this.player.position.x;
    const pz = this.player.position.z;
    this.enemies.forEachAliveInArc(px, pz, this.aimHeading, spec.reach, spec.arcDeg, (e) => {
      if (this.struckThisSwing.has(e)) return;
      this.struckThisSwing.add(e);
      const dx = e.position.x - px;
      const dz = e.position.z - pz;
      const d = Math.max(Math.hypot(dx, dz), 1e-3);
      const crit = this.mulberry() < COMBAT.critChance;
      // Réactions élémentaires (M6) : l'élément du coup rencontre l'aura innée
      const res = resolveHit(e.aura, this.attackElement);
      const dmg = Math.round(
        COMBAT.atk * spec.mult * res.mult
        * (1 + (this.mulberry() * 2 - 1) * COMBAT.variance)
        * (crit ? COMBAT.critMult : 1),
      );
      const killed = e.takeHit(dmg, dx / d, dz / d, spec.knock, isSkill, this.attackElement);
      if (e.parriedLastHit) {
        // Coup BLOQUÉ (opératif) : ni chiffre, ni énergie — l'étincelle suffit
        this.engine.requestHitstop(0.04, COMBAT.hitstopScale);
        return;
      }
      if (res.reaction) {
        this.events.emit({ type: 'reaction', kind: res.reaction, x: e.position.x, y: e.position.y + 1.4, z: e.position.z });
        if (res.reaction === 'swirl' || res.reaction === 'superconduct') {
          // Éclat de zone : une fraction des dégâts aux voisins
          const spec2 = res.reaction === 'swirl' ? REACTIONS.swirl : REACTIONS.superconduct;
          const splash = Math.round(COMBAT.atk * spec2.splashMult);
          this.enemies.forEachAliveInRadius(e.position.x, e.position.z, spec2.radius, (n) => {
            if (n === e || this.struckThisSwing.has(n)) return;
            this.struckThisSwing.add(n);
            const ndx = n.position.x - px;
            const ndz = n.position.z - pz;
            const nd = Math.max(Math.hypot(ndx, ndz), 1e-3);
            n.takeHit(splash, ndx / nd, ndz / nd, 0, false);
          });
        }
      }
      this.energy = Math.min(
        COMBAT.energyMax,
        this.energy + (killed ? COMBAT.energyPerKill : isSkill ? COMBAT.energyPerSkillHit : COMBAT.energyPerHit),
      );
      this.engine.requestHitstop(killed ? COMBAT.killHitstopS : spec.hitstopS, COMBAT.hitstopScale);
      this.shake.add(this.comboIndex === 2 || isSkill ? VFX.shake.na3 : VFX.shake.na);
      this.events.emit({
        type: 'hit',
        x: e.position.x, y: e.position.y + 1.2, z: e.position.z,
        dirX: dx / d, dirZ: dz / d,
        dmg, crit, kill: killed, skill: isSkill,
      });
      console.info(`[Combat] hit ${dmg}${crit ? ' CRIT' : ''}${killed ? ' KILL' : ''}${res.reaction ? ` ${res.reaction.toUpperCase()}` : ''}`);
    });
  }

  private exitToIdle(): void {
    this.phase = 'idle';
    this.phaseT = 0;
    this.player.setCombatDrive(false);
  }

  // ---- Tornade du Q ----

  private spawnTornado(): void {
    this.burstX = this.player.position.x + Math.sin(this.aimHeading) * COMBAT.burst.aheadM;
    this.burstZ = this.player.position.z + Math.cos(this.aimHeading) * COMBAT.burst.aheadM;
    this.burstLeft = COMBAT.burst.durationS;
    this.burstTickT = 0;
    this.events.emit({ type: 'burstCast', x: this.burstX, z: this.burstZ });
  }

  private updateTornado(dt: number): void {
    this.burstLeft -= dt;
    this.burstTickT += dt;
    // Succion continue : poussée vers l'axe, bornée par le tryMove des golems
    this.enemies.forEachAliveInRadius(this.burstX, this.burstZ, COMBAT.burst.radius, (e) => {
      const dx = this.burstX - e.position.x;
      const dz = this.burstZ - e.position.z;
      const d = Math.max(Math.hypot(dx, dz), 1e-3);
      if (d > 0.6) e.addPush((dx / d) * COMBAT.burst.suction, (dz / d) * COMBAT.burst.suction);
    });
    if (this.burstTickT >= COMBAT.burst.tickS) {
      this.burstTickT -= COMBAT.burst.tickS;
      this.events.emit({ type: 'burstTick', x: this.burstX, z: this.burstZ });
      this.shake.add(VFX.shake.burstTick);
      const px = this.player.position.x;
      const pz = this.player.position.z;
      this.enemies.forEachAliveInRadius(this.burstX, this.burstZ, COMBAT.burst.radius, (e) => {
        const crit = this.mulberry() < COMBAT.critChance;
        const dmg = Math.round(COMBAT.atk * COMBAT.burst.tickMult * (crit ? COMBAT.critMult : 1));
        const dx = e.position.x - px;
        const dz = e.position.z - pz;
        const d = Math.max(Math.hypot(dx, dz), 1e-3);
        const killed = e.takeHit(dmg, dx / d, dz / d, 0, false, 'anemo');
        if (killed) this.energy = Math.min(COMBAT.energyMax, this.energy + COMBAT.energyPerKill);
        this.events.emit({
          type: 'hit',
          x: e.position.x, y: e.position.y + 1.2, z: e.position.z,
          dirX: dx / d, dirZ: dz / d, dmg, crit, kill: killed, skill: true,
        });
      });
    }
  }

  // ---- Mort / respawn ----

  private die(): void {
    this.phase = 'dead';
    this.deadT = 0;
    this.animations?.interruptOneShot();
    this.player.setCombatDrive(true, this.player.heading); // input gelé au sol
    this.enemies.disengageAll();
    this.events.emit({ type: 'playerDeath' });
    console.info('[Combat] joueur à terre');
  }

  private respawn(): void {
    // Respawn RÉGIONALISÉ (M6) : le resolver (main.ts) choisit spawn vallée,
    // quai de gare ou dernier brasero allumé selon la position de la mort
    this.player.worldPosition(_deathPos);
    const p = this.respawnResolver ? this.respawnResolver(_deathPos.x, _deathPos.z) : { x: 0, z: 0 };
    this.player.teleport(p.x, this.ground.getHeight(p.x, p.z), p.z);
    this.hp = COMBAT.playerHp;
    this.lastHurtAt = -Infinity;
    this.exitToIdle();
    this.onRespawn?.();
    this.events.emit({ type: 'playerRespawn' });
  }
}

const _deathPos = new Vector3();
