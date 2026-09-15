// Source unique de toutes les constantes de réglage du jeu.
// Toute valeur « magique » (gameplay, rendu, HUD) vit ici.

export const PALETTE = {
  gold: '#D3BC8E',
  textLight: '#ECE5D8',
  textWhite: '#FFFFF0',
  navy: '#3B4255',
  outline: '#2a2430',
  // AUTORITÉ COULEUR UNIQUE des verts : le terrain (gradient-map de luminance)
  // ET les brins d'herbe dérivent des MÊMES stops — jamais de vert ailleurs
  grassGreens: {
    deep: '#457028', // racines + texels sombres du sol
    mid: '#6f9e3f',  // référence (≈ milieu exact du lerp deep→tip)
    tip: '#a9db63',  // pointes + texels clairs du sol
  },
  elements: {
    pyro: '#EF7938',
    hydro: '#4CC2F1',
    anemo: '#74C2A8',
    electro: '#B08EC1',
    dendro: '#A5C83B',
    cryo: '#9FD6E3',
    geo: '#FAB632',
  },
} as const;

export const SKY = {
  zenith: '#3f74c9',
  mid: '#7fb2e5',
  horizon: '#dcecf5',
  fogNear: 70,
  fogFar: 320,
} as const;

export const SUN = {
  color: '#fff0d4',
  intensity: 2.75,
  // Direction matinale fixe (normalisée à l'usage)
  direction: { x: -0.55, y: 0.72, z: -0.42 },
  shadowMapSize: 2048,
  shadowHalfExtent: 45,
  shadowNear: 1,
  shadowFar: 220,
} as const;

export const HEMI = {
  sky: '#b8d4ee',
  ground: '#95866a', // rebond de sol légèrement chaud (bandes d'ombre ambrées)
  intensity: 0.8,
} as const;

export const POST = {
  enabled: true,          // débrayable au runtime : ?nopost
  bloomStrength: 0.3,     // aération discrète, pas un glow néon
  bloomRadius: 0.35,
  bloomThreshold: 0.7,    // luminance LINÉAIRE : seuls glints/sparkles/écume (≥1.5) bloomen
  bloomSmoothWidth: 0.3,  // rampe douce au-dessus du seuil (défaut 0.01 = coupure dure)
  vignetteStrength: 0.12,
  vignetteStart: 0.55,
} as const;

export const SEEDS = {
  count: 400,
  box: { x: 70, y: 20, z: 70 }, // boîte d'enroulement torique qui suit le joueur
  boxLift: 6,          // centre au-dessus du joueur (plus de graines à hauteur d'yeux)
  minSize: 0.04, maxSize: 0.1,
  windX: 0.5, windZ: 0.2, fallSpeed: 0.12,
  bobAmp: 0.5, bobFreqMin: 0.15, bobFreqMax: 0.4,
  nearFade: 1.5, fadeStart: 22, fadeEnd: 30,
  baseOpacity: 0.85,
} as const;

export const SPARKLES = {
  size: 0.22,
  color: '#ffe9b8',    // blanc-or Genshin
  intensity: 3.5,      // HDR : bien au-dessus du seuil de bloom
  periodMin: 0.5, periodMax: 1.5,
  hoverBase: 0.18, hoverAmp: 0.06,
  fadeStart: 45, fadeEnd: 65,
} as const;

export const RIM_PROPS = {
  seed: 7331,
  boulderCount: 26, ringMin: 100, ringMax: 125, // au-delà du début de lèvre (91 m)
  // Enfouissement en FRACTION de la hauteur de l'instance : une profondeur
  // absolue laissait les gros blocs posés en œufs sur la ligne de crête
  boulderScaleMin: 4, boulderScaleMax: 8, sinkFrac: 0.42,
  boulderCollisionR: 0.8, // mêmes ratios que SPECIES (la crête est atteignable à pied)
  treeCount: 40, treeRingMin: 95, treeRingMax: 118,
  treeScaleMin: 1.8, treeScaleMax: 3.2, maxSlopeDeg: 42,
  treeSinkFrac: 0.05,
  treeCollisionR: 0.5,
  cascadeClear: 22,   // rayon dégagé autour de la lèvre de la chute
} as const;

export const PROPS = {
  seed: 7777,
  chunks: 3,          // grille 3×3 (props épars : 6×6 gaspillerait les draws)
  spawnClear: 10,     // rayon dégagé autour du spawn (quelques arbres proches = cadrage Genshin)
  flowerFadeStart: 55,
  flowerFadeEnd: 80,
  flowerQuad: { w: 0.55, h: 0.5 },
} as const;

export interface SpeciesParams {
  count: number;
  minSpacing: number;   // espacement min même espèce (m)
  footprint: number;    // rayon d'encombrement « doux » inter-espèces (canopée)
  hardRadius: number;   // rayon « dur » (tronc/corps) — seul testé par les espèces basses
  slopeMaxDeg: number;
  grassMin: number;     // 0 = ignorer le splat
  scale: readonly [number, number];
  sinkFactor: number;   // enfoncement y = −sink × s
  alignToNormal: number; // 0 = vertical → 1 = normale terrain (slerp)
  castShadow: boolean;
  /** false pour le feuillage : l'auto-ombrage reçu = acné sur les canopées (convention Genshin). */
  receiveShadow: boolean;
  /** Écrasement vertical par instance [min,max] (rochers : silhouettes assises). */
  ySquash?: readonly [number, number];
  lowGround: boolean;   // true : ne teste que le rayon dur des grands (fleurs sous canopée OK)
  waterClear: number;   // SDF eau minimal autorisé (négatif = peut tremper)
  pathClear: number;    // distance minimale au chemin (m)
  collisionR: number;   // 0 = traversable ; sinon rayon d'obstacle = collisionR × s
  targetHeight: number; // hauteur monde de la géométrie normalisée (m)
  sway: boolean;        // balancement TSL du feuillage
  clusters?: { count: number; radius: number; seed: number }; // seed partagée = amas mixtes
  nearWaterSdf?: readonly [number, number]; // bande de SDF requise (mufliers de rive)
}

export const SPECIES: Record<string, SpeciesParams> = {
  treeA: { count: 45, minSpacing: 9, footprint: 3.5, hardRadius: 0.5, slopeMaxDeg: 24, grassMin: 0.45, scale: [0.85, 1.25], sinkFactor: 0.02, alignToNormal: 0.15, castShadow: true, receiveShadow: false, lowGround: false, waterClear: 2.5, pathClear: 2.5, collisionR: 0.5, targetHeight: 8.5, sway: true },
  treeB: { count: 35, minSpacing: 7, footprint: 2.5, hardRadius: 0.35, slopeMaxDeg: 26, grassMin: 0.45, scale: [0.8, 1.3], sinkFactor: 0.02, alignToNormal: 0.2, castShadow: true, receiveShadow: false, lowGround: false, waterClear: 2.5, pathClear: 2.0, collisionR: 0.35, targetHeight: 5.5, sway: true },
  boulderA: { count: 18, minSpacing: 2.2, footprint: 1.1, hardRadius: 1.1, slopeMaxDeg: 32, grassMin: 0, scale: [0.9, 1.6], sinkFactor: 0.4, alignToNormal: 0.9, castShadow: true, receiveShadow: true, ySquash: [0.75, 0.95], lowGround: false, waterClear: -0.5, pathClear: 1.5, collisionR: 0.8, targetHeight: 1.9, sway: false, clusters: { count: 7, radius: 5, seed: 23 } },
  boulderB: { count: 26, minSpacing: 1.0, footprint: 0.7, hardRadius: 0.7, slopeMaxDeg: 34, grassMin: 0, scale: [0.8, 1.5], sinkFactor: 0.35, alignToNormal: 0.9, castShadow: true, receiveShadow: true, ySquash: [0.75, 0.95], lowGround: false, waterClear: -0.5, pathClear: 1.2, collisionR: 0.6, targetHeight: 1.1, sway: false, clusters: { count: 7, radius: 5, seed: 23 } },
  bush: { count: 90, minSpacing: 2.5, footprint: 1.1, hardRadius: 0.8, slopeMaxDeg: 27, grassMin: 0.5, scale: [0.7, 1.4], sinkFactor: 0.08, alignToNormal: 0.35, castShadow: true, receiveShadow: false, lowGround: false, waterClear: 1.5, pathClear: 1.2, collisionR: 0, targetHeight: 1.1, sway: true, clusters: { count: 22, radius: 6, seed: 11 } },
  snapdragon: { count: 40, minSpacing: 1.2, footprint: 0.5, hardRadius: 0.3, slopeMaxDeg: 18, grassMin: 0, scale: [0.8, 1.2], sinkFactor: 0.03, alignToNormal: 0.2, castShadow: false, receiveShadow: true, lowGround: true, waterClear: 1.0, pathClear: 1.0, collisionR: 0, targetHeight: 0.7, sway: true, clusters: { count: 10, radius: 3, seed: 37 }, nearWaterSdf: [1, 6] },
  flowersY: { count: 260, minSpacing: 0.6, footprint: 0.25, hardRadius: 0.15, slopeMaxDeg: 25, grassMin: 0.6, scale: [0.8, 1.3], sinkFactor: 0.02, alignToNormal: 0.3, castShadow: false, receiveShadow: true, lowGround: true, waterClear: 1.2, pathClear: 0.8, collisionR: 0, targetHeight: 0.5, sway: true, clusters: { count: 26, radius: 4, seed: 41 } },
  flowersB: { count: 220, minSpacing: 0.6, footprint: 0.25, hardRadius: 0.15, slopeMaxDeg: 25, grassMin: 0.6, scale: [0.8, 1.3], sinkFactor: 0.02, alignToNormal: 0.3, castShadow: false, receiveShadow: true, lowGround: true, waterClear: 1.2, pathClear: 0.8, collisionR: 0, targetHeight: 0.5, sway: true, clusters: { count: 22, radius: 4, seed: 43 } },
};

export const FENCE = {
  targetHeight: 1.1,   // hauteur monde de la clôture normalisée (m)
  startT: 0.18,        // fraction du tracé principal où la clôture commence
  sideOffset: 2.3,     // décalage latéral au centre du chemin (m)
  segments: 12,
  overlap: 0.96,       // facteur de pas (léger chevauchement — cache les jointures Meshy)
  maxHeightStep: 0.5,  // trou rustique si marche de terrain trop haute entre poteaux
  obstacleR: 0.4,      // cercles de collision au poteau et au milieu du rail
  yawOffset: -Math.PI / 2, // les rails du GLB s'étendent en +X local → aligner sur la tangente
} as const;

export const TERRAIN = {
  size: 260,          // mètres de côté
  resolution: 384,    // grille de hauteur (cellule 0,68 m — arête de cascade nette ; repli 256 validé)
  splatResolution: 512, // texels de la splatmap (découplée : chemin ~3 m lisible)
  maxHeight: 16.5,
  seed: 31415,        // choisi parmi 12 seeds simulés (plancher 4,04, meilleure marge de vue)
  // Bruit de base — gain×lacunarité DOIT rester < 1 (0,5×2=1 = le bug des taupinières M2)
  baseFreq: 3.2,      // longueur d'onde ~81 m (houle ample, pas de bosses)
  baseOctaves: 3,
  baseGain: 0.3,
  baseLacunarity: 2,
  warpAmp: 0.32,      // warp de domaine (espace bruit, 1 unité = 81,25 m) — casse la grille du value noise
  warpOctaves: 2,
  spawnFlatRadius: 20,
  spawnKnollH: 1.2,   // dôme doux du spawn : l'œil domine le lac → vue sur la chute
  rimStart: 0.7,      // fraction du demi-côté où la lèvre de la vallée commence
  rimHeight: 26,
  carveRimMask: { start: 0.7, feather: 0.08 }, // AUCUN carve au-delà de edge 0,78 (leçon M2)
  textureRepeat: 52,  // répétitions des textures tileables sur toute la largeur
  detileCells: 0.8,   // densité du dé-tuilage stochastique (cellules par tuile)
  rockSlopeDeg: 34,   // pente (°) au-delà de laquelle la roche domine
} as const;

/**
 * Corridor de vue spawn → cascade : AUCUN prop haut (arbres) ne s'y sème.
 * Le gate de ligne de vue ne teste que le terrain — sans cette exclusion, une
 * canopée suffit à masquer la chute depuis le spawn (constaté en capture).
 */
export const VISTA = { halfWidth: 9, feather: 6, maxDist: 70 } as const;

/** Ligne de falaise en arc séparant les deux étages de la vallée. */
export const TERRACE = {
  cx: -24, cz: 24, radius: 99, // la radiale passe par le spawn ⇒ la face de la chute pointe (0,0)
  wDefault: 15,       // largeur de rampe (m) hors secteurs
  wCliff: 3.2,        // secteur falaise : montée quasi verticale (~73° à res 384)
  wAccess: 24,        // rampe d'accès Est (~15° moyen, marchable)
  cliffSector: { centerDeg: -45, halfDeg: 13, blendDeg: 6 },
  accessSector: { centerDeg: -14, halfDeg: 12, blendDeg: 6 },
  floorAbove: 10.4,   // plancher ABSOLU étage haut = levelLower + 10.4 → étanchéité STRUCTURELLE
  smaxK: 2.0,
} as const;

/** Dôme autoré du cairn de quête : belvédère au-dessus du bassin et de la chute. */
export const CAIRN_KNOLL = { x: 86, z: -54, r: 20, h: 4.8 } as const;

/**
 * Montagne « Dent du Sud » (M4) : cône terrassé GRIMPABLE posé sur l'étage haut,
 * à cheval sur l'arc (la face nord se grimpe depuis le fond de vallée). Profil
 * validé par simulation : mur du pied 9,9 m < budget 12, risers 6,7 m entre
 * vires de repos, pente max 75°, sommet 33,4 m dominant le rim vu du spawn.
 */
export const MOUNTAIN = {
  cx: 0, cz: -88,
  radius: 28,         // emprise totale
  envelopeBand: 6,    // fondu d'emprise — sans lui le socle à floorUpper ferait
                      // une falaise circulaire exactement sur le cercle d'emprise
  smaxK: 2.0,
  // Marches du profil { rayon ext, rayon int, rise cumulée } — smootherstep
  // entre les deux rayons ; les vires (flats) sont les intervalles entre marches
  steps: [
    { from: 28, to: 21, rise: 2.5 },    // tablier d'approche (~17°)
    { from: 21, to: 17.5, rise: 9.5 },  // riser A (~63° moyen, 75° au pic)
    { from: 15.5, to: 12, rise: 16.5 }, // riser B — vire A = 17.5→15.5
    { from: 10, to: 7, rise: 20 },      // riser C — vire B = 12→10 ; plateau d ≤ 7
  ],
  wobbleAmp: 2.2, wobbleFreq: 5,  // ondulation azimutale des rayons (risers non circulaires)
  summitNoiseAmp: 0.35, summitNoiseFreq: 9, // micro-relief du plateau (~4° max)
  questExcludeR: 34,  // findQuestPeak ignore ce disque (le sommet volerait le cairn)
  rimPropClear: 4,    // marge d'exclusion des props de crête autour de l'emprise
} as const;

/** Auge alluviale autorée (pré-carve) : le val du système bas existe quel que soit le seed. */
export const TROUGH = {
  width: 38,
  floorAbove: 0.9,    // plancher de l'auge = levelLower + 0.9
  microAmp: 0.85,     // micro-relief du fond (annulé sous les plages)
  microFreq: 4,
  smoothK: 3,
} as const;

/** Atténuation des carves par la pente PRÉ-carve (protège falaises et remparts). */
export const CARVE_GUARD = { slopeLo: 36, slopeHi: 46 } as const;

/** Lèvre du déversoir : exemption de garde (le canal DOIT percer la crête). */
export const LIP = { x: 48, z: -48, notchExemptR: 12 } as const;

export const PATH = {
  halfWidth: 1.5,     // demi-largeur pleine du chemin (~3 m)
  feather: 1.6,       // fondu vers l'herbe (m)
  // Le tracé est calculé au boot par A* sur le VRAI terrain (PathFinder) :
  // des nœuds figés dérivaient dès qu'une constante de relief bougeait.
  maxSlopeDeg: 15,    // pente maximale d'une arête (marge sous le gate de 18°)
  edgeSampleStep: 0.5, // sous-échantillonnage de validation (les bosses intermédiaires)
  slopeCost: 6,       // pénalité de dénivelé dans le coût (préfère les contours)
  waterCost: 40,      // pénalité par mètre de profondeur (force le passage aux gués)
  simplifyMaxSpan: 14, // longueur max d'un segment fusionné à la simplification
  // Étapes du tracé principal : spawn → gué de la rivière → cairn de quête
  fordVia: { x: 45, z: 24 },
  forkT: 0.3,         // départ de la fourche sur le tracé principal
  forkEnd: { x: 22, z: -32 }, // plage ouest du lac
} as const;

export const WATER = {
  levelLower: 3.0,    // Y1 : lac de réception + rivière + marais nord
  levelUpper: 12.2,   // Y2 = Y1 + 9.2 (chute eau-à-eau, mesurée en simulation)
  // ---- Étage BAS : lac (36,−36) → rivière → marais terminal nord ----
  lower: {
    lakeCenter: { x: 36, z: -36 },
    lakeRadius: 14,
    lakeJoinW: 8,
    riverKnots: [ // marais (nord) → lac
      { x: 22, z: 84, w: 9 },
      { x: 28, z: 72, w: 7 },
      { x: 38, z: 58, w: 6 },
      { x: 44, z: 38, w: 5 },
      { x: 46, z: 12, w: 4.5 },
      { x: 40, z: -14, w: 5.5 },
    ],
    wobbleOffset: 7.7,
    wobbleAmp: 1.8,
    bankSlopeDeg: 30,
    beaches: [
      { x: 22, z: -36, r: 9 },  // plage OUEST du lac (arrivée de la fourche)
      { x: 45, z: 24, r: 12 },  // GUÉ de la rivière (chemin principal, prof. ~1,1 m)
      { x: 30, z: 68, r: 11 },  // berge sud du marais
    ],
    bounds: { minX: 6, minZ: -56, maxX: 58, maxZ: 98 },
    texResX: 128, texResZ: 384,
  },
  // ---- Étage HAUT : bassin amont + amenée-« source » + déversoir ----
  upper: {
    basinCenter: { x: 58, z: -58 },
    basinRadius: 11,
    basinJoinW: 8,
    feederKnots: [{ x: 78, z: -80, w: 3.5 }, { x: 66, z: -66, w: 6 }],
    channelKnots: [{ x: 52, z: -52, w: 3.4 }, { x: 41, z: -41, w: 3.0 }], // perce la crête à (46,−46)
    wobbleOffset: 3.3,
    wobbleAmp: 1.5,
    bankSlopeDeg: 27,
    beaches: [{ x: 61, z: -47, r: 7 }], // rive NE du bassin (accès baignade)
    bounds: { minX: 40, minZ: -94, maxX: 92, maxZ: -40 },
    texResX: 192, texResZ: 192,
  },
  shoreWobbleFreq: 6,
  // Profil de creusement partagé
  shoreDepth: 0.28,
  bedSlope: 0.18,     // pente du lit (~10°)
  maxDepth: 1.35,     // plafond (< apex de saut 1.44 : jamais de piège)
  beachSlopeDeg: 13,
  smoothK: 1.15,
  beachPlateau: 0.6,  // beachW = ss(clamp((1−d/r)/0.6)) — POIDS PLATEAU (l'ancienne
                      // formule retombait à 0,5 sur la ligne de rive → gué à 20° au lieu de 13°)
  // Bande de sable de la splatmap
  sandInner: 0.6, sandWidth: 3.5,
  // Exclusion du semis d'herbe (marge au-delà de la rive, en m de SDF)
  grassMargin: 1.2,
  // levelAt : sdfUpper < ce seuil → étage haut (comparaison naïve sdfU<sdfL
  // classait la prairie lointaine au niveau haut — garde du juge)
  levelAtUpperSdf: 3,
  levelAtFloorMargin: 0.5, // marge sous le lit amont (levelUpper − maxDepth)
  // Garde de SURPLOMB du masque d'appartenance : un plan d'eau ne peut pas
  // reposer sur un sol très en dessous de lui (la profondeur réelle plafonne à
  // maxDepth). Sans elle, le corridor du déversoir fait flotter une dalle
  // opaque au-dessus du vide, en aval de la lèvre.
  hangoverLo: 1.6, hangoverHi: 2.4,
  depthNorm: 1.6, distNorm: 12, // normalisation des canaux R (profondeur) / G (dist. rive)
  // Surface
  shallowColor: '#45c8bb', deepColor: '#1a6b9e',
  skyTint: '#cfeaf6', foamColor: '#f2fbfd',
  waveFreq1: 0.22, waveFreq2: 0.85, waveAmp1: 0.35, waveAmp2: 0.2,
  waveSpeed1: 0.045, waveSpeed2: 0.06,
  fresnelPower: 3, fresnelStrength: 0.4,
  glintPower: 240, glintStrength: 2.6, glintNoiseFreq: 3.0,
  foamWidth: 0.55, foamNoiseFreq: 0.9,
  alphaShallow: 0.68, alphaDeep: 0.9,
  // Anneau de wading — rippleSdfMax = ligne d'eau la plus extérieure
  // (shoreDepth / tan(beachSlopeDeg) ≈ 1,3 m) : la PROFONDEUR déclenche,
  // le SDF n'est qu'une garde d'appartenance au plan d'eau
  rippleSize: 2.6, rippleSpeed: 0.55, rippleOpacity: 0.4, rippleSdfMax: 1.3,
} as const;

/** Rideau de cascade + écume d'impact + brume (positions issues de la simulation). */
export const CASCADE = {
  top: { x: 47.2, z: -47.2, y: 12.15 },  // lèvre (légèrement au-dessus du bed du déversoir)
  bottom: { x: 44.9, z: -44.9, y: 3.0 }, // surface du lac de réception
  width: 7,           // largeur du ruban (suit l'encoche)
  bulge: 1.9,         // bombé balistique vers l'aval (m, max à mi-chute)
  sink: 1.2,          // enfoncement du bas du rideau sous la surface du lac
  segmentsW: 8, segmentsH: 14,
  speedFront: 5.2, speedBack: 3.4,       // vitesse de défilement (m/s visuels)
  noiseFreq1: 0.55, noiseFreq2: 1.7,     // octaves d'écume (espace ruban)
  coreBoost: 1.35,    // cœurs HDR (> seuil de bloom 0.7) — glints de la chute
  alphaBase: 0.62,    // au-delà, le rideau lit comme un aplat blanc surexposé
  // Écume d'impact (ellipse au pied) + brume
  plungeRx: 5.5, plungeRz: 3.5, plungeOpacity: 0.55,
  mistCount: 40, mistBox: { x: 9, y: 6, z: 5 }, mistSize: [0.6, 1.6], mistOpacity: 0.22,
} as const;

export const GRASS = {
  // Densité auto-adaptative (touffes/m²) : le compte suit l'aire herbeuse de la carte
  clumpsPerM2WebGPU: 3.4, // 21 brins/m² → ~64 % de couverture à 25° (4.2 = « 70 % littéral », +24 % de coût)
  clumpsPerM2WebGL: 1.3,
  maxClumpsWebGPU: 100_000, // caps durs (VRAM + boot bornés quelle que soit la carte)
  maxClumpsWebGL: 40_000,
  chunks: 9,          // 81 cellules ~28,4 m — couple avec le culling de distance
  // Touffe (2 variantes bakées, partagées)
  bladesA: 7, bladesB: 5, variantBShare: 0.4,
  clumpRadius: 0.09,  // rayon du disque de racines de la couronne
  bladeWidth: 0.11, bladeTaper: 0.55, tipPinchT: 0.8, tipPinch: 0.85,
  bladeHeightMin: 0.34, bladeHeightMax: 0.6, bladeSegments: 4,
  leanCenterDeg: 6, leanRingMinDeg: 10, leanRingMaxDeg: 26,
  curveTipMinDeg: 14, curveTipMaxDeg: 32,
  scaleMin: 0.8, scaleMax: 1.25,
  // Rendu : passe OPAQUE + alphaTest (early-Z, zéro tri, MSAA natif)
  fadeStart: 30, fadeEnd: 45,
  fadeStartWebGL: 24, fadeEndWebGL: 36,
  fadeStagger: 0.45,  // dissolution PAR BRIN (aléa aBlade.y) avant l'alphaTest
  alphaTest: 0.05,
  swayAmp: 0.12, gustFreq: 0.05, gustSpeed: 0.15,
  lumLo: 0.15, lumHi: 0.7, // gradient-map de luminance du sol (deep→tip)
  // Semis
  minGrassWeight: 0.45,   // acceptation probabiliste : 0 sous 0.45, 1 dès 0.85
  grassWeightFull: 0.85,
  maxSlopeDeg: 30,
  sinkBase: 0.03,     // + clumpRadius × tan(pente) : le bord aval ne flotte jamais
  alignToNormal: 0.25,
  seedScatter: 4242, seedGeometry: 9182,
} as const;

export const MOVEMENT = {
  runSpeed: 5.2,
  sprintSpeed: 8.0,
  accelGround: 30,
  accelAir: 8,
  jumpVelocity: 8.5,
  gravity: -25,
  turnSmoothTime: 0.12,   // amortissement du cap du modèle vers la trajectoire
  turnRateDegPerS: 540,   // rotation max de la TRAJECTOIRE au sol (arcs naturels)
  reverseAngleDeg: 120,   // au-delà de cet écart : demi-tour = freinage-pivot
  reverseBrakeDecel: 40,  // décélération du freinage-pivot (m/s²)
  steerSnapSpeed: 1.0,    // sous cette vitesse, la direction s'aligne sans arc
  maxWalkableSlopeDeg: 50,
  staminaMax: 100,
  staminaDrainPerS: 18,
  staminaRegenPerS: 25,
  staminaRegenDelayS: 0.8,
  staminaMinToSprint: 15,
} as const;

/** Grimpe façon Genshin (M4) : toute pente ≥ minSlopeDeg est une paroi. */
export const CLIMB = {
  minSlopeDeg: 52,     // accroche (au-dessus du mur de marche à 50°)
  maxSlopeDeg: 88,     // au-delà : injouable (un heightfield ne surplombe jamais)
  detachSlopeDeg: 48,  // hystérésis : décroche sous ce seuil (vires, pied de paroi)
  climbSpeed: 1.4,     // m/s en ABSCISSE CURVILIGNE (le long de la surface)
  staminaDrainPerS: 8, // SEULEMENT en mouvement ; suspension immobile gratuite
  attachProbe: 0.45,   // sonde devant le joueur (m)
  attachDot: 0.5,      // poussée vers la paroi requise (cos 60°)
  attachMinRise: 0.3,  // la paroi doit MONTER d'au moins ça à la sonde
  anchorStep: 0.12, anchorSteps: 6, // marche d'ancre au sol (≤ 0,72 m)
  airProbeStep: 0.1, airProbeMax: 0.6, airSnapTol: 0.4, // accroche en l'air
  reattachCooldownS: 0.35,
  releaseHopSpeed: 2.2, releaseHopUp: 2.6, // hop arrière du lâcher (Espace)
  vaultProbeAhead: 0.55, vaultMaxRise: 2.0, vaultDurationS: 0.45, vaultArc: 0.35,
  headingSmoothTime: 0.08,
  leanFrac: 0.75, leanMaxDeg: 24, // inclinaison du buste vers la paroi
  modelOffset: 0.22,   // recul VISUEL du modèle hors de la paroi (m) — l'ancre
                       // physique reste sur la surface, seul le rendu recule
                       // (sinon jambes/bras traversent la roche, le corps ayant
                       // une épaisseur que l'ancre ponctuelle ignore)
  offsetSmoothTime: 0.12,
  timeScaleMax: 1.2,   // clip climb : 0 = pause murale, négatif = descente
  moveGuard: 0.5,      // |Δh relu − attendu| max par pas (garde d'anomalie de crête)
} as const;

export const CAMERA = {
  fov: 50,
  near: 0.2,
  far: 700,
  minDistance: 1.8,
  maxDistance: 7.5,
  defaultDistance: 4.6,
  pivotHeight: 1.45,
  sensitivity: 0.0023,
  minPitch: -0.45,
  maxPitch: 1.25,
  posDamping: 12,
  rotDamping: 18,
  terrainClearance: 0.35,
  zoomSpeed: 0.0016,
  // Clairance de perche (M4) : la caméra ne traverse plus les falaises en grimpe
  boomProbes: 12,      // sondes getHeight le long du boom (≤ 0,63 m d'écart)
  boomGuard: 0.3,      // garde au-dessus du terrain (m)
  collideInK: 45,      // rapprochement (s⁻¹) — converge en ~3 frames
  collideOutK: 5,      // éloignement lent (s⁻¹)
  collideDeadband: 0.15, // zone morte anti-pompage sur la sonde frontière
  collideMinDist: 0.9, // gros plan permis (sous minDistance, comme Genshin)
} as const;

export const MINIMAP = {
  // Palette sombre/réaliste de la carte (olive, brun, gris-bleu)
  grass: [132, 156, 98],
  dirt: [172, 140, 100],
  rock: [138, 140, 150],
  water: [88, 130, 158], // surface plate : dessinée SANS hillshade
  treeFill: 'rgba(63, 94, 52, 0.6)',      // blobs de canopée (carte peinte)
  treeHighlight: 'rgba(96, 128, 66, 0.4)',
  shadeBase: 0.6,     // hillshade : plage 0.6 → 1.35 (relief marqué)
  shadeRange: 0.75,
  slopeDarken: 0.3,   // assombrissement max par pente (facteur sur 1 − n.y)
} as const;

export const HUD = {
  // Coordonnées de la spec à 1920×1080 — converties en vh/vw dans hud.css
  minimapDiameter: 190,
  minimapWorldRadius: 55, // mètres visibles du centre au bord de la minimap
  staminaWheelSize: 76,
  skillCooldownS: 6,
  burstChargeS: 25,
  regionTitle: 'Vallée des Vents',
  regionSubtitle: 'Terres sauvages',
  questName: 'Les secrets de la vallée', // plus affiché depuis le design bannière (gardé pour le futur journal de quêtes)
  questObjective: 'Rejoindre le cairn au sommet',
  questAction: 'Abandonner le défi', // lien décoratif sous l'objectif (référence)
  partyLeaderName: 'Aeliana',
  interactRangeM: 2.2, // portée d'apparition du prompt « F » (et du futur ramassage)
} as const;

export const CHARACTER = {
  heightMeters: 1.62,
  capsuleRadius: 0.3,
  // Décalage du modèle par rapport à l'origine logique (pieds)
  modelYOffset: 0,
} as const;

/** Combat joueur (M4) : combo d'épée au clic, compétence E, ultime Q.
 *  Timings SIM autoritaires — les clips Meshy sont recadencés dessus. */
export const COMBAT = {
  playerHp: 1800,     // retour utilisateur M7 : 1000 PV → morts en boucle contre les wraiths
  atk: 100,
  critChance: 0.15,
  critMult: 2.0,
  variance: 0.08,     // dégâts ×(1 ± U(variance))
  combo: [
    { mult: 1.0, windup: 0.12, active: 0.1, recover: 0.28, reach: 2.6, arcDeg: 140, knock: 6, hitstopS: 0.06, stepSpeed: 3.5 },
    { mult: 1.1, windup: 0.1, active: 0.1, recover: 0.3, reach: 2.6, arcDeg: 140, knock: 6, hitstopS: 0.06, stepSpeed: 3.5 },
    { mult: 1.45, windup: 0.16, active: 0.12, recover: 0.45, reach: 3.0, arcDeg: 90, knock: 9, hitstopS: 0.1, stepSpeed: 4.5 },
  ],
  inputBufferS: 0.25, // clic mémorisé (attaque à l'atterrissage, chain fluide)
  chainWindowS: 0.35, // après le recover : fenêtre avant reset du combo
  recoverCancelS: 0.1, // le déplacement peut écourter le recover après ce délai
  aimConeDeg: 60, aimRange: 8, aimSmoothTime: 0.05, closeRange: 1.2,
  skill: { mult: 2.2, windup: 0.18, active: 0.12, recover: 0.4, reach: 3.6, arcDeg: 200, knock: 10, hitstopS: 0.12, stepSpeed: 0 },
  burst: { castS: 1.0, durationS: 4, radius: 4, tickS: 0.5, tickMult: 0.6, suction: 2.5, aheadM: 2.5 },
  energyMax: 100,
  energyPerHit: 5, energyPerSkillHit: 10, energyPerKill: 20, energyPassivePerS: 1.2,
  iFramesS: 0.5,      // évite le double-tap de deux golems synchrones
  knockbackPlayer: 5,
  deathS: 3.0,        // « à terre » : fondu noir puis téléport au spawn
  hpRegenPerS: 25, hpRegenDelayS: 6, // régén hors combat (pas de cuisine en v1)
  hitstopScale: 0.05, killHitstopS: 0.14,
} as const;

/** Golem sylvestre : rôle « hilichurl » — patrouille, aggro, télégraphe, melee. */
export const ENEMY = {
  hp: 480,            // ≈ 1 combo + 1 coup, ou combo + E confortable
  radius: 0.6,
  heightM: 2.2,
  walkSpeed: 2.6, walkRefSpeed: 2.6, // référence anti-patinage du clip walk
  turnSmoothTime: 0.15,
  aggroRange: 12, packRange: 10,     // l'aggro se propage au camp
  leashRange: 22, homeLeash: 20,     // désaggro : joueur loin OU trop loin du camp
  roarS: 0.9,
  attackRange: 2.2,
  windupS: 0.55, strikeS: 0.25, recoverS: 0.9,
  strikeReach: 2.6, strikeArcDeg: 90, strikeDmg: 140,
  cooldownMin: 2.2, cooldownMax: 3.2, // tirage aléatoire = camp désynchronisé
  hitstunS: 0.35, hitstunSkillS: 0.6,
  maxSlopeDeg: 40, waterSdfMin: 0.4,  // les golems n'entrent jamais dans l'eau
  separationR: 1.6, separationK: 3.0,
  dieS: 1.1, dissolveS: 1.4, respawnS: 25, rematerializeS: 0.4,
  hpBarShowDist: 30, hpBarRecentS: 6,
} as const;

/**
 * Archétypes d'ennemis Snezhnaya (M6) : chaque bloc SPREAD ENEMY (tous les
 * champs du FSM mêlée existent) puis surcharge. `element` = élément des
 * attaques, `aura` = aura élémentaire innée (réactions du joueur).
 */
export const VOLKODLAK = {
  ...ENEMY,
  hp: 320, radius: 0.5, heightM: 1.9,
  walkSpeed: 4.6, walkRefSpeed: 4.6, // chase sur le clip RUN (remappé)
  aggroRange: 16, packRange: 14, leashRange: 28, homeLeash: 26,
  roarS: 0.8,
  attackRange: 2.0, windupS: 0.4, strikeS: 0.2, recoverS: 0.7,
  strikeReach: 2.4, strikeArcDeg: 80, strikeDmg: 110,
  cooldownMin: 1.8, cooldownMax: 2.8,
  hitstunS: 0.3, hitstunSkillS: 0.5,
  maxSlopeDeg: 42,
  dieS: 0.9, dissolveS: 1.2, respawnS: 30,
  // Lunge télégraphé : dash en ligne droite sur la position VERROUILLÉE
  lunge: { minR: 4.5, maxR: 9, windupS: 0.5, dashSpeed: 12, dashMaxS: 0.9, hitRadius: 1.2, dmg: 150, recoverS: 0.8, cooldownMin: 5, cooldownMax: 8 },
} as const;

export const OPERATIVE = {
  ...ENEMY,
  hp: 550, radius: 0.45, heightM: 1.85,
  walkSpeed: 3.0, walkRefSpeed: 3.0,
  aggroRange: 14, leashRange: 24,
  roarS: 0.45, // « posture » d'aggro (clip parade remappé sur le slot roar)
  attackRange: 2.2, windupS: 0.35, strikeS: 0.2, recoverS: 0.8,
  strikeReach: 2.6, strikeArcDeg: 90, strikeDmg: 100,
  cooldownMin: 2.0, cooldownMax: 3.0,
  hitstunS: 0.3, hitstunSkillS: 0.55,
  dieS: 1.0, dissolveS: 1.3, respawnS: 35,
  // Parade : annule un coup léger, riposte ; skill/burst percent (dmg ×0,5)
  parry: { chance: 0.45, cooldownS: 7, stanceS: 1.0, riposteWindupS: 0.25, riposteDmg: 140, pierceMult: 0.5 },
} as const;

/** Golem de givre : rig golem reteinté, plus coriace, aura Cryo (0 crédit). */
export const FROST_GOLEM = {
  ...ENEMY,
  hp: 560, respawnS: 30,
} as const;

/** Cryo Wraith : spectre flottant SANS rig — kite + éclats de glace (projectiles). */
export const WRAITH = {
  hp: 260, radius: 0.5, heightM: 1.7, hoverY: 1.5, bobAmp: 0.25, bobFreq: 0.5,
  // Retour utilisateur M7 : « j'arrive pas à les tuer, ils fuient » — recul
  // seulement au corps-à-corps immédiat, dérive lente (rattrapable en marchant),
  // orbite courte : le spectre reste À PORTÉE d'épée entre deux salves
  driftSpeed: 1.5, retreatUnder: 2.2, preferredR: 5.5,
  aggroRange: 18, leashRange: 30,
  castS: 0.8, // télégraphe : le spectre gonfle + s'illumine
  projSpeed: 8, projDmg: 120, projRadius: 0.35, projTtl: 4, projLead: 0.35, projY: 1.4,
  cooldownMin: 2.6, cooldownMax: 3.4,
  hitstunS: 0.25, dieS: 0.6, dissolveS: 1.4, respawnS: 30,
  hpBarShowDist: 30, hpBarRecentS: 6,
} as const;

/** Froid mordant (M6, type « Sheer Cold ») : jauge hors sources de chaleur. */
export const COLD = {
  max: 100,
  risePerS: 5.5,        // ~18 s pour se remplir en toundra calme
  blizzardMult: 2,      // bourrasque : ×2
  fallPerS: 25,         // ~4 s pour se vider près d'une source
  hpDrainPerS: 60,      // jauge pleine : 1000 PV ≈ 16 s — dangereux, pas instantané
  regenBlockAt: 0.5,    // au-delà : la régén hors combat est coupée
  warnAt: 0.7,          // pulse UI + vignette givre
  blizzard: { calmS: 40, gustS: 15, rampS: 3 }, // cycle seedé, toundra uniquement
  stationWarmR: 7,      // les quais (lampadaires) réchauffent
  brazierWarmR: 6,
  giantBrazierWarmR: 16,
} as const;

/** Braseros allumables (F) de la toundra — sources de chaleur + checkpoints. */
export const BRAZIERS = [
  { x: -36, z: 226 },   // bord de voie, sur la route de l'arène
  { x: -58, z: 274 },   // derrière l'arène, vers la côte
  { x: 12, z: 258 },    // plaine est, vers le pied du viaduc
  { x: -66, z: 252 },   // entrée d'arène (clé de la Fonte au boss)
  { x: -76, z: 270 },   // arène nord (2e brasero du duel)
  // ---- Maillage de chaleur étendu (M10, retour utilisateur) — APPEND ONLY :
  // ARENA.brazierIndices et le respawn indexent ce tableau ----
  { x: 16, z: 246 },    // approche sud de la crevasse scintillante
  { x: -88, z: 230 },   // côte ouest, entre les spectres de la banquise
  { x: 8, z: 300 },     // plaine nord, sous l'arc du viaduc
  { x: 56, z: 333 },    // HAUT DE LA MONTAGNE : bord ouest du belvédère (plat Y20),
                        // hors du rayon de la colonne 4 — on y plane en redescendant
                        // de la tornade du milieu (58,320)
] as const;

/** Feux animés (M10) : braseros, brasero géant Fatui, lame infusée Pyro. */
export const FIRE = {
  // Flammes de brasero : 2 cônes ouverts de bruit défilant + braises + cœur
  flame: {
    rBot: 0.36, rTop: 0.15, height: 1.25,
    innerScale: 0.58,
    riseSpeed: 1.35,     // défilement vertical du bruit (les langues MONTENT)
    spin: 0.5,
    alphaOuter: 0.62, alphaInner: 0.85,
    colBase: '#ff4a10', colTip: '#ffd978', colCore: '#fff3c4',
    coreBoost: 1.45,     // discipline M7.2 : l'additif se CUMULE — jamais de blanc nucléaire
  },
  embers: {
    count: 40, riseS: 1.9, height: 2.3, drift: 0.35,
    sizeMin: 0.022, sizeMax: 0.055, intensity: 1.55,
  },
  fadeS: 0.5,            // fondu d'allumage (F)
  bowlFrac: 0.68,        // hauteur de la vasque dans le GLB brasero (base du feu)
  giantScale: 2.6,       // brasero géant du camp Fatui
  // Lame embrasée (infusion Pyro) : plans croisés qui suivent l'os réel
  sword: {
    width: 0.3,          // largeur des plans de flamme (m)
    overshoot: 0.18,     // débord des langues au-delà de la pointe (m)
    riseSpeed: 2.8,      // les flammes filent vers la POINTE
    noiseFreq: 2.6,
    alpha: 0.72,
    coreBoost: 1.5,
    emberCount: 22, emberR: 0.11, emberRiseS: 0.55, emberSize: 0.034,
  },
} as const;

/** Cristaux de givre à ramasser (quête simple M6). */
export const CRYSTALS = {
  count: 8,
  spots: [
    { x: -30, z: 246 }, { x: -8, z: 212 }, { x: 14, z: 262 }, { x: -52, z: 222 },
    { x: -96, z: 228 }, { x: 6, z: 290 }, { x: -68, z: 292 }, { x: 40, z: 210 },
  ],
  pickupR: 2.2,
} as const;

/** Glissance de la glace (M6) : substitue les constantes du steering au sol. */
export const ICE = {
  accel: 7,             // vs accelGround 30 — on met du temps à lancer/arrêter
  decel: 3.5,           // glissade longue sans input (arrêt du run ≈ 3,9 m)
  turnRateDegPerS: 140, // vs 540 — grands arcs (le modèle suit la vélocité)
  reverseBrakeDecel: 9, // le demi-tour « patine »
} as const;

/** Éclats de glace des wraiths (et volées du boss P2). */
export const PROJECTILE = {
  poolSize: 24,
  spin: 4.0, size: 0.32, intensity: 2.0,
} as const;

/** BOSS « Garde-Chasse Automate » (M6) : arène près de l'épave, 3 phases. */
export const BOSS = {
  hp: 6000, radius: 1.1, heightM: 3.4,
  walkSpeed: 2.2, turnSmoothTime: 0.25,
  phase2At: 0.7, phase3At: 0.35,
  roarS: 1.4,
  smash: { windupS: 0.7, strikeS: 0.3, recoverS: 1.0, reach: 3.4, arcDeg: 110, dmg: 220, cooldownMin: 3, cooldownMax: 4 },
  shield: { hp: 1200, otherDmgMult: 0.15, brazierMeltR: 7, brazierMeltPerS: 60, breakStaggerS: 2.5 },
  volley: { count: 3, spreadDeg: 14, everyS: 4, speed: 9, dmg: 100, ttl: 4 },
  storm: { moveSpeed: 3.2, contactDmg: 90, tickS: 0.5, radius: 2.8, dmgTakenMult: 1.25,
           shockwave: { telegraphS: 0.8, r: 6, dmg: 180, everyS: 6 } },
  dieS: 1.6, dissolveS: 2.0,
  name: 'Garde-Chasse Automate',
} as const;

/** Arène du boss : trigger + anneau de murs de glace + coffre de victoire. */
export const ARENA = {
  triggerR: 14, wallCount: 12, wallR: 15, wallH: 3.4,
  brazierIndices: [3, 4], // braseros de BRAZIERS qui fondent le bouclier
} as const;

/** Camps de la toundra (M6) : postes autorés, validés par canaris au boot. */
export const SNOWCAMP = {
  seed: 7420,
  packs: [
    { kind: 'volkodlak', x: -12, z: 235, n: 3, r: 5 },
    { kind: 'volkodlak', x: 12, z: 278, n: 4, r: 6 }, // hors de la lèvre de la crevasse M7
    { kind: 'frostGolem', x: -15, z: 185, n: 2, r: 5 },
    { kind: 'wraith', x: -85, z: 205, n: 1, r: 0 },
    { kind: 'wraith', x: -90, z: 250, n: 1, r: 0 },
    { kind: 'operative', x: 48, z: 232, n: 2, r: 4 }, // camp Fatui au brasero géant
    { kind: 'wraith', x: 44, z: 244, n: 1, r: 0 },
  ],
} as const;

/** Camps de golems : semis déterministe façon PropField. */
export const CAMP = {
  seed: 5150,
  count: 3, golemsMin: 2, golemsMax: 3,
  slotRadius: 3.2,    // anneau des golems autour du centre du camp
  maxSlopeDeg: 18, waterClear: 2.5, pathClear: 4, spawnClear: 25, interCamp: 30,
  edgeMargin: 8, budget: 400,
  stampR: 4.5,        // terre battue (splat) sous le camp — AVANT herbe et compile
} as const;

/** Épée d'Aeliana : attache à l'os de la main droite du rig Meshy. */
export const SWORD = {
  lengthM: 0.95,
  boneRegex: 'hand.*r$|right.*hand|hand_r', // insensible à la casse
  // ⚠ Le GLB est modélisé POINTE EN BAS : loadProp (pieds à y=0 par bounding
  // box) met la POINTE à y=0 et la garde à y≈lengthM — sans flip, la main
  // tenait le bout de la lame (retour utilisateur M6). Flip 180° autour de Z
  // + remontée d'une longueur : la GARDE est dans la main, pointe vers le sol.
  gripY: 0.92,                       // point de GRIP dans la géométrie (ramené à l'origine de l'os) — 0,86 laissait le manche un peu haut
  offset: { x: 0, y: 0, z: 0 },      // nudges résiduels en espace os (partir de zéro)
  rotDeg: { x: 14, y: 0, z: 180 },   // lame le long des doigts, tirée un peu en arrière — itéré via look-player
  hiltY: 0.8, tipY: 0.03,            // échantillons de traînée (géométrie : garde ≈ 0,78, pointe ≈ 0)
} as const;

/**
 * Voie ferrée (M5) : tracé Est → gare Vallée → tunnel N-O → région neige.
 * Couloir x≈−33 validé contre le terrain : étage bas jusqu'à z≈122, aucune eau,
 * hors corridor VISTA (z ≥ 30 partout), portail visible du spawn (regard +Z).
 */
export const RAIL = {
  knots: [
    { x: 64, z: 30 },   // heurtoir Est (décor : le train en « arrive » au boot)
    { x: 52, z: 36 },
    { x: 43, z: 40 },   // PONT sur la rivière (⊥ au chenal, hors gué (45,24))
    { x: 30, z: 38 },
    { x: 10, z: 36 },   // passage devant le spawn (37,4 m > aplat r32)
    { x: -14, z: 41 },  // GARE Vallée (42,8 m du spawn)
    { x: -24, z: 58 },  // courbe large vers le rempart (r effectif ≈ 55 m)
    { x: -30, z: 74 },
    { x: -33, z: 93 },  // PORTAIL (edge 0,715 : le rim n'ajoute que ~0,2 m ici)
    { x: -35, z: 130 }, // sortie du heightfield (dans le tube)
    { x: -37, z: 152 }, // débouché côté neige (dans le tube)
    { x: -40, z: 205 }, // GARE Neige (Toundra)
    // ---- M6 : prolongement Snezhnaya — viaduc en arc Est vers la mesa ----
    { x: -42, z: 240 },
    { x: -35, z: 275 },
    { x: -15, z: 305 },
    { x: 15, z: 325 },
    { x: 45, z: 350 },  // le viaduc balaie le canyon par l'Est (réf 1)
    { x: 55, z: 385 },
    { x: 45, z: 415 },
    { x: 20, z: 428 },  // GARE Snezhnograd (sur la mesa, d=20 m du centre < rTop 48)
    { x: 14, z: 446 },  // heurtoir ville (≥17 m après la gare : la tête du convoi dépasse la voiture 1 de ~14,6 m)
  ],
  stationValley: { x: -14, z: 41 },
  stationSnow: { x: -40, z: 205 },
  stationCity: { x: 20, z: 428 },
  portal: { x: -33, z: 93 },     // entrée du tube (le rempart monte au-delà)
  tubeExit: { x: -37, z: 152 },  // débouché du tube côté neige
  sampleStep: 0.5,    // pas de la table s→pose (m)
  tunnelY: 6.0,       // altitude des rails du portail jusqu'à la rampe du viaduc
  cityY: 20.0,        // altitude des rails en gare Snezhnograd (mesa 19,6 + assise)
  rampFromSnow: 35,   // plat après la gare Toundra avant la rampe (m)
  cityFlat: 15,       // plat avant la gare Snezhnograd (m)
  // Rampe LINÉAIRE 6→20 sur ~205 m ≈ 3,9° : une smoothstep culminerait à 5,9°
  // et serait hachée par le clamp (déficit ~2,5 m à l'arrivée — prouvé au plan)
  tunnelBlend: 25,    // rampe de raccord du profil terrain → tunnelY (m avant portail)
  smoothWin: 15,      // fenêtre de lissage du profil d'élévation (m)
  maxGradeDeg: 4,     // clamp de pente du profil (bidirectionnel) — 3→4 pour le viaduc
  // Assise des rails dans le heightfield (passe POST-carves, hors carve() :
  // gate carveShave structurellement intact)
  bedHalfWidth: 2.2,  // fond plat de l'assise (demi-largeur, m)
  bedFeather: 6.0,    // fondu vers le terrain naturel (3,5 raidissait la prairie : p95 16°)
  bridgeWaterSdfLo: 4, bridgeWaterSdfHi: 8, // exemption de berges : poids nul si |lowerSdf|<4
  // ---- Géométrie de la voie (RailTrack) ----
  gauge: 1.2,          // écartement des rails (m)
  railW: 0.09, railH: 0.14,
  railStep: 1.0,       // pas des segments du sweep des rails (m)
  sleeperEvery: 0.85,  // traverses
  sleeper: { w: 2.0, h: 0.1, d: 0.3 },
  // Pont sur la rivière : tablier balayé là où |lowerSdf| < bridgeWaterSdfHi
  bridgeDeckW: 2.8, bridgeDeckThick: 0.4, bridgeMargin: 3,
  // Tube du tunnel (enterré sous le rempart) + lanternes intérieures
  tubeRadius: 4.0, tubeWallDrop: 2.5, tubeMargin: 2,
  lampEvery: 8, lampIntensity: 2.0, lampColor: '#ffca7a',
  // Portails (arche de pierre aux deux bouches)
  portalArchR: 4.2, portalDepth: 1.6, portalBlocks: 13,
  // Gares : quai bas (léger emmarchement, pas d'obstacle), lampadaires, enseigne
  platformLen: 15, platformW: 3.2, platformLift: 0.18,
  lanternIntensity: 2.2,
  // Exclusions de semis autour de la voie
  clearProps: 4, clearRim: 12, clearCamp: 8, clearStation: 15,
} as const;

/**
 * Train (M5) : navette continue gare Vallée ↔ gare Neige, trajet ~15 s
 * (trapèze accel 3.5 / vMax 16 sur ~168 m). Le joueur voyage DEBOUT dans la
 * voiture 1 (simulation en espace local, cf. PlayerFrame).
 */
export const TRAIN = {
  locoHeight: 4.1,     // targetHeight loadProp (m)
  carHeight: 3.5,
  locoYaw: 0,          // correction d'orientation du GLB (radians, après l'axe long → Z)
  carYaw: 0,
  coupling: 1.1,       // espace entre caisses (m)
  coachCount: 2,       // voitures derrière la loco (la n°1 est celle du joueur)
  wheelbaseHalf: 2.6,  // demi-corde des bogies (pose des caisses en courbe)
  accel: 2.0,          // m/s²
  vMax: 6.8,           // m/s — trajet ≈ 28-30 s (demande : 2× plus long que les 15 s v1)
  dwellS: 14,          // attente à quai (s) — rotations plus fréquentes (3 gares M6)
  introDelayS: 1.2,    // temps avant le départ de l'intro après le boot
  // Fumée de cheminée : BOULES toon instanciées (48 matrices CPU/frame) —
  // bouffées DISTINCTES (rate ≥ 0.28 : espacées de ~2 m à vMax, sinon corde continue)
  smoke: {
    count: 48, rate: 0.3, life: 2.7,
    rise: 2.6, drift: 0.5, size0: 0.5, size1: 1.7,
    chimney: { back: 0.32, up: 0.98 }, // fractions de la longueur/hauteur loco
  },
  // Bandeaux de fenêtres émissifs plaqués sur les flancs (indépendant de l'albédo)
  windowColor: '#ffca7a', windowIntensity: 1.8,
  windowBandH: 0.42, windowYFrac: 0.52, windowLenFrac: 0.62,
  headlampIntensity: 3.0,
  // Sécurité : poussée douce si le train roule vers un joueur à pied
  pushRadius: 2.4, pushImpulse: 9,
  boardRange: 3.6,     // portée du prompt « F · Monter à bord » depuis la porte
  snowTitle: 'Toundra du Morne Blizzard', snowSubtitle: 'Snezhnaya',
  cityTitle: 'Snezhnograd', citySubtitle: 'Cité de l’aurore',
  stationLabels: { valley: 'la Vallée', snow: 'la Toundra', city: 'Snezhnograd' },
} as const;

/**
 * Région Snezhnaya (M6, ex-« Val des Flocons » M5) : grand terrain analytique
 * rectangulaire hors carte, desservi par le train. Deux zones empilées sur Z :
 * toundra du blizzard (z 145-300, réf 2) puis Snezhnograd nocturne (z 300-485,
 * réf 1 : mesa + canyon + viaduc + palais). Le bord z=145 est INCHANGÉ — le
 * corridor de l'interstice tunnel (GroundRouter) n'est pas touché.
 */
export const SNOW = {
  center: { x: -40, z: 315 },
  halfX: 115, halfZ: 170, // emprise 230×340 m : x∈[−155,75], z∈[145,485]
  resX: 230, resZ: 340,   // cellule ~1,0 m (~78k sommets)
  baseY: 4.6,             // plancher de la toundra (plus de cuvette M5)
  noiseFreqPerM: 0.035,   // fréquence MÉTRIQUE (l'ex-noiseFreq était normalisée par half)
  noiseOctaves: 3, noiseAmp: 2.6, // plaines PLATES (réf 2) — 3,2 rendait le corridor côtier à 19°
  rimRise: 16, rimRiseNight: 26, // remontée périphérique, plus haute côté ville
  rimNightZLo: 290, rimNightZHi: 330, // lerp du rimRise sur Z
  rimBand: 18,
  railFlatHalf: 3, railFlatFeather: 12, // couloir de voie fondu large (épaulement ≤16° au pic)
  // Garde de remblai : si le rail est > bedFillHi au-dessus du sol, le couloir
  // ne TIRE PLUS le terrain (c'est le viaduc qui porte la voie, pas un remblai)
  bedFillLo: 1.5, bedFillHi: 2.5,
  // Semis décoratif existant (sapins/rochers) — resserré en lisière Est de la toundra
  // 0 sapin : la réf 2 n'a AUCUN conifère vert — arbres morts + cristaux seulement
  pineCount: 0, pineMinScale: 1.6, pineMaxScale: 2.9, pineClearRail: 6,
  boulderCount: 18, boulderMinScale: 1.0, boulderMaxScale: 2.6,
  seed: 6180,
  // Flocons (clone paramétré du pattern SeedField)
  flakeCount: 700,
  flakeBox: { x: 60, y: 24, z: 60 },
  flakeFall: 1.15, flakeWindX: 0.35, flakeWindZ: 0.1,
  flakeMinSize: 0.05, flakeMaxSize: 0.12, flakeOpacity: 0.85, flakeBoxLift: 6,
} as const;

/** Mer gelée (zone A ouest) : glace plane MARCHABLE — du sol, pas une Water. */
export const SEA_ICE = {
  // ⚠ l'arrondi du SDF boîte ÉTEND l'emprise de `round` : extension réelle = h + round
  cx: -114, cz: 222, hx: 9, hz: 56, round: 10, // emprise réelle x∈[−133,−95], z∈[156,288]
  wobbleAmp: 2, wobbleFreq: 0.05, // côte irrégulière — ⚠ le gradient du wobble COMPRESSE la berge (|∇sdf|>1)
  iceY: 3.4,     // plaque de glace (plate, marchable)
  shoreW: 12,    // berge fondue champ→glace (large : ≤16° même compressée)
  capDrop: 8,    // force max d'abaissement (jamais raser le rim — doctrine M3)
} as const;

/** Canyon de glace annulaire autour de la mesa (zone B). */
export const CANYON = {
  rIn: 62, rOut: 86, feather: 8, // anneau centré sur MESA.cx/cz
  floorY: 2.0, maxDrop: 12,      // force plafonnée, jamais la cible
} as const;

/** Mesa de Snezhnograd + tertre du palais + reliefs satellites (smax purs). */
export const MESA = {
  cx: 0, cz: 425, rTop: 48, rBase: 62, topY: 19.6, // falaise 17,6 m sur 14 m
  microAmp: 0.25, microFreq: 0.11,                 // micro-relief du plateau
  smaxK: 2.0,
  palaceMound: { x: -20, z: 450, r: 16, rise: 3.9 }, // terrasse Y 23,5 (pente ~14°, marchable)
  satellites: [ // décor lointain — TOUS hors de l'anneau du canyon (dm > 86 du centre mesa)
    { x: -100, z: 390, r: 30, peak: 30 },
    { x: -85, z: 460, r: 24, peak: 26 },
    { x: 62, z: 335, r: 22, peak: 22 },
  ],
  fatuiBump: { x: 68, z: 235, r: 22, peak: 30 },   // falaise Est à lueur orange (réf 2)
} as const;

/** Ville : RÉSEAU de rues, place, gare — aplats doux + masque pavés de snow(). */
export const CITY = {
  // [0] = artère gare → pied du tertre du palais (finir sur le flanc = 24°) ;
  // puis ruelles secondaires depuis la place (quartier sud, faubourg ouest)
  streets: [
    { ax: 12, az: 430, bx: -9, bz: 441, halfW: 4, feather: 3 },
    { ax: -4, az: 434, bx: -15, bz: 415, halfW: 2.6, feather: 2.5 },
    { ax: -8, az: 438, bx: -32, bz: 431, halfW: 2.6, feather: 2.5 },
  ],
  plaza: { x: -2, z: 436, r: 9 }, // à ≥12 m de la voie (l'influence du couloir s'arrête à 10)
  streetY: 19.6, // = MESA.topY (la rue tue le micro-relief)
  // Mobilier urbain (M6.2) : lampadaires le long des rues, étals, caisses…
  lampEvery: 9, lampIntensity: 2.0,
  stallCount: 3, crateCount: 16, barrelCount: 12, bannerCount: 7, benchCount: 4, driftCount: 12,
  // Fenêtres chaudes (M9.2) : atlas Magnific 2×2 plaqué sur la VRAIE façade
  // (plan de mur mesuré sur les sommets du GLB, plus le rayon max deviné)
  windows: {
    w: 1.0, h: 1.28,        // taille monde d'un quad fenêtre
    gap: 0.05,              // écart au mur (anti z-fighting)
    rowFracs: [0.28, 0.48], // hauteurs des étages (fraction de la hauteur maison)
    twoAbove: 1.9,          // demi-largeur de mur (m) à partir de laquelle 2 fenêtres/face
    litChance: 0.68,        // fraction de fenêtres allumées (les autres n'existent pas)
    boost: 1.3,             // sur-brillance des vitres chaudes (contrat bloom ≥ 1,5)
  },
  // Lampadaires (M9.2) : GLB Meshy dédié + halo de lumière chaude au sol
  lampGlowColor: '#ffc47d',
  lampPool: { r: 2.6, color: '#ffa95c', intensity: 0.75, plazaAngles: [0.6, 2.9, 4.0, 5.3] },
} as const;

/** Épave de train (réutilise train-loco.glb, 0 crédit) + voie de garage + arène du boss. */
export const WRECK = {
  x: -75, z: 245, yaw: 2.2, roll: 0.5, sinkFrac: 0.35,
  sidingA: { x: -60, z: 235 }, sidingB: { x: -82, z: 258 }, // rails morts demi-ensevelis
  arena: { x: -70, z: 262, r: 16, y: 4.4, feather: 6 },     // aplat de l'arène (bord Est ≥16 m de la voie : hors couloir)
} as const;

/** Crevasse scintillante (M7) : gorge de glace de la quête — carve segment. */
export const CREVASSE = {
  ax: 24, az: 252, bx: 46, bz: 296, // ~49 m, toundra Est (loin voie/viaduc/arène)
  halfW: 5, wallFeather: 1.6,       // parois ~60° même lissées à 0,9 m (grimpables, pas marchables)
  floorY: 0.9, maxCarve: 7,         // force plafonnée (doctrine M3)
  rampT: 0.28,                      // rampes d'accès LINÉAIRES aux 2 bouts (≤ ~20°)
} as const;

/** Belvédère du Nord (M7) : sommet aménagé de la mesa satellite (62,335). */
export const BELVEDERE = {
  x: 62, z: 335, r: 7, topY: 20, feather: 5,
} as const;

/** Colonnes de vent (M7) : tornades ascendantes — quête PUIS ascenseurs permanents. */
export const WINDCOLS = {
  maxRise: 13,   // plafond de vitesse verticale portée (m/s)
  columns: [
    { x: 46, z: 298, r: 4, topY: 18, strength: 34 }, // sortie de crevasse
    { x: 52, z: 309, r: 4, topY: 22, strength: 34 },
    { x: 58, z: 320, r: 4, topY: 25, strength: 36 },
    { x: 61, z: 331, r: 4, topY: 27, strength: 36 }, // débouche AU-DESSUS du belvédère (20)
  ],
  // ---- Visuel tornade de neige (M7.2, 100 % GPU — pattern SnowfallField) ----
  vortex: {
    funnelFlakes: 520,   // flocons en hélice dans l'entonnoir (par colonne)
    skirtFlakes: 260,    // neige arrachée au sol, spirale rentrante à la base
    riseS: 3.2,          // durée moyenne d'un cycle bas→haut (s)
    angMin: 3.4, angMax: 5.6,   // vitesse angulaire (rad/s) — tous même sens
    sizeMin: 0.09, sizeMax: 0.24,
    streak: 1.6,         // étirement horizontal des sprites (traînée de rotation)
    rBotFrac: 0.35, rTopFrac: 1.05, // profil d'entonnoir (fraction du r gameplay)
    wobble: 0.35,        // respiration radiale (m)
    opacity: 0.62,       // ⚠ des centaines de sprites se SUPERPOSENT : rester bas
    skirtOpacity: 0.3,
    dustR: 1.7,          // rayon du voile de poudrerie au sol (fraction du r)
  },
} as const;

/** Planeur « Aile de Givre » (M7) : débloqué en fin de quête. */
export const GLIDER = {
  sinkRate: 1.6,     // m/s de chute en plané NEUTRE (inchangé : gates/défi intacts)
  accel: 10, maxSpeed: 8,
  staminaPerS: 8,    // épuisée → décrochage
  toggleCooldownS: 0.25,
  // Vol libre (M9) : Espace MAINTENU = montée, Maj = piqué, TAP Espace = fermer
  riseRate: 4.5,        // m/s d'ascension (Espace maintenu)
  diveRate: 8,          // m/s de piqué (Maj maintenue)
  vertAccel: 14,        // m/s² d'approche vers la vitesse verticale cible
  staminaClimbPerS: 15, // drain accru pendant la montée (voler ≠ gratuit)
  tapCloseS: 0.22,      // appui plus court → fermeture des ailes
} as const;

/** Ailes « Aile de Givre » (M9) : GLB Meshy miroité + battement + plumes. */
export const WINGS = {
  span: 1.5,          // envergure monde d'UNE aile (m)
  rootGap: 0.1,       // écart racine↔colonne vertébrale (m)
  mount: { y: 1.32, z: -0.14 }, // point d'attache COLLÉ aux omoplates (M9.3 : plus près du dos)
  dihedralRad: 0.3,   // relèvement de base des ailes
  sweepRad: 0.34,     // flèche vers l'arrière (augmente au piqué)
  glow: 0.5,          // intensité glowProp (l'albédo devient sa carte émissive)
  glowTint: '#cfeaff', // teinte glacée quasi blanche — l'or du GLB reste chaud
  flap: {
    idleAmp: 0.07, idleFreq: 1.6,   // ondulation douce en plané neutre
    climbAmp: 0.42, climbFreq: 5.2, // battement franc en montée
    diveSweep: 0.5,                  // flèche ajoutée au piqué (ailes plaquées)
  },
  feathers: {
    pool: 26,
    rateIdle: 2.2, rateClimb: 9,   // plumes/s détachées (neutre / montée)
    fallSpeed: 0.9,                // m/s de chute d'une plume
    swayAmp: 0.42, swayFreq: 2.6,  // flottement latéral (va-et-vient feuille morte)
    lifeS: 2.8, sizeW: 0.07, sizeL: 0.26,
  },
} as const;

/** Quête M7 « La Bénédiction des Vents du Nord ». */
export const QUEST7 = {
  npc: { x: -7, z: 432, heading: 0.9 }, // Nadya, bord de la place
  seeliePath: [
    { x: -2, z: 430 }, { x: 12, z: 428 }, { x: 26, z: 420 }, // descend la rue puis la pente d'arrivée
    { x: 34, z: 400 }, { x: 30, z: 370 }, { x: 24, z: 340 },
    { x: 20, z: 310 }, { x: 22, z: 280 }, { x: 25, z: 255 }, // entrée SUD de la crevasse
    { x: 30, z: 264 }, // s'arrête DANS la crevasse
  ],
  seelieWaitD: 18, seelieResumeD: 10, seelieSpeed: 5.5,
  // GLB de la luciole (esprit flottant) : anims 100 % procédurales, pas de rig
  seelieModel: {
    height: 0.95,      // hauteur monde du GLB normalisé
    glow: 1.7,         // intensité glowProp (l'albédo devient sa carte émissive)
    yawOffset: 0,      // calage du « devant » du modèle (calibré en capture)
    turnLerp: 6,       // lissage du cap vers la direction de déplacement (1/s)
    swayDeg: 7,        // roulis/tangage doux en vol (lisibilité « esprit »)
    pulse: 0.05,       // respiration d'échelle (±)
  },
  crystals: [ // le long de la crevasse (t 0.3/0.5/0.7/0.85, côtés alternés)
    { x: 29, z: 266 }, { x: 34, z: 274 }, { x: 37, z: 283 }, { x: 42, z: 289 },
  ],
  resonanceTimerS: 45,
  altarCrevasse: { x: 44, z: 293 },
  altarBelvedere: { x: 62, z: 336 },
  guardianSpawns: [ { x: 58, z: 332 }, { x: 66, z: 338 } ],
  rewardCrystals: 3,
} as const;

/** Camp Fatui au pied de la falaise Est : brasero géant (source de chaleur + lueur). */
export const FATUI = {
  brazier: { x: 55, z: 238 },        // brasero géant (camp au pied du bump)
  cliffGlow: { x: 66, z: 233, y: 26 }, // halo billboard orange sur la falaise (décor)
  glowColor: '#ff9a3c', glowIntensity: 2.6,
} as const;

/** Matériau neige + ambiance froide (fog/lumières lerpés par la position joueur). */
export const AMBIENCE = {
  // Sol neige
  snowColorA: '#eef4fb', snowColorB: '#c9dcef',
  snowSlopeTint: '#9FD6E3',        // = PALETTE.elements.cryo
  snowMacroFreq: 0.045,
  sparkleFreq: 7.5, sparkleThreshold: 0.62, sparkleIntensity: 2.2, // ≥ 1,5 → bloom
  // Ciel/fog côté neige (t=1) — resserré : cache l'inter-régions
  snowHorizon: '#c8d9ec', snowMid: '#8fb4d9', snowZenith: '#47679f',
  snowFogNear: 45, snowFogFar: 230,
  // Lumières côté neige
  snowSun: '#e8f0ff', snowSunIntensity: 2.3,
  snowHemiSky: '#c4d8f2', snowHemiGround: '#8fa0b8',
  // Rampe du crossfade sur le Z MONDE du joueur (dans le noir du tube)
  zLo: 118, zHi: 148,
  // ---- M6 : bascule NUIT (Snezhnograd) — se joue SUR le viaduc, scénique ----
  nightZLo: 300, nightZHi: 340,
  night: {
    horizon: '#2c4368', mid: '#14233f', zenith: '#0b1226',
    fogNear: 60, fogFar: 300,
    sun: '#9db8e8', sunIntensity: 0.35, // « lune » : même azimut (snap texel préservé)
    hemiSky: '#2e4670', hemiGround: '#1c2438', hemiIntensity: 0.55,
    snowfall: 0.35, // flocons calmés côté ville
  },
  // Aurores boréales (additif TSL du dôme, ≥1,5 → bloom)
  aurora: { colorA: '#3ef0b0', colorB: '#38d8d8', colorC: '#7a5fd0', intensity: 2.2, scroll: 0.045 },
  // Étoiles (hash par cellule en projection gnomonique, scintillement)
  stars: { cell: 26, threshold: 0.9, intensity: 2.0 },
  // Blizzard (uniform de SnowfallField — les rafales cycliques arrivent avec ColdSystem)
  blizzard: { windMul: 3.2, stretch: 1.8, base: 0.35 },
  // Glace (mer gelée + fond du canyon) et pavés de la ville — masques de snow()
  iceDeep: '#2e6f96', iceShallow: '#7fd4e8', iceCrackFreq: 0.35,
  paveColor: '#3d4552', paveLight: '#565f6e',
} as const;

/** VFX de combat : pools instanciés additifs HDR (contrat bloom ≥ 1.5). */
export const VFX = {
  sparkCount: 192, planeCount: 64,
  trailSamples: 20, trailLifeS: 0.25, trailWidthM: 0.85,
  intensity: { slash: 2.5, spark: 3.5, flash: 4.0, ring: 1.8, telegraph: 1.6, mote: 3.0, trail: 2.5 },
  tornado: { rTop: 2.6, rBot: 0.9, height: 4.5, spin: 1.6, alpha: 0.26, coreBoost: 1.8 },
  shake: { na: 0.18, na3: 0.3, skill: 0.35, burstCast: 0.5, burstTick: 0.12, playerHit: 0.4, decayPerS: 1.6, maxOffsetM: 0.14, rollDeg: 1.5 },
} as const;

/**
 * Système audio (M8) : SFX procéduraux WebAudio + nappes mp3 + voix ElevenLabs.
 * Toute planification temporelle audio se fait sur ctx.currentTime (le hitstop
 * scale le dt de la boucle — Engine) ; seules les cadences en DISTANCE (pas,
 * grimpe) utilisent le dt de jeu, immunisées par construction.
 */
export const AUDIO = {
  // Volumes des bus (0..1) — source → bus → duckGain → master
  buses: { master: 0.9, sfx: 0.8, ambience: 0.55, voice: 1.0, ui: 0.6 },
  // Atténuation des sources positionnelles (gain = refDist / max(refDist, d))
  rolloff: { refDist: 4, maxDist: 45 },
  // Cadence des pas : mètres parcourus entre deux pas, par mode de déplacement
  // Foulées resserrées (retour utilisateur : cadence trop lente vs anim)
  steps: { strideM: { walk: 1.15, run: 1.7, sprint: 2.2 }, climbM: 1.2, gain: 0.5 },
  // Atterrissage : |vy| (m/s) → intensité 0..1 entre soft et hard
  landing: { softVy: 3, hardVy: 12 },
  // Cap de voix simultanées (global + par famille pour les spams)
  maxVoices: 24, maxFootstepVoices: 2, maxHitVoices: 4,
  ambience: {
    xfadeS: 0.4,          // crossfade equal-power de rebouclage (gap mp3)
    smoothTau: 0.5,       // lissage setTargetAtTime des gains de couche
    lowpassInteriorHz: 800, lowpassOpenHz: 18000, filterTau: 0.4,
    riverRadius: 30,      // distance d'audibilité de l'eau (cascade + rives)
  },
  // Barks d'Aeliana : throttle par type (s) + probabilité de déclenchement
  barks: {
    globalCooldownS: 2,
    throttleS: { jump: 8, attack: 5, hurt: 4, frozen: 10, cold: 25, victory: 5, land: 10 },
    chance: { jump: 0.25, attack: 0.3, hurt: 0.7, frozen: 1.0, cold: 0.8, victory: 1.0, land: 0.5 },
    variants: { jump: 2, attack: 2, hurt: 2, frozen: 1, cold: 1, victory: 1, land: 1 },
  },
  // Duck des autres bus pendant un dialogue parlé (facteurs multiplicatifs)
  duck: { dialogAmbience: 0.4, dialogSfx: 0.6, attackS: 0.15, releaseS: 0.6 },
} as const;

/**
 * Exploration M7.3 — éléments façon Genshin issus des recherches sur la région
 * (Dragonspine/Snezhnaya) : stèles de lore, agates de givre (Crimson Agate-like)
 * à offrir à l'autel, défi chronométré au planeur (Time Trial).
 */
export const EXPLORE7 = {
  tablets: [
    {
      x: 27, z: 256, yaw: 2.5, title: 'Stèle du Tsar Blanc', // face runique vers l'entrée de la crevasse
      lines: [
        'Le Tsar Blanc régna sur les neiges jusqu’au Cataclysme, voilà cinq cents ans. Quand il tomba, une autre prit le trône d’hiver — et son premier édit fut le silence.',
        'Que celle qu’on nomme la Tsaritsa veille sur nos compagnies. Que nul, jamais, ne s’arrête de marcher.',
      ],
    },
    {
      x: 40, z: 287, yaw: 2.3, title: 'Stèle de l’Hiver sans fin',
      lines: [
        'Ici, le blizzard peut souffler une lune entière. Voyageur : celui qui s’arrête gèle, celui qui marche vit.',
        'Les braseros sont frères des vivants. Ne les laisse jamais mourir, et eux te le rendront.',
      ],
    },
    {
      x: 67, z: 338, yaw: -1.7, title: 'Stèle des Vents du Nord', // à l'écart de l'autel ET du coffre (chaîne F), face vers le plateau
      lines: [
        'Aux âmes vaillantes, les Vents du Nord accordent des ailes ; aux orgueilleux, la chute.',
        'On dit que la Tsaritsa fit serment à ces vents, avant de fermer son cœur à l’amour — pour le porter tout entier, au nom de son peuple.',
      ],
    },
  ],
  // Agates de givre : 2 au sol dans la crevasse, 3 DANS les colonnes de vent
  // (cueillies pendant l'ascension), 1 au belvédère — offrande à l'autel final
  agates: [
    { x: 32, z: 268, clearY: 1.2 },
    { x: 43, z: 290, clearY: 1.4 },
    { x: 52, z: 309, clearY: 12 },
    { x: 58, z: 320, clearY: 16 },
    { x: 61, z: 331, clearY: 18 },
    { x: 64, z: 332, clearY: 1.2 },
  ],
  agatePickupR: 2.2,
  // Défi des vents (planeur requis) : anneaux en descente du belvédère vers la toundra
  trial: {
    totem: { x: 58, z: 338 },
    // Altitudes calculées en CHAÎNE à finesse 4 depuis le totem (le planeur
    // fait 5) — suivre le sol local remontait le 1er anneau AU-DESSUS du départ
    rings: [
      { x: 54, z: 342 },
      { x: 46, z: 346 },
      { x: 37, z: 349 },
      { x: 28, z: 351 },
      { x: 20, z: 352 },
    ],
    glideRatio: 4,    // m parcourus par m de chute imposé aux anneaux (marge sous 5)
    minClearY: 2.2,   // garde au sol si le terrain remonte (segment averti)
    ringR: 2.4,       // rayon de passage (3D)
    timeS: 35,
  },
} as const;
