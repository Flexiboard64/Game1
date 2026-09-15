import { HUD } from '../../config';

// Carte de région : nom en grande police display entre deux filets d'or,
// fondu entrée 0.6 s → maintien 2.5 s → sortie 0.8 s. REJOUABLE (M5) : les
// arrivées du train affichent la région de destination — l'élément n'est plus
// retiré du DOM, les timers en cours sont annulés à chaque show().

export class RegionTitle {
  private readonly el: HTMLDivElement;
  private readonly nameEl: HTMLDivElement;
  private readonly subEl: HTMLDivElement;
  private tHide: ReturnType<typeof setTimeout> | null = null;
  private tOff: ReturnType<typeof setTimeout> | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'region-title';
    this.el.innerHTML = `
      <div class="region-rule"></div>
      <div class="region-name"></div>
      <div class="region-sub"></div>
      <div class="region-rule"></div>`;
    this.nameEl = this.el.querySelector('.region-name')!;
    this.subEl = this.el.querySelector('.region-sub')!;
    parent.appendChild(this.el);
  }

  show(title: string = HUD.regionTitle, subtitle: string = HUD.regionSubtitle): void {
    if (this.tHide) clearTimeout(this.tHide);
    if (this.tOff) clearTimeout(this.tOff);
    this.nameEl.textContent = title;
    this.subEl.textContent = subtitle;
    // Repartir d'un état neutre puis forcer un reflow pour rejouer la transition
    this.el.classList.remove('show', 'hide');
    void this.el.offsetWidth;
    this.el.classList.add('show');
    this.tHide = setTimeout(() => this.el.classList.add('hide'), 3100);
    this.tOff = setTimeout(() => this.el.classList.remove('show', 'hide'), 4200);
  }
}
