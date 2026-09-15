import { HUD } from '../../config';

// Colonne d'équipe à droite, style référence strict : têtes flottantes
// détourées (AUCUN cercle ni bordure), pilule de nom + ◄ et barre de PV
// dessous sur l'actif seul, chip numéro blanche pour tous, collée au bord
// droit de l'écran. Slots 2-4 vides (« à recruter ») : silhouette sombre.
// Depuis M4 la barre de PV est RÉELLE (setHp piloté par le CombatSystem).

// Triangle ◄ en SVG : U+25C4 est absent du subset latin de Nunito Sans embarqué
const ARROW_LEFT = `
<svg viewBox="0 0 8 10"><path d="M8 0 L0 5 L8 10 Z" fill="currentColor" /></svg>`;

// Silhouette de buste (profil gauche) pour les slots vides
const SILHOUETTE = `
<svg viewBox="0 0 44 44">
  <path d="M20 5 C28 4 34 9 35 16 C35.5 20 34 24 31 27 L32 34 C33 36 34 37 35 38 C29 41 17 41 10 38 C11.5 36 13 34 13 31 L13 28 C10 25 8.5 20 9.5 15 C11 9 15 5.5 20 5 Z"
    fill="currentColor" />
</svg>`;

export class PartySlots {
  private readonly hpFill: HTMLDivElement | null;
  private readonly activeSlot: HTMLDivElement | null;

  constructor(parent: HTMLElement, portraitUrl: string | null) {
    const el = document.createElement('div');
    el.className = 'party-slots';

    const slots: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const active = i === 1;
      const head = active && portraitUrl
        ? `<div class="slot-head"><img src="${portraitUrl}" alt="" /></div>`
        : `<div class="slot-head silhouette">${SILHOUETTE}</div>`;
      slots.push(`
        <div class="party-slot ${active ? 'active' : 'empty'}">
          ${active ? `
          <div class="slot-info">
            <div class="slot-name">${HUD.partyLeaderName}<span class="slot-arrow">${ARROW_LEFT}</span></div>
            <div class="slot-hp"><div class="slot-hp-fill" style="width:100%"></div></div>
          </div>` : ''}
          ${head}
          <span class="slot-key key-chip">${i}</span>
        </div>`);
    }
    el.innerHTML = slots.join('');
    parent.appendChild(el);

    this.hpFill = el.querySelector<HTMLDivElement>('.slot-hp-fill');
    this.activeSlot = el.querySelector<HTMLDivElement>('.party-slot.active');
  }

  /** PV du leader (fraction 0..1) — rouge sous 30 %. */
  setHp(frac: number): void {
    if (!this.hpFill) return;
    this.hpFill.style.width = `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%`;
    this.hpFill.classList.toggle('low', frac < 0.3);
  }

  /** Flash blanc du slot au coup reçu. */
  flashDamage(): void {
    if (!this.activeSlot) return;
    this.activeSlot.classList.add('hurt-flash');
    setTimeout(() => this.activeSlot?.classList.remove('hurt-flash'), 250);
  }
}
