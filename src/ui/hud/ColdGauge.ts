import { COLD } from '../../config';

// Jauge de froid mordant (M6) : cristal circulaire bas-centre, rempli en arc
// (conic-gradient CSS — zéro canvas), pulse + vignette givre au-delà du seuil.
// Cachée à zéro. Le HUD TIRE l'état de ColdSystem (jamais l'inverse).

export class ColdGauge {
  private readonly el: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private readonly frost: HTMLDivElement;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'cold-gauge';
    this.el.innerHTML = `
      <div class="cold-ring"></div>
      <svg class="cold-flake" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round">
        <path d="M12 2v20M4 6l16 12M20 6L4 18M12 6l-2.4-2.4M12 6l2.4-2.4M12 18l-2.4 2.4M12 18l2.4 2.4"/>
      </svg>`;
    parent.appendChild(this.el);
    this.ring = this.el.querySelector<HTMLDivElement>('.cold-ring')!;

    // Vignette givre plein écran (opacité pilotée)
    this.frost = document.createElement('div');
    this.frost.className = 'frost-vignette';
    parent.appendChild(this.frost);
  }

  update(cold01: number): void {
    const show = cold01 > 0.02;
    if (show !== this.shown) {
      this.shown = show;
      this.el.classList.toggle('visible', show);
    }
    if (!show) {
      this.frost.style.opacity = '0';
      return;
    }
    const deg = Math.round(cold01 * 360);
    this.ring.style.background =
      `conic-gradient(rgba(159,214,227,0.95) ${deg}deg, rgba(20,35,63,0.55) ${deg}deg)`;
    this.el.classList.toggle('warn', cold01 > COLD.warnAt);
    this.frost.style.opacity = String(Math.max(0, (cold01 - COLD.warnAt) / (1 - COLD.warnAt)) * 0.85);
  }
}
