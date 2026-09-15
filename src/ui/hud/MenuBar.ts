// Rangée d'icônes de menu en haut à droite (style Genshin) : 5 grandes icônes
// peintes (Magnific, découpe luminance→alpha locale — cf. assets-manifest) +
// pastilles rouges + compteur de FPS en pilule sous l'icône de profil.
// Icônes décoratives en v1 (#hud est pointer-events:none, jeu en pointer-lock).

const ICONS = ['compass', 'star', 'book', 'bag', 'profile'] as const;
const BADGED = new Set(['star', 'book']);

// Barres de signal croissantes, vertes — spécifique au composant
const PING_BARS = `
<svg viewBox="0 0 14 12" fill="#6fe26f">
  <rect x="0" y="7" width="3" height="5" rx="0.8" />
  <rect x="5" y="4" width="3" height="8" rx="0.8" />
  <rect x="10" y="0" width="3" height="12" rx="0.8" />
</svg>`;

export class MenuBar {
  private readonly fpsEl: HTMLSpanElement;
  private frames = 0;
  private acc = 0;

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'menu-bar';
    el.innerHTML = ICONS.map((name) => `
      <span class="menu-icon${BADGED.has(name) ? ' has-badge' : ''}">
        <img src="/assets/ui/icons/${name}.png" alt="" />
      </span>`).join('')
      + `<div class="menu-ping">${PING_BARS}<span class="menu-fps">— fps</span></div>`;
    parent.appendChild(el);
    this.fpsEl = el.querySelector<HTMLSpanElement>('.menu-fps')!;
  }

  /** Compteur d'images par seconde, rafraîchi 2×/s (écriture DOM throttlée). */
  update(dt: number): void {
    this.frames++;
    this.acc += dt;
    if (this.acc >= 0.5) {
      this.fpsEl.textContent = `${Math.round(this.frames / this.acc)} fps`;
      this.frames = 0;
      this.acc = 0;
    }
  }
}
