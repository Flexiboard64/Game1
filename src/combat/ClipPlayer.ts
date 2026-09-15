import { AnimationAction, LoopOnce, LoopRepeat } from 'three/webgpu';

// Mini-lecteur d'animation générique des golems : boucles + one-shots avec
// crossfade, garde clip-absent, rejeu du même one-shot autorisé (spam de coups).
// L'AnimationStateMachine du joueur reste dédiée (couplée au contrôleur).

export class ClipPlayer<K extends string> {
  private current: K | null = null;

  constructor(private readonly actions: Partial<Record<K, AnimationAction>>) {}

  play(name: K, opts: { loop?: boolean; fade?: number; fitDuration?: number } = {}): void {
    const a = this.actions[name];
    if (!a) return; // clip absent : l'état sim continue, seul le visuel manque
    if (this.current === name && opts.loop) return; // déjà en boucle
    a.setLoop(opts.loop ? LoopRepeat : LoopOnce, opts.loop ? Infinity : 1);
    a.clampWhenFinished = !opts.loop;
    a.timeScale = opts.fitDuration ? a.getClip().duration / opts.fitDuration : 1;
    a.reset();
    a.enabled = true;
    a.setEffectiveWeight(1);
    a.play();
    const prev = this.current ? this.actions[this.current] : undefined;
    if (prev && prev !== a) prev.crossFadeTo(a, opts.fade ?? 0.15, true);
    this.current = name;
  }
}
