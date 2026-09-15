import { BOSS } from '../../config';
import type { BossEnemy } from '../../combat/BossEnemy';

// Barre de boss (M6) : top-centre, nom + barre de PV + liseré de phase.
// Visible uniquement pendant le combat d'arène.

export class BossBar {
  private readonly el: HTMLDivElement;
  private readonly fill: HTMLDivElement;
  private shown = false;
  private lastPhase = 1;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'boss-bar';
    this.el.innerHTML = `
      <div class="boss-name">${BOSS.name}</div>
      <div class="boss-track"><div class="boss-fill"></div></div>`;
    parent.appendChild(this.el);
    this.fill = this.el.querySelector<HTMLDivElement>('.boss-fill')!;
  }

  update(boss: BossEnemy | null): void {
    const show = !!boss && boss.engaged;
    if (show !== this.shown) {
      this.shown = show;
      this.el.classList.toggle('visible', show);
    }
    if (!boss || !show) return;
    // Le bouclier s'affiche PAR-DESSUS : la barre gèle et bleuit pendant P2
    const shielded = boss.shieldHp > 0;
    this.fill.style.width = `${((boss.hp / boss.maxHp) * 100).toFixed(1)}%`;
    this.el.classList.toggle('shielded', shielded);
    if (boss.phase !== this.lastPhase) {
      this.lastPhase = boss.phase;
      this.el.classList.remove('phase-pulse');
      void this.el.offsetWidth; // relance l'animation CSS
      this.el.classList.add('phase-pulse');
    }
  }
}
