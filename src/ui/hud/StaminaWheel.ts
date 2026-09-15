import { Vector3, type PerspectiveCamera } from 'three/webgpu';
import type { CharacterController } from '../../player/CharacterController';

// Jauge d'endurance ancrée au personnage : arc 270° or qui se vide dans le sens
// horaire, rouge sous 25 %, visible uniquement en sprint/régénération, fondu 1 s
// après remplissage complet. Position : projection monde→écran + décalage droit.

const R = 30;
const CIRC = 2 * Math.PI * R;
const ARC = 0.75; // 270°

export class StaminaWheel {
  private readonly el: HTMLDivElement;
  private readonly arc: SVGCircleElement;
  // -Infinity = « pleine depuis toujours » : la roue reste cachée au spawn
  // (Infinity signifierait « pas encore re-pleine » et l'afficherait 1 s)
  private fullSince = -Infinity;
  private elapsed = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'stamina-wheel';
    this.el.innerHTML = `
      <svg viewBox="0 0 76 76">
        <circle cx="38" cy="38" r="${R}" fill="none" stroke="rgba(10,12,18,0.45)"
          stroke-width="6" stroke-dasharray="${ARC * CIRC} ${CIRC}"
          stroke-linecap="round" transform="rotate(135 38 38)" />
        <circle class="stamina-arc" cx="38" cy="38" r="${R}" fill="none"
          stroke-width="6" stroke-dasharray="${ARC * CIRC} ${CIRC}"
          stroke-linecap="round" transform="rotate(135 38 38)" />
      </svg>`;
    parent.appendChild(this.el);
    this.arc = this.el.querySelector<SVGCircleElement>('.stamina-arc')!;
  }

  update(dt: number, player: CharacterController, camera: PerspectiveCamera, anchor: Vector3): void {
    this.elapsed += dt;
    const st = player.stamina;
    const frac = st.value / st.max;

    if (frac >= 1) {
      if (this.fullSince === Infinity) this.fullSince = this.elapsed;
    } else {
      this.fullSince = Infinity;
    }
    const visible = st.sprinting || (frac < 1) || this.elapsed - this.fullSince < 1;
    this.el.classList.toggle('visible', visible);
    if (!visible) return;

    // Arc restant (se vide en sens horaire depuis le haut de l'arc)
    this.arc.setAttribute('stroke-dasharray', `${frac * ARC * CIRC} ${CIRC}`);
    this.arc.style.stroke = frac < 0.25 ? '#E5484D' : '#f5d67b';

    // Ancrage au personnage : légèrement au-dessus de la taille, décalé à droite
    // (position visuelle interpolée — la même que le modèle rendu)
    _anchor.copy(anchor);
    _anchor.y += 1.15;
    _anchor.project(camera);
    if (_anchor.z > 1) {
      this.el.classList.remove('visible');
      return;
    }
    const x = (_anchor.x * 0.5 + 0.5) * window.innerWidth + 90;
    const y = (-_anchor.y * 0.5 + 0.5) * window.innerHeight;
    this.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
  }
}

const _anchor = new Vector3();
