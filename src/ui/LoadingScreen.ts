// Pilote l'écran de chargement statique d'index.html : les 7 glyphes se
// remplissent séquentiellement de leur couleur selon la progression réelle.
// Glyphe i rempli à clamp(p·7 − i, 0, 1) — remplissage strictement séquentiel.

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly clipRects: SVGRectElement[];
  private displayed = 0;
  private target = 0;
  private rafId = 0;

  constructor() {
    this.root = document.getElementById('loading-screen')!;
    this.clipRects = Array.from(this.root.querySelectorAll<SVGRectElement>('clipPath rect'));
    const tick = () => {
      // Lissage visuel : la barre rattrape la cible sans à-coups
      this.displayed += (this.target - this.displayed) * 0.12;
      if (this.target >= 1 && this.target - this.displayed < 0.002) this.displayed = 1;
      this.render();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  setProgress(ratio: number): void {
    this.target = Math.min(Math.max(ratio, this.target), 1);
  }

  private render(): void {
    const n = this.clipRects.length;
    for (let i = 0; i < n; i++) {
      const fill = Math.min(Math.max(this.displayed * n - i, 0), 1);
      const rect = this.clipRects[i]!;
      rect.setAttribute('y', String(44 * (1 - fill)));
      rect.setAttribute('height', String(44 * fill));
      rect.setAttribute('width', '44');
      rect.setAttribute('x', '0');
    }
  }

  /** Fondu de sortie une fois la première frame rendue, puis retrait du DOM. */
  async finish(): Promise<void> {
    this.target = 1;
    // Laisse la rampe visuelle atteindre 100 %
    await new Promise((r) => setTimeout(r, 350));
    cancelAnimationFrame(this.rafId);
    this.render();
    this.root.classList.add('hidden');
    await new Promise((r) => setTimeout(r, 500));
    this.root.remove();
  }
}
