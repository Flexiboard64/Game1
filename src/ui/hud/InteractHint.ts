import type { Vector3 } from 'three/webgpu';
import { HUD } from '../../config';

// Prompt d'interaction façon Genshin : pilule sombre « F · … ». Deux sources :
// l'override prioritaire (train : « Monter à bord »/« Descendre », câblé sur F
// dans RideController) et la proximité des mufliers (décoratif, F inerte).

const RANGE = HUD.interactRangeM;

export class InteractHint {
  private readonly el: HTMLDivElement;
  private readonly labelEl: HTMLSpanElement;
  private visible = false;
  private label = '';
  private override: string | null = null;

  constructor(parent: HTMLElement, private readonly anchors: readonly Vector3[]) {
    this.el = document.createElement('div');
    this.el.className = 'interact-hint';
    this.el.innerHTML = '<span class="key-chip">F</span><span class="interact-label">Muflier</span>';
    this.labelEl = this.el.querySelector('.interact-label')!;
    parent.appendChild(this.el);
  }

  /** Libellé prioritaire (null = retour au comportement muflier). */
  setOverride(label: string | null): void {
    this.override = label;
  }

  update(playerPos: Vector3): void {
    let show = false;
    let label = '';
    if (this.override) {
      show = true;
      label = this.override;
    } else {
      for (const a of this.anchors) {
        const dx = a.x - playerPos.x;
        const dz = a.z - playerPos.z;
        if (dx * dx + dz * dz < RANGE * RANGE) {
          show = true;
          label = 'Muflier';
          break;
        }
      }
    }
    if (label !== this.label && show) {
      this.label = label;
      this.labelEl.textContent = label;
    }
    if (show !== this.visible) {
      this.visible = show;
      this.el.classList.toggle('visible', show);
    }
  }
}
