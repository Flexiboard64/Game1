import {
  AdditiveBlending,
  BackSide,
  Color,
  DataTexture,
  MeshBasicNodeMaterial,
  MeshToonNodeMaterial,
  Texture,
} from 'three/webgpu';
import type { Node } from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  clamp,
  color,
  dot,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  time,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
  normalLocal,
} from 'three/tsl';
import { AMBIENCE, CANYON, CASCADE, CITY, CREVASSE, GRASS, MESA, PALETTE, PROPS, SEA_ICE, SUN, TERRAIN, WATER } from '../config';
import { fresnel, setEmissiveNode, stochasticTexture, toonRamp } from './tsl';

// Fabrique de tous les matériaux du jeu — la direction artistique cel-shading
// vit intégralement ici (rampes, rim, splat, contours, vent de l'herbe).

export interface WaterBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

const sharedRamp = toonRamp();

export const ToonMaterials = {
  /** Personnage : albédo baked Meshy + rampe toon + rim light doux. */
  character(albedo: Texture): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ map: albedo, gradientMap: sharedRamp });
    setEmissiveNode(m, fresnel(3.0).mul(color('#9fb8c9')).mul(0.28));
    return m;
  },

  /** Capsule placeholder en attendant le modèle Meshy. */
  placeholder(): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ color: new Color('#cfe3da'), gradientMap: sharedRamp });
    setEmissiveNode(m, fresnel(3.0).mul(color('#9fb8c9')).mul(0.25));
    return m;
  },

  /** Terrain : 3 couches tileables pondérées par la splatmap + variation macro (canal A). */
  terrain(
    grass: Texture,
    dirt: Texture,
    rock: Texture,
    splat: DataTexture,
  ): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ gradientMap: sharedRamp });
    // PAS de fract() ici : la discontinuité casserait les dérivées écran et
    // forcerait le plus petit mip en lignes baveuses à chaque bord de tuile.
    // RepeatWrapping (posé + needsUpdate dans AssetManager) gère la répétition.
    // Dé-tuilage stochastique (cf. stochasticTexture) : offsets + rotations
    // aléatoires par cellule — exige des textures seamless.
    const uvT = uv().mul(TERRAIN.textureRepeat);
    const s = texture(splat, uv());
    // Couche HERBE : le JPEG (chartreuse sat 0,76) devient PURE variation de
    // valeur, re-teintée par les stops de PALETTE.grassGreens — la MÊME autorité
    // couleur que les brins d'herbe : la couture sol/brin disparaît
    const gRaw = stochasticTexture(grass, uvT, TERRAIN.detileCells);
    const gLum = gRaw.r.mul(0.2126).add(gRaw.g.mul(0.7152)).add(gRaw.b.mul(0.0722));
    const gT = smoothstep(float(GRASS.lumLo), float(GRASS.lumHi), gLum);
    const gCol = mix(color(PALETTE.grassGreens.deep), color(PALETTE.grassGreens.tip), gT);
    const layered = gCol.mul(s.r)
      .add(stochasticTexture(dirt, uvT, TERRAIN.detileCells).mul(s.g))
      .add(stochasticTexture(rock, uvT, TERRAIN.detileCells).mul(s.b));
    // Variation macro : casse la répétition des tuiles à grande distance
    const macroTint = mix(float(0.86), float(1.1), s.a);
    m.colorNode = layered.mul(macroTint);
    return m;
  },

  /** Terrain de debug (avant téléchargement des textures) : couleurs plates par canal. */
  terrainDebug(splat: DataTexture): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ gradientMap: sharedRamp });
    const s = texture(splat, uv());
    m.colorNode = vec3(0.36, 0.55, 0.28).mul(s.r)
      .add(vec3(0.48, 0.38, 0.26).mul(s.g))
      .add(vec3(0.44, 0.46, 0.5).mul(s.b))
      .mul(mix(float(0.86), float(1.1), s.a));
    return m;
  },

  /** Pierres du cairn de quête. */
  stone(): MeshToonNodeMaterial {
    return new MeshToonNodeMaterial({ color: new Color('#8b8e96'), gradientMap: sharedRamp });
  },

  /** Prop statique instancié : albédo Meshy + rampe partagée + rim atténué. */
  prop(albedo: Texture | null): MeshToonNodeMaterial {
    const m = albedo
      ? new MeshToonNodeMaterial({ map: albedo, gradientMap: sharedRamp })
      : new MeshToonNodeMaterial({ color: new Color('#cfe3da'), gradientMap: sharedRamp });
    setEmissiveNode(m, fresnel(3.0).mul(color('#9fb8c9')).mul(0.12));
    return m;
  },

  /**
   * Prop de quête « éveillé » : l'albédo Meshy lui-même devient la carte
   * émissive (teintée) — les facettes claires du cristal s'illuminent selon
   * leur propre dessin, ≥ 1,5 linéaire sur les zones vives → pris par le bloom.
   */
  glowProp(albedo: Texture | null, tint: string, intensity: number): MeshToonNodeMaterial {
    const m = this.prop(albedo);
    if (albedo) setEmissiveNode(m, texture(albedo).rgb.mul(color(tint)).mul(intensity));
    else setEmissiveNode(m, color(tint).mul(intensity * 0.8));
    return m;
  },

  /**
   * Feuillage : prop() + balancement TSL gated par la hauteur locale (le tronc
   * reste planté). La géométrie est normalisée en mètres par PropLoader, donc
   * l'amplitude est directement en unités monde.
   */
  foliage(albedo: Texture | null, height: number): MeshToonNodeMaterial {
    const m = this.prop(albedo);
    // positionGeometry (attribut PRÉ-instancing) : three applique l'instancing
    // AVANT positionNode, donc positionLocal.y serait ici le Y MONDE du sommet
    // (le gate dépendrait de l'altitude du terrain — trouvé en revue)
    const gate = smoothstep(float(height * 0.35), float(height), positionGeometry.y);
    const phase = hash(instanceIndex).mul(6.2832);
    const sway = sin(time.mul(0.6).add(phase)).mul(0.5)
      .add(sin(time.mul(1.1).add(phase.mul(1.7))).mul(0.5))
      .mul(gate)
      .mul(0.05);
    m.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6)));
    return m;
  },

  /**
   * Billboard de fleurs sauvages : sous-UV d'atlas 2×2, variante par instance,
   * cutout alpha-test (PAS transparent:true — l'herbe est déjà transparente,
   * empiler des quads transparents créerait un tri incorrigible ; le cutout se
   * dessine en passe opaque, l'herbe blende par-dessus — correct sur 2 backends).
   * Le fade distance module l'opacité AVANT l'alphaTest → dissolution progressive.
   */
  flowerBillboard(atlas: Texture, row: 0 | 1): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ gradientMap: sharedRamp });
    const colIdx = step(0.5, hash(instanceIndex.add(13)));
    // row 0 = rangée du HAUT de l'atlas (jaunes) → offset v 0.5 (v=1 en haut)
    const auv = uv().mul(0.5).add(vec2(colIdx.mul(0.5), row === 0 ? 0.5 : 0.0));
    const t = texture(atlas, auv);
    const tint = mix(float(0.9), float(1.1), hash(instanceIndex.add(29)));
    m.colorNode = t.rgb.mul(tint);

    const dist = positionWorld.sub(cameraPosition).length();
    const fade = smoothstep(float(PROPS.flowerFadeStart), float(PROPS.flowerFadeEnd), dist).oneMinus();
    m.opacityNode = t.a.mul(fade);
    m.alphaTest = 0.35;
    m.transparent = false;
    m.side = 2; // DoubleSide

    const phase = hash(instanceIndex.add(3)).mul(6.2832);
    const bendW = uv().y.pow(2);
    const sway = sin(time.mul(1.3).add(phase)).mul(bendW).mul(0.05);
    m.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.55)));
    return m;
  },

  /**
   * Touffe d'herbe instanciée : passe OPAQUE + alphaTest (early-Z, zéro tri),
   * autorité couleur = PALETTE.grassGreens (les MÊMES stops que le sol) +
   * macroTint partagé via la splatmap, normale forcée vers le haut (même bande
   * toon que le sol jusqu'à ~27° de pente — supprime les brins « éteints »),
   * vent + rafales macro, dissolution de distance PAR BRIN.
   */
  grassBlade(splat: DataTexture, fadeStart: number, fadeEnd: number): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ gradientMap: sharedRamp });
    // @types/three type attribute(name, type) en AttributeNode<string> — cast dimensionnel
    const blade = attribute('aBlade', 'vec2') as unknown as Node<'vec2'>;

    // Vent : phase par touffe (hash) désynchronisée par brin (aBlade.x) +
    // rafale macro qui traverse la prairie. positionLocal est POST-instancing :
    // son .xz est bien la position monde de la touffe pour le bruit de rafale.
    const phase = hash(instanceIndex).mul(6.2832).add(blade.x);
    const bendW = uv().y.pow(2);
    const gust = sin(time.mul(1.7).add(phase)).mul(0.5).add(sin(time.mul(0.9).add(phase.mul(1.7))).mul(0.5));
    const macroGust = mx_noise_float(
      positionLocal.xz.mul(GRASS.gustFreq).add(vec2(time.mul(GRASS.gustSpeed), 0)),
    ).mul(0.5).add(1.0);
    const sway = gust.mul(bendW).mul(GRASS.swayAmp).mul(macroGust);
    m.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.55)));

    // Couleur : dégradé racine(AO de contact)→pointe des stops PALETTE + le MÊME
    // macroTint que le terrain (canal A de la splat par UV monde, flipY compensé)
    const rootCol = color(PALETTE.grassGreens.deep).mul(0.85);
    const tipCol = color(PALETTE.grassGreens.tip);
    const tint = mix(float(0.85), float(1.12), hash(instanceIndex.add(7))); // VALEUR seule, jamais la teinte
    const splatUv = vec2(
      positionWorld.x.div(TERRAIN.size).add(0.5),
      float(0.5).sub(positionWorld.z.div(TERRAIN.size)),
    );
    const macroTint = mix(float(0.86), float(1.1), texture(splat, splatUv).a);
    m.colorNode = mix(rootCol, tipCol, uv().y.pow(1.3)).mul(tint).mul(macroTint);

    // Normale d'éclairage forcée vers le haut : bande toon 255 garantie, comme
    // le sol herbeux — un brin vertical tombait 1 fois sur 3 dans la bande −25 %
    m.normalNode = transformNormalToView(vec3(0, 1, 0));

    // Dissolution de distance PAR BRIN (aléa aBlade.y) AVANT l'alphaTest :
    // les touffes s'égrènent brin par brin au lieu de disparaître en bloc
    const dist = positionWorld.sub(cameraPosition).length();
    const fade = smoothstep(float(fadeStart), float(fadeEnd), dist).oneMinus();
    m.opacityNode = fade.sub(blade.y.mul(GRASS.fadeStagger));
    m.alphaTest = GRASS.alphaTest;
    m.transparent = false; // passe opaque : early-Z, zéro tri, MSAA natif
    m.side = 2; // DoubleSide

    return m;
  },

  /** Contour inverted-hull : coque gonflée le long des normales, faces arrière. */
  outline(width = 0.02): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ color: new Color(PALETTE.outline), side: BackSide });
    m.positionNode = positionLocal.add(normalLocal.normalize().mul(width));
    return m;
  },

  /**
   * Golem (M4) : toon + DISSOLUTION de mort (cutout par seuil de bruit en espace
   * bind-pose — stable pendant l'anim — avec liseré émissif anémo HDR) + flash
   * blanc de coup. Les deux uniforms sont PAR INSTANCE : un set par clone,
   * même graphe de nœuds ⇒ le cache de programme est partagé.
   */
  golemSet(albedo: Texture | null, outlineWidth: number, edgeTint: string = PALETTE.elements.anemo): {
    material: MeshToonNodeMaterial;
    outlineMaterial: MeshBasicNodeMaterial;
    dissolve: { value: number };
    hitFlash: { value: number };
  } {
    const uDissolve = uniform(0);
    const uHitFlash = uniform(0);
    // Masque en espace géométrie (PRÉ-skinning) : le motif de dissolution ne
    // « nage » pas quand le squelette bouge
    const mask = mx_noise_float(positionGeometry.xyz.mul(2.2)).mul(0.5).add(0.5);
    const alive = step(uDissolve, mask); // 1 tant que le seuil n'a pas mangé ce texel

    const m = albedo
      ? new MeshToonNodeMaterial({ map: albedo, gradientMap: sharedRamp })
      : new MeshToonNodeMaterial({ color: new Color('#7d8a6f'), gradientMap: sharedRamp });
    m.opacityNode = alive;
    m.alphaTest = 0.5;
    m.transparent = false; // cutout : early-Z, MSAA natif, zéro tri
    const edge = smoothstep(0.0, 0.12, mask.sub(uDissolve)).oneMinus()
      .mul(step(0.001, uDissolve)); // pas de liseré tant que la dissolution n'a pas commencé
    setEmissiveNode(
      m,
      fresnel(3.0).mul(color('#9fb8c9')).mul(0.14)
        .add(color(edgeTint).mul(edge).mul(3.0)) // liseré HDR → bloom (anémo, ou cryo côté neige)
        .add(color('#ffffff').mul(uHitFlash)),
    );

    const o = new MeshBasicNodeMaterial({ color: new Color(PALETTE.outline), side: BackSide });
    o.positionNode = positionLocal.add(normalLocal.normalize().mul(outlineWidth));
    o.opacityNode = alive;
    o.alphaTest = 0.5;
    o.transparent = false;

    return {
      material: m,
      outlineMaterial: o,
      dissolve: uDissolve as unknown as { value: number },
      hitFlash: uHitFlash as unknown as { value: number },
    };
  },

  /**
   * Surface d'eau (un corps d'eau = un appel, bounds propres) : Basic (pilotée
   * ciel/soleil, pas de PBR ni d'ombres tachetées) — tout est analytique dans
   * colorNode. La texture de données (bake CPU de Water.ts) fournit R = profondeur,
   * G = distance à la rive, B = masque d'appartenance au corps ; l'UV vient de
   * positionWorld, pas du mesh. Animation 100 % `time`.
   */
  water(data: DataTexture, bounds: WaterBounds): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent: true });
    // depthWrite true : l'herbe/props derrière la surface sont occlus par le
    // z-buffer — règle le tri sans jouer avec renderOrder
    m.depthWrite = true;

    const wxz = positionWorld.xz;
    const sizeX = bounds.maxX - bounds.minX;
    const sizeZ = bounds.maxZ - bounds.minZ;
    const uvW = wxz.sub(vec2(bounds.minX, bounds.minZ)).div(vec2(sizeX, sizeZ));
    const dTex = texture(data, uvW);
    const depthM = dTex.r.mul(WATER.depthNorm); // profondeur en mètres

    // Normale animée : 2 octaves de Perlin (time en 3e dimension → la houle
    // évolue sur place en plus de dériver)
    const p1 = vec3(wxz.mul(WATER.waveFreq1).add(time.mul(WATER.waveSpeed1)), time.mul(0.06));
    const p2 = vec3(wxz.mul(WATER.waveFreq2).sub(time.mul(WATER.waveSpeed2)), time.mul(0.09).add(37.7));
    const s1 = mx_noise_vec3(p1);
    const s2 = mx_noise_vec3(p2);
    const N = vec3(
      s1.x.mul(WATER.waveAmp1).add(s2.x.mul(WATER.waveAmp2)),
      1,
      s1.y.mul(WATER.waveAmp1).add(s2.y.mul(WATER.waveAmp2)),
    ).normalize();

    // Couleur par profondeur : turquoise → bleu (le « profond » du centre du lac
    // vient du canal G — le lit réel est plafonné à 1,35 m, l'illusion est ici)
    const tDeep = smoothstep(0.10, 0.85, dTex.r.mul(0.75).add(dTex.g.mul(0.45)));
    const base = mix(color(WATER.shallowColor), color(WATER.deepColor), tDeep);

    // Fresnel ciel sur la normale PERTURBÉE (l'aide fresnel() maison lit la
    // normale géométrique en espace vue — inutilisable ici)
    const V = cameraPosition.sub(positionWorld).normalize();
    const F = clamp(dot(N, V), 0, 1).oneMinus().pow(WATER.fresnelPower);
    const withSky = mix(base, color(WATER.skyTint), F.mul(WATER.fresnelStrength));

    // Écume de rive : bande cassée au bruit + pulsation qui lèche la berge
    const foamZone = smoothstep(float(0.05), float(WATER.foamWidth), depthM).oneMinus();
    const fn = mx_noise_float(wxz.mul(WATER.foamNoiseFreq).add(vec2(time.mul(0.12), time.mul(-0.07))));
    const pulse = sin(depthM.mul(14).sub(time.mul(2.2))).mul(0.5).add(0.5);
    const foam = smoothstep(0.55, 0.78, foamZone.mul(0.72).add(fn.mul(0.2)).add(pulse.mul(foamZone).mul(0.18)));
    const waterline = smoothstep(0.0, 0.12, depthM).oneMinus(); // liseré clair à depth≈0
    const foamT = clamp(foam.add(waterline.mul(0.8)), 0, 1);
    const withFoam = mix(withSky, color(WATER.foamColor), foamT);

    // Glints solaires : Blinn analytique × masque de bruit scintillant.
    // Autorés > 1,5 en linéaire (contrat bloom) — clippent en blanc sans bloom.
    const sd = SUN.direction;
    const len = Math.hypot(sd.x, sd.y, sd.z);
    const sunDir = vec3(sd.x / len, sd.y / len, sd.z / len);
    const Hv = V.add(sunDir).normalize();
    const glintNoise = mx_noise_float(wxz.mul(WATER.glintNoiseFreq).add(vec2(time.mul(0.31), time.mul(0.17))));
    const mask = smoothstep(0.15, 0.65, glintNoise);
    const spec = clamp(dot(N, Hv), 0, 1)
      .pow(WATER.glintPower)
      .mul(mask)
      .mul(WATER.glintStrength);
    m.colorNode = withFoam.add(color(SUN.color).mul(spec));

    // Opacité : fondu du bord (R=0 sur terre → jamais d'eau sur le sec),
    // renforcée par la profondeur et l'écume, ET masque d'appartenance (canal B :
    // tue la plaque d'eau qui déborderait l'arête de la falaise — la profondeur R
    // y est grande mais le SDF du corps est positif)
    const edgeFade = smoothstep(0.015, 0.10, dTex.r);
    const belong = smoothstep(0.75, 0.95, dTex.b).oneMinus();
    m.opacityNode = mix(float(WATER.alphaShallow), float(WATER.alphaDeep), tDeep)
      .max(foamT.mul(0.95))
      .mul(edgeFade)
      .mul(belong);
    return m;
  },

  /**
   * Rideau de cascade : bandes d'écume étirées verticalement qui défilent vers
   * le bas (2 octaves de bruit), cœurs HDR > seuil de bloom, fondus lèvre/pied/
   * latéraux. Deux couches (recto rapide / verso lent) pour l'épaisseur.
   */
  cascadeCurtain(speed: number, opacityMul: number): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    m.side = 2; // DoubleSide : lisible aussi depuis la terrasse

    // Stries verticales : variation rapide en travers (x), lente le long (y),
    // défilement vers le bas — uv.y = 0 à la lèvre, 1 au pied
    const su = uv().x;
    const sv = uv().y;
    const n1 = mx_noise_float(vec2(su.mul(6.0), sv.mul(CASCADE.noiseFreq1 * 9).sub(time.mul(speed))));
    const n2 = mx_noise_float(vec2(su.mul(11.0).add(37.7), sv.mul(CASCADE.noiseFreq2 * 9).sub(time.mul(speed * 1.35))));
    // Bornes serrées : le rideau doit lire en STRIES contrastées, pas en aplat
    const foamMask = smoothstep(-0.05, 0.42, n1.add(n2.mul(0.5)));

    // Corps aqua translucide (l'eau qui tombe) → stries blanches (l'écume).
    // Deux blancs superposés ne liraient PAS sur un fond ciel/roche clair.
    const bodyCol = mix(color(WATER.shallowColor), color(WATER.skyTint), 0.4);
    const base = mix(bodyCol, color(WATER.foamColor), foamMask);
    // Cœurs HDR : les stries les plus denses dépassent 1 en linéaire → bloom
    const core = smoothstep(0.55, 0.92, foamMask).mul(CASCADE.coreBoost - 1);
    m.colorNode = base.add(color(WATER.foamColor).mul(core));

    const lateral = smoothstep(0.0, 0.12, su).mul(smoothstep(0.88, 1.0, su).oneMinus());
    const lipFade = smoothstep(0.0, 0.06, sv);
    const footFade = smoothstep(0.92, 1.0, sv).oneMinus().mul(0.55).add(0.45); // se fond dans l'écume
    // Les creux entre stries laissent voir la roche derrière (0,25 mini) —
    // sans ça la nappe est une plaque blanche uniforme
    m.opacityNode = foamMask.mul(0.75).add(0.25)
      .mul(lateral)
      .mul(lipFade)
      .mul(footFade)
      .mul(CASCADE.alphaBase * opacityMul);
    return m;
  },

  /** Écume d'impact au pied de la chute : anneaux radiaux + bouillonnement. */
  plungeFoam(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    const p = uv().sub(0.5).mul(2);
    const r = p.length();
    // Anneaux en expansion (2 phases) + bruit de bouillonnement
    const ring = (phase: number) => {
      const t = fract(time.mul(0.5).add(phase));
      return smoothstep(0.03, 0.14, r.sub(t.mul(0.95)).abs()).oneMinus().mul(t.oneMinus());
    };
    const churn = mx_noise_float(vec2(p.x.mul(3.0).add(time.mul(0.4)), p.y.mul(3.0).sub(time.mul(0.3))))
      .mul(0.5).add(0.5);
    const centre = smoothstep(0.0, 0.55, r).oneMinus().mul(churn.mul(0.6).add(0.4));
    m.colorNode = color(WATER.foamColor);
    m.opacityNode = ring(0).add(ring(0.5)).mul(0.5).add(centre)
      .mul(smoothstep(0.85, 1.0, r).oneMinus())
      .mul(CASCADE.plungeOpacity);
    return m;
  },

  /** Boule de fumée cartoon (cheminée de la loco) : blobs toon, PAS de sprites —
   *  SpriteNodeMaterial instancié ignore les matrices d'instance (piège M5). */
  smokePuff(): MeshToonNodeMaterial {
    return new MeshToonNodeMaterial({
      color: new Color('#edeae4'),
      gradientMap: sharedRamp,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
    });
  },

  /** Boiseries laquées cramoisies de la voiture (parois intérieures, coussins). */
  trainPanel(): MeshToonNodeMaterial {
    return new MeshToonNodeMaterial({ color: new Color('#6f2130'), gradientMap: sharedRamp });
  },

  /** Filets laiton (trims intérieurs, cadres) — léger éclat fresnel. */
  trainBrass(): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ color: new Color(PALETTE.gold), gradientMap: sharedRamp });
    setEmissiveNode(m, fresnel(2.5).mul(color('#f0dfae')).mul(0.35));
    return m;
  },

  /** Rail d'acier : gris-bleu sombre, dessus éclairci (bande de roulement polie). */
  railSteel(): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ gradientMap: sharedRamp });
    const topShine = smoothstep(0.7, 0.95, normalLocal.y);
    m.colorNode = mix(color('#3c4148'), color('#9aa4ad'), topShine);
    setEmissiveNode(m, fresnel(3.5).mul(color('#6b7684')).mul(0.15));
    return m;
  },

  /** Bois de la voie (traverses, tablier de pont, quais) : brun chaud mat. */
  railWood(): MeshToonNodeMaterial {
    return new MeshToonNodeMaterial({ color: new Color('#5d4630'), gradientMap: sharedRamp });
  },

  /** Bois clair des gares (planches de quai, enseigne). */
  stationWood(): MeshToonNodeMaterial {
    return new MeshToonNodeMaterial({ color: new Color('#8a6a45'), gradientMap: sharedRamp });
  },

  /**
   * Parois du tube de tunnel : maçonnerie sombre LISIBLE (le noir pur lisait
   * comme du vide — retour utilisateur « tunnel pas décoré ») — appareillage
   * suggéré par du bruit, SANS fog (le fog clair repeindrait l'obscurité en
   * brume laiteuse). FrontSide sur des DALLES (murs/plafond/plancher séparés) —
   * un caisson fermé en BackSide mettait ses faces transversales EN TRAVERS de
   * l'alésage tous les 4 m : mur noir invisible (trouvé par bisection headless).
   */
  tunnelWall(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ fog: false });
    const n1 = mx_noise_float(positionWorld.mul(0.55)).mul(0.5).add(0.5);
    const n2 = mx_noise_float(positionWorld.mul(2.3)).mul(0.5).add(0.5);
    m.colorNode = mix(color('#23262d'), color('#3a3f4a'), n1.mul(0.7).add(n2.mul(0.3)));
    return m;
  },

  /** Maçonnerie des portails : pierre claire à assises suggérées (bandes + bruit). */
  masonry(): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ gradientMap: sharedRamp });
    const course = fract(positionWorld.y.mul(0.85)).sub(0.5).abs().mul(2); // assises horizontales
    const n = mx_noise_float(positionWorld.mul(0.9)).mul(0.5).add(0.5);
    m.colorNode = mix(color('#767c88'), color('#9aa1ad'), n.mul(0.65).add(course.mul(0.35)));
    return m;
  },

  /** Plancher du tube (sous les traverses) : ballast sombre mat. */
  tunnelFloor(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ fog: false });
    m.colorNode = color('#191612');
    return m;
  },

  /**
   * Bloc de glace SHADÉ (arche du belvédère, M7.1) : un lantern plat lisait
   * comme des rectangles cyan UI — ici rampe toon + rim cryo au fresnel.
   */
  iceBlock(): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({
      color: new Color('#cde9f6'),
      gradientMap: sharedRamp,
      transparent: true,
      opacity: 0.94,
    });
    setEmissiveNode(m, fresnel(2.2).mul(color(PALETTE.elements.cryo)).mul(0.9));
    return m;
  },

  /** Lanterne émissive (tunnel, quais, loco) : ≥ 1,5 linéaire → prise par le bloom. */
  lantern(tint: string, intensity: number): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ fog: false });
    m.colorNode = color(tint).mul(intensity);
    return m;
  },

  /**
   * Fenêtre chaude de Snezhnograd (M9.2) : atlas Magnific 2×2, variante et
   * intensité PAR INSTANCE (hash). Les vitres dorées (rouge dominant sur le
   * bleu) sont poussées au-delà de 1,5 linéaire → prises par le bloom ; le
   * cadre bois et le mur bleu nuit restent sous le seuil de chaleur.
   */
  cityWindow(atlas: Texture): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ fog: false });
    const cx = step(0.5, hash(instanceIndex.add(7))).mul(0.5);
    const cy = step(0.5, hash(instanceIndex.add(19))).mul(0.5);
    const t = texture(atlas, uv().mul(0.5).add(vec2(cx, cy)));
    const warm = smoothstep(0.35, 0.75, t.r.sub(t.b.mul(0.6)));
    const vary = mix(float(0.85), float(1.2), hash(instanceIndex.add(41)));
    m.colorNode = t.rgb.mul(warm.mul(CITY.windows.boost).add(1)).mul(vary);
    return m;
  },

  /**
   * Lampadaire de Snezhnograd (M9.2) : le verre AMBRÉ de l'albédo Meshy devient
   * sa propre source, gaté sur la chaleur (r−b) — le fer bleu-gris et la neige
   * du chapeau restent éteints (un cœur box dans la tête serait invisible :
   * la cage de verre du GLB est opaque).
   */
  lampGlass(albedo: Texture | null): MeshToonNodeMaterial {
    const m = this.prop(albedo);
    if (albedo) {
      const t = texture(albedo);
      setEmissiveNode(m, t.rgb.mul(smoothstep(0.18, 0.5, t.r.sub(t.b))).mul(2.2));
    }
    return m;
  },

  /**
   * Halo de lumière chaude au sol sous un lampadaire (M9.2) : disque additif
   * à falloff radial doux. Discipline d'exposition M7.2 : UN disque par lampe,
   * couleur ≤ 0,65 — la chaleur vient du dégradé, jamais d'un blanc nucléaire.
   */
  lightPool(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      fog: false,
    });
    const d = uv().sub(vec2(0.5, 0.5)).length().mul(2);
    const fall = smoothstep(0.0, 0.95, d).oneMinus();
    m.colorNode = color(CITY.lampPool.color).mul(CITY.lampPool.intensity);
    m.opacityNode = fall.mul(fall).mul(0.6);
    return m;
  },

  /**
   * Sol de la région neige (M5) : blanc-bleu procédural (0 crédit) — macro-bruit
   * de teinte, pentes tirées vers le cryo, et GLINTS émissifs seuillés ≥ 1,5
   * (le scintillement au bloom, signature Genshin des champs de neige).
   */
  snow(): MeshToonNodeMaterial {
    const m = new MeshToonNodeMaterial({ gradientMap: sharedRamp });
    const macro = mx_noise_float(positionWorld.xz.mul(AMBIENCE.snowMacroFreq)).mul(0.5).add(0.5);
    const base = mix(color(AMBIENCE.snowColorB), color(AMBIENCE.snowColorA), macro);
    const slope = smoothstep(0.75, 0.98, normalLocal.y).oneMinus();
    let col = mix(base, color(AMBIENCE.snowSlopeTint), slope.mul(0.55));

    // ---- Masque GLACE (M6) : mer gelée (boîte arrondie ; le wobble CPU de la
    // côte est absorbé par une PORTE D'ALTITUDE — pas besoin du même bruit) +
    // fond du canyon (anneau + altitude). Aucune borne smoothstep décroissante.
    const px = positionWorld.x;
    const pz = positionWorld.z;
    const py = positionWorld.y;
    const bx = px.sub(SEA_ICE.cx).abs().sub(SEA_ICE.hx);
    const bz = pz.sub(SEA_ICE.cz).abs().sub(SEA_ICE.hz);
    const outside = vec2(bx.max(0), bz.max(0)).length();
    const boxSdf = outside.add(bx.max(bz).min(0)).sub(SEA_ICE.round);
    const seaMask = smoothstep(-2.5, -0.5, boxSdf).oneMinus();
    const lowSea = smoothstep(SEA_ICE.iceY + 0.06, SEA_ICE.iceY + 0.45, py).oneMinus();
    const dm = positionWorld.xz.sub(vec2(MESA.cx, MESA.cz)).length();
    const ring = smoothstep(CANYON.rIn + 1, CANYON.rIn + 6, dm)
      .mul(smoothstep(CANYON.rOut - 6, CANYON.rOut - 1, dm).oneMinus());
    const lowCanyon = smoothstep(CANYON.floorY + 0.3, CANYON.floorY + 0.9, py).oneMinus();
    // Crevasse (M7) : sol de glace de la gorge (segment + porte d'altitude)
    const cvbx = float(CREVASSE.bx - CREVASSE.ax);
    const cvbz = float(CREVASSE.bz - CREVASSE.az);
    const cvLen2 = (CREVASSE.bx - CREVASSE.ax) ** 2 + (CREVASSE.bz - CREVASSE.az) ** 2;
    const cvT = clamp(px.sub(CREVASSE.ax).mul(cvbx).add(pz.sub(CREVASSE.az).mul(cvbz)).div(cvLen2), 0, 1);
    const cvD = vec2(px.sub(cvT.mul(cvbx).add(CREVASSE.ax)), pz.sub(cvT.mul(cvbz).add(CREVASSE.az))).length();
    const cvMask = smoothstep(CREVASSE.halfW - 2, CREVASSE.halfW - 0.5, cvD).oneMinus()
      .mul(smoothstep(CREVASSE.floorY + 0.5, CREVASSE.floorY + 1.2, py).oneMinus());
    const iceMask = seaMask.mul(lowSea).max(ring.mul(lowCanyon)).max(cvMask);

    const depthN = mx_noise_float(positionWorld.xz.mul(0.06)).mul(0.5).add(0.5);
    let iceCol = mix(color(AMBIENCE.iceShallow), color(AMBIENCE.iceDeep), depthN);
    const ridge = mx_noise_float(positionWorld.xz.mul(AMBIENCE.iceCrackFreq)).abs();
    const crack = smoothstep(0.015, 0.05, ridge).oneMinus();
    iceCol = mix(iceCol, color('#dff3fb'), crack.mul(0.5));
    col = mix(col, iceCol, iceMask);

    // ---- Masque PAVÉS (RÉSEAU de rues + place de Snezhnograd), gaté au plateau ----
    let streetMask = float(0) as unknown as Node<'float'>;
    for (const st of CITY.streets) {
      const abx = float(st.bx - st.ax);
      const abz = float(st.bz - st.az);
      const len2 = (st.bx - st.ax) ** 2 + (st.bz - st.az) ** 2;
      const tSeg = clamp(px.sub(st.ax).mul(abx).add(pz.sub(st.az).mul(abz)).div(len2), 0, 1);
      const segD = vec2(px.sub(tSeg.mul(abx).add(st.ax)), pz.sub(tSeg.mul(abz).add(st.az))).length();
      streetMask = streetMask.max(smoothstep(st.halfW, st.halfW + st.feather, segD).oneMinus()) as unknown as Node<'float'>;
    }
    const plazaD = positionWorld.xz.sub(vec2(CITY.plaza.x, CITY.plaza.z)).length();
    const plazaMask = smoothstep(CITY.plaza.r - 2.5, CITY.plaza.r, plazaD).oneMinus();
    const plateauGate = smoothstep(MESA.topY - 1.6, MESA.topY - 0.6, py);
    const paveMask = streetMask.max(plazaMask).mul(plateauGate);
    const paveN = mx_noise_float(positionWorld.xz.mul(1.4)).mul(0.5).add(0.5);
    const paveCol = mix(color(AMBIENCE.paveColor), color(AMBIENCE.paveLight), smoothstep(0.45, 0.75, paveN));
    col = mix(col, paveCol, paveMask.mul(0.92));

    m.colorNode = col;

    // Glints : bruit haute fréquence seuillé, scintillement lent par 2e octave —
    // partout sauf sur les pavés ; la glace ajoute un miroitement fresnel doux
    const n1 = mx_noise_float(positionWorld.xz.mul(AMBIENCE.sparkleFreq)).mul(0.5).add(0.5);
    const n2 = mx_noise_float(positionWorld.xz.mul(AMBIENCE.sparkleFreq * 3.1).add(time.mul(0.15))).mul(0.5).add(0.5);
    const spark = step(AMBIENCE.sparkleThreshold, n1.mul(n2)).mul(paveMask.oneMinus());
    const iceSheen = fresnel(2.5).mul(iceMask).mul(0.35).mul(color(PALETTE.elements.cryo));
    setEmissiveNode(m, spark.mul(AMBIENCE.sparkleIntensity).mul(color('#eaf6ff')).add(iceSheen));
    return m;
  },

  /** Prop enneigé (rochers…) : albédo refroidi + couche blanche pondérée par normal.y. */
  snowProp(albedo: Texture | null, cool: [number, number, number] = [0.62, 0.72, 0.92]): MeshToonNodeMaterial {
    const m = albedo
      ? new MeshToonNodeMaterial({ map: albedo, gradientMap: sharedRamp })
      : new MeshToonNodeMaterial({ color: new Color('#dfe8f2'), gradientMap: sharedRamp });
    const cap = smoothstep(0.05, 0.65, normalLocal.y);
    if (albedo) {
      const t = texture(albedo, uv());
      m.colorNode = mix(t.rgb.mul(vec3(...cool)), color(AMBIENCE.snowColorA), cap.mul(0.9));
    }
    setEmissiveNode(m, fresnel(3.0).mul(color('#bcd6e8')).mul(0.1));
    return m;
  },

  /** Buisson de cristaux de givre (M6) : pointes émissives cryo → bloom. */
  crystalBush(albedo: Texture | null, height: number): MeshToonNodeMaterial {
    const m = this.snowProp(albedo);
    const tip = smoothstep(float(height * 0.35), float(height * 0.95), positionGeometry.y);
    const pulse = sin(time.mul(0.8).add(hash(instanceIndex).mul(6.2832))).mul(0.25).add(0.75);
    setEmissiveNode(m, tip.mul(pulse).mul(1.8).mul(color(PALETTE.elements.cryo)));
    return m;
  },

  /** Sapin enneigé : feuillage GIVRÉ (désaturé bleuté, réf 2) + balancement gated. */
  snowFoliage(albedo: Texture | null, height: number): MeshToonNodeMaterial {
    const m = this.snowProp(albedo, [0.34, 0.46, 0.62]);
    const gate = smoothstep(float(height * 0.35), float(height), positionGeometry.y);
    const phase = hash(instanceIndex).mul(6.2832);
    const sway = sin(time.mul(0.5).add(phase)).mul(0.5)
      .add(sin(time.mul(0.95).add(phase.mul(1.7))).mul(0.5))
      .mul(gate)
      .mul(0.04);
    m.positionNode = positionLocal.add(vec3(sway, 0, sway.mul(0.6)));
    return m;
  },

  /** Anneau de wading : deux ondes concentriques en expansion sous le joueur. */
  wadingRing(): MeshBasicNodeMaterial {
    const m = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    m.colorNode = color('#eef8fa');
    const r = uv().sub(0.5).length().mul(2);
    const ring = (phase: number) => {
      const p = fract(time.mul(WATER.rippleSpeed).add(phase));
      const band = smoothstep(0.02, 0.10, r.sub(p.mul(0.9)).abs()).oneMinus();
      return band.mul(p.oneMinus()); // s'estompe en s'élargissant
    };
    m.opacityNode = ring(0)
      .add(ring(0.5))
      .mul(WATER.rippleOpacity)
      .mul(smoothstep(0.85, 1.0, r).oneMinus()); // jamais coupé au bord du quad
    return m;
  },
};
