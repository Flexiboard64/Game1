import type { Vector3 } from 'three/webgpu';
import { HUD } from '../../config';

// Tracker de quête sous la minimap, design référence : bannière « ! » sur
// carré blanc seule sur sa ligne, objectif en gras (police gothique arrondie)
// derrière une puce losange cyan + distance live (4 Hz), et ligne d'action
// « P Abandonner le défi » en lien cyan souligné (décoratif).

export class QuestTracker {
  private readonly distanceEl: HTMLSpanElement;
  private readonly objectiveEl: HTMLSpanElement;
  private accumulator = 0;
  private lastShown = -1;

  constructor(parent: HTMLElement, _questPos: Vector3) {
    const el = document.createElement('div');
    el.className = 'quest-tracker';
    el.innerHTML = `
      <div class="quest-banner"><img src="/assets/ui/icons/quest-banner.png" alt="" /></div>
      <div class="quest-objective"><img class="quest-bullet" src="/assets/ui/icons/quest-bullet.png" alt="" /><span><span class="quest-text">${HUD.questObjective}</span> · <span class="quest-distance">—</span></span></div>
      <div class="quest-action"><span class="key-chip">P</span><span class="quest-link">${HUD.questAction}</span></div>`;
    parent.appendChild(el);
    this.distanceEl = el.querySelector<HTMLSpanElement>('.quest-distance')!;
    this.objectiveEl = el.querySelector<HTMLSpanElement>('.quest-text')!;
  }

  /** Objectif dynamique (M6 : compteur de cristaux de givre). */
  setObjective(text: string): void {
    this.objectiveEl.textContent = text;
  }

  update(dt: number, playerPos: Vector3, questPos: Vector3): void {
    this.accumulator += dt;
    if (this.accumulator < 0.25) return; // 4 Hz
    this.accumulator = 0;
    const d = Math.ceil(playerPos.distanceTo(questPos));
    if (d !== this.lastShown) {
      this.lastShown = d;
      this.distanceEl.textContent = `${d} m`;
    }
  }
}
