// Indication de chat en bas à gauche, style référence : deux chips blanches
// accolées — bulle sombre sur carré blanc + touche « Entrée ».
// Décorative en v1 — un vrai chat/journal viendra avec le multijoueur simulé.

// Bulle remplie avec queue et 3 points évidés (sombre sur chip blanche)
const BUBBLE = `
<svg viewBox="0 0 20 18">
  <path d="M3 1.5 H17 C18.4 1.5 19.5 2.6 19.5 4 V11 C19.5 12.4 18.4 13.5 17 13.5 H8.5 L4 17 V13.5 H3 C1.6 13.5 0.5 12.4 0.5 11 V4 C0.5 2.6 1.6 1.5 3 1.5 Z" fill="currentColor" />
  <circle cx="6.2" cy="7.5" r="1.3" fill="#FFFFFA" />
  <circle cx="10" cy="7.5" r="1.3" fill="#FFFFFA" />
  <circle cx="13.8" cy="7.5" r="1.3" fill="#FFFFFA" />
</svg>`;

export class ChatHint {
  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.className = 'chat-hint';
    el.innerHTML = `
      <span class="key-chip chat-chip">${BUBBLE}</span>
      <span class="key-chip">Entrée</span>`;
    parent.appendChild(el);
  }
}
