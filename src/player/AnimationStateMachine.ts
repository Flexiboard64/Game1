import { AnimationAction, AnimationMixer, LoopOnce } from 'three/webgpu';
import { CLIMB, MOVEMENT } from '../config';
import type { Updatable } from '../core/Engine';
import type { ClipName } from '../assets/CharacterLoader';
import type { CharacterController } from './CharacterController';

// Sélection d'état pilotée par le contrôleur + crossfades. Le timeScale des
// clips de locomotion suit la vitesse réelle pour limiter le patinage des pieds.
// Couche one-shot (attaques, casts) : verrouille la sélection tant que le clip
// joue, fin par l'événement 'finished' du mixer ou interruption explicite.

const FADE = 0.25;
const FADE_JUMP = 0.12;
const FADE_ONESHOT_OUT = 0.15;

export class AnimationStateMachine implements Updatable {
  private current: ClipName | null = null;
  private wasClimbing = false; // front montant de la grimpe → one-shot d'accroche
  private readonly actions = new Map<ClipName, AnimationAction>();
  private oneShot: { name: ClipName; action: AnimationAction; onEnd: (() => void) | null } | null = null;

  constructor(
    private readonly mixer: AnimationMixer,
    clips: Partial<Record<ClipName, AnimationAction>>,
    private readonly player: CharacterController,
  ) {
    for (const [name, action] of Object.entries(clips)) {
      if (action) this.actions.set(name as ClipName, action);
    }
    const jump = this.actions.get('jump');
    if (jump) {
      jump.setLoop(LoopOnce, 1);
      jump.clampWhenFinished = true;
    }
    this.mixer.addEventListener('finished', (e) => {
      if (this.oneShot && e.action === this.oneShot.action) this.finishOneShot(true);
    });
    this.play('idle');
  }

  update(dt: number): void {
    // Accroche à la paroi : one-shot climbGrab par-dessus la locomotion, puis
    // retour naturel sur la boucle climb via 'finished'. Interrompu si on
    // quitte la paroi avant la fin (Espace immédiat, décroche basse) — sinon
    // le verrou one-shot maintiendrait la pose d'accroche en pleine chute
    const climbing = this.player.mode === 'climb';
    if (climbing && !this.wasClimbing && !this.oneShot) {
      this.playOneShot('climbGrab', { fade: 0.08 });
    } else if (!climbing && this.oneShot?.name === 'climbGrab') {
      this.interruptOneShot();
    }
    this.wasClimbing = climbing;

    if (!this.oneShot) {
      const target = this.stateFromController();
      if (target !== this.current) this.play(target);
    }

    // Anti-patinage : cadence des clips de locomotion liée à la vitesse réelle
    const speed = this.player.speed;
    this.setTimeScale('walk', speed / 2.0);
    this.setTimeScale('run', speed / MOVEMENT.runSpeed);
    this.setTimeScale('sprint', speed / MOVEMENT.sprintSpeed);
    // Grimpe : 0 = pause murale, négatif = descente (LoopRepeat rembobine)
    this.setTimeScale('climb', this.player.climbRate / CLIMB.climbSpeed, -CLIMB.timeScaleMax, CLIMB.timeScaleMax);
    // Plané : boucle ralentie (flottement), à peine plus vive en montée
    this.setTimeScale('glide', 0.8 + Math.max(0, this.player.glideVert) * 0.25, 0.6, 1.1);

    this.mixer.update(dt);
  }

  /**
   * Joue un clip UNE FOIS (attaque, cast) par-dessus la locomotion, verrouillée
   * jusqu'à la fin (événement 'finished') ou interruption. `timeScale` recadence
   * le clip sur la durée sim. Retourne false si le clip est absent (fallback
   * gracieux : le CombatSystem garde ses timings, seul le visuel manque).
   */
  playOneShot(name: ClipName, opts: { fade?: number; fitDuration?: number; onEnd?: () => void } = {}): boolean {
    const action = this.actions.get(name);
    if (!action) return false;
    if (this.oneShot) this.finishOneShot(false);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    // Recadence le clip sur la durée SIM (les timings de combat sont autoritaires)
    action.timeScale = opts.fitDuration ? action.getClip().duration / opts.fitDuration : 1;
    action.reset();
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.play();
    const prev = this.current ? this.actions.get(this.current) : undefined;
    if (prev && prev !== action) prev.crossFadeTo(action, opts.fade ?? 0.1, true);
    this.oneShot = { name, action, onEnd: opts.onEnd ?? null };
    this.current = name;
    return true;
  }

  /** Interrompt le one-shot en cours (coup reçu, mort) — retour locomotion. */
  interruptOneShot(): void {
    if (this.oneShot) this.finishOneShot(false);
  }

  get oneShotPlaying(): boolean {
    return this.oneShot !== null;
  }

  private finishOneShot(natural: boolean): void {
    const os = this.oneShot;
    if (!os) return;
    this.oneShot = null;
    this.current = os.name; // source du fade sortant
    this.play(this.stateFromController(), FADE_ONESHOT_OUT);
    if (natural) os.onEnd?.();
  }

  private stateFromController(): ClipName {
    const mode = this.player.mode;
    if (mode === 'air') return this.actions.has('jump') ? 'jump' : 'idle';
    // Plané (M9.3) : pose suspendue en boucle (Bar_Hang_Idle — bras levés vers
    // les poignées, jambes ballantes) ; repli pose jump du M7 si le GLB manque
    if (mode === 'glide') {
      if (this.actions.has('glide')) return 'glide';
      return this.actions.has('jump') ? 'jump' : 'idle';
    }
    if (mode === 'climb') return this.actions.has('climb') ? 'climb' : 'idle';
    if (mode === 'walk') return this.actions.has('walk') ? 'walk' : 'run';
    if (mode === 'sprint') return this.actions.has('sprint') ? 'sprint' : 'run';
    if (mode === 'run') return 'run';
    return 'idle';
  }

  private setTimeScale(name: ClipName, scale: number, lo = 0.4, hi = 1.6): void {
    const a = this.actions.get(name);
    if (a) a.timeScale = Math.min(Math.max(scale, lo), hi);
  }

  private play(name: ClipName, fadeOverride?: number): void {
    const action = this.actions.get(name);
    const next = action ?? this.actions.get('idle');
    if (!next) return;
    // Piège clip-absent (corrigé M4) : enregistrer le clip RÉELLEMENT joué —
    // sinon le crossfade suivant cherche l'absent et coupe sec (double anim)
    const resolved: ClipName = action ? name : 'idle';
    if (resolved === this.current) return;
    const fade = fadeOverride ?? (resolved === 'jump' ? FADE_JUMP : FADE);
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (this.current) {
      const prev = this.actions.get(this.current);
      if (prev && prev !== next) prev.crossFadeTo(next, fade, true);
    }
    this.current = resolved;
  }
}
