// Glyphes SVG line-art originaux du HUD (compétences, minimap, saut).
// Les icônes de menu/chat sont des PNG peints (public/assets/ui/icons/) ; les
// 7 glyphes d'éléments de l'écran de chargement vivent dans index.html.

/** Glyphe de compétence : rafale de vent — trois virgules d'air imbriquées. */
export const SKILL_GLYPH = `
<svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round">
  <path d="M8 26 C14 24 18 19 19 12 C23 15 24 21 22 26 C27 24 31 20 32 14 C35 19 34 26 30 30 C25 35 15 35 10 31" />
  <path d="M14 18 C15 15 17 13 20 12" opacity="0.6" />
</svg>`;

/** Glyphe d'ultime : tourbillon complet avec étoile de vent au centre. */
export const BURST_GLYPH = `
<svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
  <path d="M22 6 C31 6 38 13 38 22 C38 31 31 38 22 38 C13 38 6 31 6 22 C6 15 11 9 18 8" />
  <path d="M22 13 C27 13 31 17 31 22 C31 27 27 31 22 31 C17 31 13 27 13 22 C13 18 16 15 19 14" />
  <path d="M22 19 L23.5 21 L26 22 L23.5 23 L22 25 L20.5 23 L18 22 L20.5 21 Z" fill="currentColor" stroke="none" />
</svg>`;

/** Flèche du joueur au centre de la minimap. */
export const PLAYER_ARROW = `
<svg viewBox="0 0 24 24">
  <path d="M12 3 L18 19 L12 15.5 L6 19 Z" fill="#FFFFF0" stroke="#c9a86a" stroke-width="1" stroke-linejoin="round" />
</svg>`;

/** Cône de vision 60° de la minimap (pointe vers le haut).
 * Bord extérieur à r=48 < 50 : le cône meurt DANS le fondu du mask de la carte
 * (un arc à r>50 déborderait du disque et serait tranché net par le viewBox). */
export const VIEW_CONE = `
<svg viewBox="0 0 100 100">
  <defs>
    <linearGradient id="cone-grad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.42" />
      <stop offset="1" stop-color="#ffffff" stop-opacity="0" />
    </linearGradient>
  </defs>
  <path d="M50 50 L26 8.4 A48 48 0 0 1 74 8.4 Z" fill="url(#cone-grad)" />
</svg>`;



/** Bouton saut : double chevron vers le haut. */
export const JUMP_GLYPH = `
<svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 24 L22 14 L32 24" />
  <path d="M12 33 L22 23 L32 33" opacity="0.6" />
</svg>`;
