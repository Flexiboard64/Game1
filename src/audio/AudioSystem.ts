import type { PerspectiveCamera } from 'three/webgpu';
import { Vector3 } from 'three/webgpu';
import { AUDIO, BRAZIERS, CASCADE, WINDCOLS } from '../config';
import type { Updatable } from '../core/Engine';
import type { CombatEvents } from '../combat/CombatEvents';
import type { CharacterController } from '../player/CharacterController';
import type { ColdSystem } from '../snezhnaya/ColdSystem';
import type { RideController } from '../train/RideController';
import type { TrainSystem } from '../train/TrainSystem';
import type { TrackPose } from '../world/TrackSpec';
import type { WindColumns } from '../world/WindColumns';
import type { Dialogue } from '../quest/Dialogue';
import type { QuestSystem } from '../quest/QuestSystem';
import type { Seelie } from '../quest/Seelie';
import type { AudioEngine } from './AudioEngine';
import type { AmbienceMixer } from './AmbienceMixer';
import type { Sfx } from './Sfx';
import { surfaceAt, type SurfaceDeps } from './SurfaceSampler';
import type { VoicePlayer } from './VoicePlayer';

// Chef d'orchestre : draine la file CombatEvents (patron VfxSystem — enregistré
// juste AVANT events.clear()) avec coalescence par type (plusieurs pas fixes
// peuvent s'empiler dans une frame : 1 son, pas 3 superposés), et détecte par
// polling les fronts qui n'ont ni event ni callback (locomotion, froid, train,
// prompts). Toute planification temporelle sur l'horloge audio (le hitstop
// scale le dt) ; les cadences de PAS sont en distance, immunisées.

interface AudioDeps {
  engine: AudioEngine;
  sfx: Sfx;
  ambience: AmbienceMixer;
  voice: VoicePlayer;
  player: CharacterController;
  camera: PerspectiveCamera;
  events: CombatEvents;
  train: TrainSystem;
  ride: RideController;
  cold: ColdSystem;
  interactions: { readonly promptLabel: string | null };
  quest: QuestSystem;
  dialogue: Dialogue;
  windCols: WindColumns;
  seelie: Seelie;
  surfaces: SurfaceDeps;
}

const _pw = new Vector3();
const _pan = { pan: 0, gain: 0 };

export class AudioSystem implements Updatable {
  private ambS = 0;
  private nightS = 0;
  // Fronts joueur
  private prevGrounded = true;
  private prevGliding = false;
  private airVy = 0; // vy la plus négative de la phase aérienne (intensité d'atterrissage)
  private stepAccum = 0;
  private climbAccum = 0;
  private prevClimbing = false;
  // Fronts divers
  private prevPrompt = false;
  private prevDialogueOpen = false;
  private prevCold50 = false;
  private lastColdTickAt = 0;
  private chuffAccum = 0;
  private prevAboard = false;
  private rollLoop: { gain: GainNode; stop: () => void } | null = null;
  private prevTrainSpeed = 0;
  private brakePlayed = false;
  private prevVaulting = false;
  private prevStaminaEmpty = false;
  private seelieLoop: { gain: GainNode; pan: StereoPannerNode; stop: () => void } | null = null;
  private iceLoop: { gain: GainNode; stop: () => void } | null = null;
  // Boucles persistantes
  private gliderLoop: { gain: GainNode; filter: BiquadFilterNode; stop: () => void } | null = null;
  private windColLoop: { gain: GainNode; filter: BiquadFilterNode; stop: () => void } | null = null;
  private readonly brazierLoops = new Map<number, { gain: GainNode; pan: StereoPannerNode; stop: () => void }>();
  private readonly tornadoLoops = new Map<number, { gain: GainNode; pan: StereoPannerNode; stop: () => void }>();
  private readonly coachPose: TrackPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };

  constructor(private readonly d: AudioDeps) {}

  /** Poussé par le bloc d'ambiance de main.ts (zéro duplication du calcul). */
  setRegion(ambS: number, nightS: number): void {
    this.ambS = ambS;
    this.nightS = nightS;
  }

  /** Sonde headless (?audiodiag). */
  get diag(): { unlocked: boolean; lastSfx: string; lastVoice: string; ambGains: Record<string, number> } {
    return {
      unlocked: this.d.engine.unlocked,
      lastSfx: this.d.sfx.lastPlayed,
      lastVoice: this.d.voice.lastVoice,
      ambGains: this.d.ambience.gains,
    };
  }

  update(dt: number): void {
    const d = this.d;
    // Le duck de dialogue doit suivre l'état même verrouillé tardivement
    const dlgOpen = d.dialogue.open;
    if (dlgOpen !== this.prevDialogueOpen) {
      d.voice.setDialogueOpen(dlgOpen);
      this.prevDialogueOpen = dlgOpen;
    }
    if (!d.engine.unlocked) return;

    d.player.worldPosition(_pw);
    this.drainEvents(_pw.y);
    this.playerFronts(dt);
    this.coldAndPrompts();
    this.trainSounds(dt);
    this.persistentLoops();

    // Nappes : proximité de l'eau (cascade + rives) côté vallée uniquement
    const distFalls = Math.hypot(_pw.x - CASCADE.bottom.x, _pw.z - CASCADE.bottom.z);
    const sdf = d.surfaces.ground.getWaterSdf(_pw.x, _pw.z);
    const distWater = Math.min(distFalls, Math.max(0, sdf));
    const riverProx01 = Math.max(0, 1 - distWater / AUDIO.ambience.riverRadius);
    d.ambience.update({
      ambS: this.ambS,
      nightS: this.nightS,
      blizzard01: d.cold.blizzard01,
      envBoost: d.quest.envBoost,
      aboard: d.ride.aboard,
      tunnel: d.train.inTunnel && d.ride.aboard,
      trainSpeed01: Math.min(1, d.train.speed / 6.8),
      riverProx01,
    });
  }

  // ---- File d'événements (coalescée par type) ----

  private drainEvents(py: number): void {
    const d = this.d;
    const seen = new Set<string>();
    let hitCrit = false;
    let hitAny = false;
    for (const e of d.events.list) {
      switch (e.type) {
        case 'swing':
          if (!seen.has('swing')) { d.sfx.swing(e.combo); d.voice.bark('attack'); }
          break;
        case 'skillCast':
          if (!seen.has('skillCast')) d.sfx.skillCast();
          break;
        case 'burstCast':
          if (!seen.has('burstCast')) { d.sfx.burstCast(); d.voice.bark('attack'); }
          break;
        case 'burstTick':
          if (!seen.has('burstTick')) d.sfx.burstTick();
          break;
        case 'hit':
          hitAny = true;
          if (e.crit) hitCrit = true;
          break;
        case 'enemyRoar':
          if (!seen.has('enemyRoar')) {
            d.engine.panFor(e.x, py, e.z, d.camera, _pan);
            if (_pan.gain > 0) d.sfx.enemyRoar(_pan.pan, _pan.gain);
          }
          break;
        case 'enemyTelegraph':
          if (!seen.has('enemyTelegraph')) {
            d.engine.panFor(e.x, py, e.z, d.camera, _pan);
            if (_pan.gain > 0) d.sfx.enemyTelegraph(_pan.pan, _pan.gain);
          }
          break;
        case 'enemyDeath':
          if (!seen.has('enemyDeath')) {
            d.engine.panFor(e.x, e.y, e.z, d.camera, _pan);
            if (_pan.gain > 0) d.sfx.enemyDeath(_pan.pan, _pan.gain);
          }
          break;
        case 'playerHit':
          if (!seen.has('playerHit')) { d.sfx.playerHit(); d.voice.bark('hurt'); }
          break;
        case 'playerDeath':
          if (!seen.has('playerDeath')) d.sfx.playerDeath();
          break;
        case 'playerRespawn':
          if (!seen.has('playerRespawn')) d.sfx.playerRespawn();
          break;
        case 'parried':
          if (!seen.has('parried')) {
            d.engine.panFor(e.x, e.y, e.z, d.camera, _pan);
            d.sfx.parried(_pan.pan);
          }
          break;
        case 'projectileImpact':
          if (!seen.has('projectileImpact')) {
            d.engine.panFor(e.x, e.y, e.z, d.camera, _pan);
            if (_pan.gain > 0) d.sfx.projectileImpact(_pan.pan, _pan.gain);
          }
          break;
        case 'reaction':
          if (!seen.has(`reaction-${e.kind}`)) { d.sfx.reaction(e.kind); seen.add(`reaction-${e.kind}`); }
          break;
        case 'playerFrozen':
          if (!seen.has('playerFrozen')) { d.sfx.playerFrozen(); d.voice.bark('frozen'); }
          break;
        case 'brazierLit':
          if (!seen.has('brazierLit')) {
            d.engine.panFor(e.x, py, e.z, d.camera, _pan);
            d.sfx.brazierIgnite(_pan.pan);
          }
          break;
        case 'bossPhase':
          d.sfx.bossPhase(e.phase); // rare et important : jamais coalescé à tort
          break;
        case 'shieldBreak':
          if (!seen.has('shieldBreak')) d.sfx.shieldBreak();
          break;
      }
      seen.add(e.type);
    }
    if (hitAny) d.sfx.hit(hitCrit);
  }

  // ---- Fronts joueur (polling) ----

  private playerFronts(dt: number): void {
    const d = this.d;
    const p = d.player;
    const grounded = p.grounded;
    // Mémoriser la vy la plus négative de la phase aérienne (le contrôleur la
    // remet à 0 au contact — il faut la capturer AVANT le front)
    if (!grounded) this.airVy = Math.min(this.airVy, p.velocity.y);
    if (grounded !== this.prevGrounded) {
      if (grounded) {
        const k = Math.min(1, Math.max(0, (-this.airVy - AUDIO.landing.softVy) / (AUDIO.landing.hardVy - AUDIO.landing.softVy)));
        d.player.worldPosition(_pw);
        d.sfx.land(k, surfaceAt(_pw.x, _pw.z, d.surfaces));
        if (k > 0.5) d.voice.bark('land');
        this.airVy = 0;
      } else if (p.velocity.y > 3) {
        d.sfx.jump();
        d.voice.bark('jump');
      }
      this.prevGrounded = grounded;
    }
    // Planeur : claquement d'ouverture + boucle de vent asservie à la vitesse
    if (p.gliding !== this.prevGliding) {
      if (p.gliding) {
        d.sfx.gliderOpen();
        this.gliderLoop ??= d.sfx.makeWindLoop();
      } else if (this.gliderLoop) {
        this.gliderLoop.stop();
        this.gliderLoop = null;
      }
      this.prevGliding = p.gliding;
    }
    if (this.gliderLoop) {
      const t = d.engine.now;
      const k = Math.min(1, p.speed / 8);
      this.gliderLoop.gain.gain.setTargetAtTime(0.05 + 0.2 * k, t, 0.2);
      this.gliderLoop.filter.frequency.setTargetAtTime(400 + 900 * k, t, 0.2);
    }
    // Pas : accumulateur de distance, seuil par mode
    if (grounded && (p.mode === 'walk' || p.mode === 'run' || p.mode === 'sprint')) {
      this.stepAccum += p.speed * dt;
      const stride = AUDIO.steps.strideM[p.mode];
      if (this.stepAccum >= stride) {
        this.stepAccum = 0;
        d.player.worldPosition(_pw);
        d.sfx.footstep(surfaceAt(_pw.x, _pw.z, d.surfaces));
      }
    } else if (p.mode === 'idle') {
      this.stepAccum = 0;
    }
    // Grimpe : prises cadencées par la distance verticale parcourue
    if (p.climbing) {
      if (!this.prevClimbing) d.sfx.climbGrab();
      this.climbAccum += Math.abs(p.climbRate) * dt;
      if (this.climbAccum >= AUDIO.steps.climbM) {
        this.climbAccum = 0;
        d.sfx.climbGrab();
      }
    } else {
      this.climbAccum = 0;
    }
    this.prevClimbing = p.climbing;
    // Vault : whoosh d'effort au front montant
    if (p.vaulting && !this.prevVaulting) d.sfx.vault();
    this.prevVaulting = p.vaulting;
    // Endurance épuisée (sprint coupé, décrochage planeur) : front descendant
    const staminaEmpty = p.stamina.value <= 0.5;
    if (staminaEmpty && !this.prevStaminaEmpty) d.sfx.staminaEmpty();
    this.prevStaminaEmpty = staminaEmpty;
    // Glissade sur glace : boucle tant qu'on glisse vite sur la surface gelée
    d.player.worldPosition(_pw);
    const onIce = grounded && p.speed > 3.2 && surfaceAt(_pw.x, _pw.z, d.surfaces) === 'ice';
    if (onIce && !this.iceLoop) this.iceLoop = d.sfx.makeIceSlideLoop();
    if (this.iceLoop) {
      const k = Math.min(1, p.speed / 8);
      this.iceLoop.gain.gain.setTargetAtTime(onIce ? 0.08 + 0.22 * k : 0.0001, d.engine.now, 0.15);
      if (!onIce) {
        this.iceLoop.stop();
        this.iceLoop = null;
      }
    }
  }

  // ---- Froid + prompts F ----

  private coldAndPrompts(): void {
    const d = this.d;
    // Jauge pleine : tick cristallin cadencé sur l'horloge audio
    if (d.cold.cold01 >= 1 && d.engine.now - this.lastColdTickAt >= 1) {
      this.lastColdTickAt = d.engine.now;
      d.sfx.coldTick();
    }
    // Bark de froid au passage de la moitié de jauge
    const cold50 = d.cold.cold01 >= 0.5;
    if (cold50 && !this.prevCold50) d.voice.bark('cold');
    this.prevCold50 = cold50;
    // Apparition d'un prompt F (ride > interactions > quête — même chaîne que le HUD)
    const prompt = (d.ride.promptLabel ?? d.interactions.promptLabel ?? d.quest.promptLabel) !== null;
    if (prompt && !this.prevPrompt) d.sfx.uiPrompt();
    this.prevPrompt = prompt;
  }

  // ---- Train : chuff cadencé par la distance parcourue ----

  private trainSounds(dt: number): void {
    const d = this.d;
    // Porte du wagon à l'embarquement/descente + boucle de roulement à bord
    if (d.ride.aboard !== this.prevAboard) {
      d.sfx.trainDoor();
      this.prevAboard = d.ride.aboard;
    }
    if (d.ride.aboard && !this.rollLoop) this.rollLoop = d.sfx.makeTrainRollLoop();
    if (!d.ride.aboard && this.rollLoop) {
      this.rollLoop.stop();
      this.rollLoop = null;
    }
    if (this.rollLoop) {
      const k = Math.min(1, d.train.speed / 6.8);
      this.rollLoop.gain.gain.setTargetAtTime(0.03 + 0.3 * k, d.engine.now, 0.3);
    }
    // Crissement de freins : décélération marquée sous 4,5 m/s, une fois par arrêt
    if (d.train.speed < this.prevTrainSpeed - 0.005 && d.train.speed < 4.5 && d.train.speed > 0.4 && !this.brakePlayed) {
      this.brakePlayed = true;
      d.train.coachPose(this.coachPose);
      d.engine.panFor(this.coachPose.x, this.coachPose.y, this.coachPose.z, d.camera, _pan);
      const g = d.ride.aboard ? 0.6 : _pan.gain;
      if (g > 0.02) d.sfx.trainBrake(d.ride.aboard ? 0 : _pan.pan, g);
    }
    if (d.train.speed > this.prevTrainSpeed + 0.01) this.brakePlayed = false;
    this.prevTrainSpeed = d.train.speed;
    if (!d.train.moving) { this.chuffAccum = 0; return; }
    this.chuffAccum += d.train.speed * dt;
    if (this.chuffAccum < 2.0) return;
    this.chuffAccum = 0;
    d.train.coachPose(this.coachPose);
    d.engine.panFor(this.coachPose.x, this.coachPose.y, this.coachPose.z, d.camera, _pan);
    const gain = d.ride.aboard ? 0.5 : _pan.gain;
    if (gain > 0.02) d.sfx.trainChuff(d.ride.aboard ? 0 : _pan.pan, gain);
  }

  // ---- Boucles positionnelles persistantes ----

  private persistentLoops(): void {
    const d = this.d;
    const t = d.engine.now;
    // Braseros allumés : crépitement positionnel (≤ 4, portée courte)
    for (let i = 0; i < BRAZIERS.length; i++) {
      const lit = d.cold.brazierLit[i] === true;
      const loop = this.brazierLoops.get(i);
      if (lit && !loop && this.brazierLoops.size < 4) {
        const l = d.sfx.makeCrackleLoop();
        if (l) this.brazierLoops.set(i, l);
      } else if (!lit && loop) {
        loop.stop();
        this.brazierLoops.delete(i);
      }
    }
    for (const [i, loop] of this.brazierLoops) {
      const b = BRAZIERS[i]!;
      d.engine.panFor(b.x, _pw.y, b.z, d.camera, _pan);
      loop.gain.gain.setTargetAtTime(Math.max(0.0001, _pan.gain * 0.5), t, 0.15);
      loop.pan.pan.setTargetAtTime(_pan.pan, t, 0.15);
    }
    // Luciole de givre : carillon positionnel pendant l'étape d'escorte
    const seelieOn = this.d.quest.step === 'seelie';
    if (seelieOn && !this.seelieLoop) this.seelieLoop = d.sfx.makeSeelieLoop();
    if (this.seelieLoop) {
      const sp = d.seelie.group.position;
      d.engine.panFor(sp.x, sp.y, sp.z, d.camera, _pan);
      this.seelieLoop.gain.gain.setTargetAtTime(seelieOn ? Math.max(0.0001, _pan.gain * 0.5) : 0.0001, t, 0.2);
      this.seelieLoop.pan.pan.setTargetAtTime(_pan.pan, t, 0.2);
      if (!seelieOn) {
        this.seelieLoop.stop();
        this.seelieLoop = null;
      }
    }
    // Tornades : présence sonore POSITIONNELLE de chaque colonne active
    // (avant : rien tant qu'on n'était pas DEDANS — retour utilisateur)
    if (d.windCols.active) {
      for (let i = 0; i < WINDCOLS.columns.length; i++) {
        const c = WINDCOLS.columns[i]!;
        d.engine.panFor(c.x, _pw.y, c.z, d.camera, _pan);
        const loop = this.tornadoLoops.get(i);
        if (_pan.gain > 0.02 && !loop && this.tornadoLoops.size < 3) {
          const l = d.sfx.makeTornadoLoop();
          if (l) this.tornadoLoops.set(i, l);
        } else if (_pan.gain <= 0.01 && loop) {
          loop.stop();
          this.tornadoLoops.delete(i);
        }
        const active = this.tornadoLoops.get(i);
        if (active) {
          active.gain.gain.setTargetAtTime(Math.max(0.0001, _pan.gain * 0.55), t, 0.2);
          active.pan.pan.setTargetAtTime(_pan.pan, t, 0.2);
        }
      }
    }
    // Colonne de vent : boucle RAPPROCHÉE si le joueur est dans l'updraft
    const inCol = d.windCols.active && d.windCols.updraftAt(_pw.x, _pw.y, _pw.z) > 0;
    if (inCol && !this.windColLoop) this.windColLoop = d.sfx.makeWindLoop();
    if (this.windColLoop) {
      const target = inCol ? 0.3 : 0.0001;
      this.windColLoop.gain.gain.setTargetAtTime(target, t, 0.25);
      this.windColLoop.filter.frequency.setTargetAtTime(inCol ? 900 : 400, t, 0.25);
      if (!inCol) {
        // Laisse mourir puis libère (réutilisable à la prochaine colonne)
        this.windColLoop.stop();
        this.windColLoop = null;
      }
    }
  }
}
