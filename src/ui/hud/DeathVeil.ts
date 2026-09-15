// Voile de mort (« Vous êtes à terre ») + vignette rouge de dégâts. Éléments
// SÉPARÉS du #pointer-veil : celui-ci appartient au cycle du pointer lock et
// doit continuer le sien. La vignette est un overlay DOM (pas un uniform du
// post) : survit à ?nopost et aux replis du pipeline sur les 2 backends.

export class DeathVeil {
  private readonly veil: HTMLDivElement;

  constructor() {
    this.veil = document.createElement('div');
    this.veil.id = 'death-veil';
    this.veil.innerHTML = '<span>Vous êtes à terre</span>';
    document.body.appendChild(this.veil);
  }

  show(): void {
    this.veil.classList.add('visible');
  }

  hide(): void {
    this.veil.classList.remove('visible');
  }
}

export class DamageVignette {
  private readonly el: HTMLDivElement;
  private flashT = 0;

  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'damage-vignette';
    document.body.appendChild(this.el);
  }

  flash(): void {
    this.flashT = 0.5;
    this.el.classList.add('hurt');
  }

  update(dt: number, hpFrac: number): void {
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.el.classList.remove('hurt');
    }
    this.el.classList.toggle('low-hp', hpFrac < 0.3 && hpFrac > 0);
  }
}
