import { DataTexture, NearestFilter, RedFormat, Texture } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  clamp,
  cos,
  dFdx,
  dFdy,
  dot,
  float,
  floor,
  fract,
  hash,
  mix,
  normalView,
  oneMinus,
  positionViewDirection,
  sin,
  step,
  texture,
  vec2,
} from 'three/tsl';

// Aides TSL partagées par tous les matériaux toon.

// Alias lisibles des nœuds TSL dimensionnels de @types/three
type TslVec2 = Node<'vec2'>;
type TslVec3 = Node<'vec3'>;
type TslFloat = Node<'float'>;

/**
 * Rampe de dégradé pour MeshToonNodeMaterial : N marches de luminosité.
 * NearestFilter = transitions franches entre bandes (le look cel-shading).
 */
export function toonRamp(steps: number[] = [110, 190, 255]): DataTexture {
  const data = new Uint8Array(steps);
  const tex = new DataTexture(data, steps.length, 1, RedFormat);
  tex.minFilter = NearestFilter;
  tex.magFilter = NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** Terme de Fresnel (1 − N·V)^power — rim light des personnages. */
export function fresnel(power = 3.0) {
  const ndv = clamp(dot(normalView, positionViewDirection), 0, 1);
  return oneMinus(ndv).pow(power);
}

/**
 * Échantillonnage stochastique anti-répétition (hex-tiling simplifié, à la
 * Mikkelsen 2022) : l'UV tuilé est projeté sur une grille triangulaire ; chaque
 * sommet de cellule hash → offset + rotation aléatoires de l'UV ; les 3
 * échantillons sont mélangés par poids barycentriques aiguisés. Prérequis :
 * texture réellement seamless (les wraps traversent l'intérieur des cellules).
 *
 * `.grad()` avec les dérivées de l'UV CONTINU : les sauts d'offset/rotation par
 * cellule ne polluent jamais la sélection de mip (même piège que fract(), cf.
 * journal) — textureGrad existe sur les 2 backends (WGSL + GLSL ES 3.0).
 *
 * @param tex texture RepeatWrapping seamless
 * @param tiledUv UV déjà multiplié par le nombre de répétitions (1 unité = 1 tuile)
 * @param cellsPerTile densité de la grille : ~1 cellule pour 1/cellsPerTile tuiles
 */
export function stochasticTexture(tex: Texture, tiledUv: TslVec2, cellsPerTile = 0.8): TslVec3 {
  // Grille triangulaire : skew de l'UV puis découpe en 2 triangles par cellule
  const g = vec2(
    tiledUv.x.sub(tiledUv.y.mul(0.57735027)),
    tiledUv.y.mul(1.15470054),
  ).mul(cellsPerTile);
  const base = floor(g);
  const f = fract(g);
  const upper = step(1.0, f.x.add(f.y)); // 1 si triangle « haut » de la cellule

  // Sommets du triangle englobant + poids barycentriques associés
  const v1 = base.add(vec2(upper, upper)); // (0,0) ou (1,1)
  const v2 = base.add(vec2(1, 0));
  const v3 = base.add(vec2(0, 1));
  const w1 = mix(float(1).sub(f.x).sub(f.y), f.x.add(f.y).sub(1), upper);
  const w2 = mix(f.x, float(1).sub(f.y), upper);
  const w3 = mix(f.y, float(1).sub(f.x), upper);

  // Dérivées écran de l'UV continu, rotées comme l'UV de chaque échantillon
  const ddx = dFdx(tiledUv);
  const ddy = dFdy(tiledUv);

  const sampleAt = (v: TslVec2) => {
    // hash() tronque le seed en uint — et WGSL SATURE les flottants négatifs à
    // 0 : le seed doit être un entier positif unique par sommet de grille
    const seed = v.x.add(1024).add(v.y.add(1024).mul(3163));
    const h = hash(seed);
    const off = vec2(fract(h.mul(311.7)), fract(h.mul(127.1)));
    const ang = h.mul(6.2832);
    const c = cos(ang);
    const s = sin(ang);
    const rot = (p: TslVec2) =>
      vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
    return texture(tex, rot(tiledUv).add(off)).grad(rot(ddx), rot(ddy)).rgb;
  };

  // Aiguisage des poids (w^8 par carrés successifs — pow(0,·) est UB en GLSL) :
  // resserre les zones de blend pour limiter le « double exposure » au centre
  const sharp = (w: TslFloat) => {
    const w2 = w.mul(w);
    const w4 = w2.mul(w2);
    return w4.mul(w4);
  };
  const W1 = sharp(w1);
  const W2 = sharp(w2);
  const W3 = sharp(w3);
  const sum = W1.add(W2).add(W3);
  return sampleAt(v1).mul(W1)
    .add(sampleAt(v2).mul(W2))
    .add(sampleAt(v3).mul(W3))
    .div(sum);
}

/**
 * `emissiveNode` existe au runtime sur tout NodeMaterial (lu par setup()),
 * mais @types/three ne le déclare que sur MeshStandardNodeMaterial.
 */
export function setEmissiveNode(material: object, node: unknown): void {
  (material as { emissiveNode: unknown }).emissiveNode = node;
}
