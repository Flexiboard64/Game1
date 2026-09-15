import './styles/fonts.css';
import './styles/hud.css';
import { AnimationAction, CapsuleGeometry, Group, Mesh } from 'three/webgpu';
import { Engine } from './core/Engine';
import { InputManager } from './core/InputManager';
import { AssetManager } from './core/AssetManager';
import { HeightField } from './world/HeightField';
import { TrackSpec } from './world/TrackSpec';
import { SnowField } from './world/SnowField';
import { GroundRouter } from './world/GroundRouter';
import { SnowfallField } from './world/SnowfallField';
import { CityField, buildFatuiCamp } from './world/CityField';
import { WindColumns } from './world/WindColumns';
import { GliderWings } from './player/GliderWings';
import { Dialogue } from './quest/Dialogue';
import { Npc } from './quest/Npc';
import { Seelie } from './quest/Seelie';
import { ResonancePuzzle } from './quest/ResonancePuzzle';
import { QuestSystem } from './quest/QuestSystem';
import { Exploration } from './quest/Exploration';
import { buildWreck } from './world/TundraDecor';
import { RailTrack } from './train/RailTrack';
import { TrainSystem } from './train/TrainSystem';
import { WagonInterior } from './train/WagonInterior';
import { RideController } from './train/RideController';
import { Terrain } from './world/Terrain';
import { SkyDome } from './world/SkyDome';
import { Lighting } from './world/Lighting';
import { GrassField } from './world/GrassField';
import { Water, WadingRipple } from './world/Water';
import { Waterfall } from './world/Waterfall';
import { PropField } from './world/PropField';
import { ObstacleGrid } from './world/Obstacles';
import { RimDressing } from './world/RimDressing';
import { SeedField } from './world/SeedField';
import { SparkleField } from './world/SparkleField';
import { CharacterController } from './player/CharacterController';
import { ThirdPersonCamera } from './player/ThirdPersonCamera';
import { AnimationStateMachine } from './player/AnimationStateMachine';
import { assembleCharacter, type AssembledCharacter, type BossClipName } from './assets/CharacterLoader';
import { loadProp } from './assets/PropLoader';
import { ToonMaterials } from './materials/ToonMaterials';
import { LoadingScreen } from './ui/LoadingScreen';
import { Hud } from './ui/hud/Hud';
import { CampField } from './world/CampField';
import { CombatEvents } from './combat/CombatEvents';
import { CameraShake } from './combat/CameraShake';
import { SwordMount } from './combat/SwordMount';
import { EnemyManager } from './combat/EnemyManager';
import { CombatSystem } from './combat/CombatSystem';
import { ProjectileManager } from './combat/ProjectileManager';
import { ColdSystem } from './snezhnaya/ColdSystem';
import { InteractionManager } from './snezhnaya/Interactions';
import { ArenaController } from './snezhnaya/ArenaController';
import { BossEnemy } from './combat/BossEnemy';
import { ClipPlayer } from './combat/ClipPlayer';
import { VfxSystem } from './vfx/VfxSystem';
import { AudioEngine } from './audio/AudioEngine';
import { Sfx } from './audio/Sfx';
import { SamplePlayer } from './audio/SamplePlayer';
import { AmbienceMixer } from './audio/AmbienceMixer';
import { VoicePlayer } from './audio/VoicePlayer';
import { AudioSystem } from './audio/AudioSystem';
import { AMBIENCE, BOSS, BRAZIERS, CHARACTER, QUEST7, RAIL, TRAIN, WATER, WRECK } from './config';

// Bootstrap : préchargement (écran de chargement piloté) → construction du monde
// → boucle. Top-level await (build.target esnext).

const canvas = document.getElementById('game') as HTMLCanvasElement;
const loadingScreen = new LoadingScreen();

const assetManager = new AssetManager();
assetManager.onProgress = (r) => loadingScreen.setProgress(r * 0.85); // 15 % réservés à l'init GPU
const [bundle, engine] = await Promise.all([
  assetManager.loadAll(),
  Engine.create(canvas),
]);
loadingScreen.setProgress(0.9);

// ---- Monde ----
const ground = new HeightField();
// Voie ferrée : le profil est lissé depuis le terrain post-carves, puis l'assise
// est appliquée AVANT la construction du mesh (Terrain doit la refléter)
const track = new TrackSpec((x, z) => ground.getHeight(x, z));
ground.applyRailBed(track);
const terrain = new Terrain(ground, bundle.textures);
engine.scene.add(terrain.mesh);
engine.scene.add(terrain.questCairn);
const sky = new SkyDome(engine.scene);
const lighting = new Lighting(engine.scene);
// Deux plans d'eau (étage bas + bassin amont) + anneau de wading partagé
const waterLow = new Water(ground, {
  level: WATER.levelLower,
  bounds: WATER.lower.bounds,
  texResX: WATER.lower.texResX,
  texResZ: WATER.lower.texResZ,
  sdf: (x, z) => ground.getLowerSdf(x, z),
});
const waterHigh = new Water(ground, {
  level: WATER.levelUpper,
  bounds: WATER.upper.bounds,
  texResX: WATER.upper.texResX,
  texResZ: WATER.upper.texResZ,
  sdf: (x, z) => ground.getUpperSdf(x, z),
});
engine.scene.add(waterLow.mesh);
engine.scene.add(waterHigh.mesh);
const ripple = new WadingRipple(ground);
engine.scene.add(ripple.mesh);
const waterfall = new Waterfall();
engine.scene.add(waterfall.group);

// ---- Props : arbres, rochers, buissons, fleurs, clôture + collision ----
const obstacles = new ObstacleGrid();
const trackDist = (x: number, z: number) => track.trackDistance(x, z);
const props = new PropField(terrain, ground, bundle.props, bundle.flowerAtlas, obstacles, trackDist);
engine.scene.add(props.group);
const rim = new RimDressing(ground, props.loaded.get('boulderA') ?? null, props.loaded.get('treeA') ?? null, obstacles, trackDist);
engine.scene.add(rim.group);

// Camps de golems : AVANT l'herbe (terre battue tamponnée dans la splat) et
// avant le compile (splatData mutable gratuitement)
const camps = new CampField(terrain, ground, obstacles, trackDist);

// Ballast de la voie : tamponné dans la splat AVANT l'herbe et le compile
// (même contrat que les camps) — l'herbe s'écarte de la voie ET la ligne
// apparaît gratuitement sur la minimap via le canal terre
{
  const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  for (let s = 0; s <= track.length; s += 2) {
    track.pose(s, pose);
    if (Math.abs(pose.x) > 129 || Math.abs(pose.z) > 129) continue;
    // Plus large dans la tranchée du tunnel : pas d'herbe dans le bore
    const r = s > track.sPortal - 4 ? 4.0 : 2.6;
    terrain.stampSplat(pose.x, pose.z, r, 0.7, 0.35);
  }
}

// ---- Région Snezhnaya (M6, ex-M5) : terrain hors carte + routeur + flocons ----
// Kit ville + toundra normalisé (chaque GLB absent → élément absent, jamais de crash)
const snowDecorProps = {
  houseA: bundle.snowDecor.houseA ? loadProp(bundle.snowDecor.houseA, { targetHeight: 6.5 }) : null,
  houseB: bundle.snowDecor.houseB ? loadProp(bundle.snowDecor.houseB, { targetHeight: 8.5 }) : null,
  marketHall: bundle.snowDecor.marketHall ? loadProp(bundle.snowDecor.marketHall, { targetHeight: 6.0 }) : null,
  watchtower: bundle.snowDecor.watchtower ? loadProp(bundle.snowDecor.watchtower, { targetHeight: 11 }) : null,
  palace: bundle.snowDecor.palace ? loadProp(bundle.snowDecor.palace, { targetHeight: 17 }) : null,
  cityGate: bundle.snowDecor.cityGate ? loadProp(bundle.snowDecor.cityGate, { targetHeight: 9 }) : null,
  frozenStatue: bundle.snowDecor.frozenStatue ? loadProp(bundle.snowDecor.frozenStatue, { targetHeight: 3.2 }) : null,
  deadTree: bundle.snowDecor.deadTree ? loadProp(bundle.snowDecor.deadTree, { targetHeight: 5.5 }) : null,
  crystalBush: bundle.snowDecor.crystalBush ? loadProp(bundle.snowDecor.crystalBush, { targetHeight: 1.4 }) : null,
  brazier: bundle.snowDecor.brazier ? loadProp(bundle.snowDecor.brazier, { targetHeight: 2.0 }) : null,
};
const snow = new SnowField(
  track,
  props.loaded.get('treeA') ?? null,
  props.loaded.get('boulderA') ?? null,
  obstacles,
  snowDecorProps.deadTree,
  snowDecorProps.crystalBush,
);
engine.scene.add(snow.group);
const groundRouter = new GroundRouter(ground, snow, track);
const snowfall = new SnowfallField();
engine.scene.add(snowfall.mesh);

// ---- Voie ferrée : rails, pont, tube du tunnel, portails, gares ----
// Décor Meshy normalisé (M5.1) — chaque GLB absent → repli procédural
// (chargé AVANT la ville : lampadaires et bancs meublent aussi Snezhnograd)
const railDecor = {
  lampPost: bundle.railDecor.lampPost ? loadProp(bundle.railDecor.lampPost, { targetHeight: 3.0 }) : null,
  wallLantern: bundle.railDecor.wallLantern ? loadProp(bundle.railDecor.wallLantern, { targetHeight: 0.62 }) : null,
  stationShelter: bundle.railDecor.stationShelter ? loadProp(bundle.railDecor.stationShelter, { targetHeight: 3.4 }) : null,
};
const trainBenchProp = bundle.railDecor.trainBench ? loadProp(bundle.railDecor.trainBench, { targetHeight: 1.15 }) : null;

// ---- Colonnes de vent (M7) : tornades ascensionnelles de la quête ----
const windCols = new WindColumns(snow);
engine.scene.add(windCols.group);

// ---- Snezhnograd + décor de toundra (M6) ----
// Mobilier M9.1 en vrais GLB Meshy (repli codé main conservé par prop)
const cityFurniture = {
  marketStall: bundle.cityProps.marketStall ? loadProp(bundle.cityProps.marketStall, { targetHeight: 2.3 }) : null,
  crate: bundle.cityProps.crate ? loadProp(bundle.cityProps.crate, { targetHeight: 1.35 }) : null,
  barrel: bundle.cityProps.barrel ? loadProp(bundle.cityProps.barrel, { targetHeight: 0.85 }) : null,
  banner: bundle.cityProps.banner ? loadProp(bundle.cityProps.banner, { targetHeight: 3.7 }) : null,
  cityLamp: bundle.cityProps.cityLamp ? loadProp(bundle.cityProps.cityLamp, { targetHeight: 3.4 }) : null,
};
const cityField = new CityField(
  snow,
  track,
  obstacles,
  snowDecorProps,
  {
    lampPost: railDecor.lampPost,
    bench: trainBenchProp,
    ...cityFurniture,
  },
  bundle.windowsAtlas,
);
engine.scene.add(cityField.group);
engine.scene.add(buildFatuiCamp(snow, obstacles, snowDecorProps.brazier));
engine.scene.add(buildWreck(snow, obstacles, bundle.train.loco));
const railTrack = new RailTrack(track, ground, obstacles, railDecor, (x, z) => snow.getHeight(x, z));
engine.scene.add(railTrack.group);

// ---- Le train : navette continue, intro « il arrive de l'est » au boot ----
const train = new TrainSystem(track, bundle.train);
engine.scene.add(train.group);
// Intérieur marchable de la voiture 1 : ENFANT du root (yaw-only) — coïncide
// toujours avec le repère de simulation locale du joueur
const wagonInterior = new WagonInterior(
  train.coachInteriorHalfW,
  train.coachInteriorHalfL,
  train.coachFloorY,
  train.coachCeilY - train.coachFloorY,
  { bench: trainBenchProp, lantern: railDecor.wallLantern },
);
train.coachRoot.add(wagonInterior.group);

// L'herbe se sème APRÈS les props : les halos d'assise des rochers sont déjà
// tamponnés dans la splat, les touffes les évitent naturellement
const grass = new GrassField(engine.isWebGPU, terrain, ground);
engine.scene.add(grass.group);

// Validation de la carte (?mapdiag) : rejoue les gates de composition au boot
if (new URLSearchParams(location.search).has('mapdiag')) {
  const { runMapDiag } = await import('./world/MapDiag');
  runMapDiag(ground, terrain, track, snow);
}

// ---- Atmosphère : graines flottantes + sparkles des mufliers ----
const seeds = new SeedField();
engine.scene.add(seeds.mesh);
const sparkles = new SparkleField(props.snapdragonAnchors);
if (sparkles.mesh) engine.scene.add(sparkles.mesh);

// ---- Joueur ----
const input = new InputManager(canvas);
// Le routeur de sol (carte + neige) remplace le HeightField nu : le contrôleur
// et la caméra fonctionnent à l'identique sur la carte, et « gratuitement »
// côté neige à l'arrivée du train
const player = new CharacterController(input, groundRouter, obstacles);
player.wind = windCols; // portance des colonnes (M7)
if (new URLSearchParams(location.search).has('glider')) {
  player.unlockGlider(); // debug : ?glider (+ ?wind pour activer les colonnes)
}
if (new URLSearchParams(location.search).has('wind')) windCols.activate();
const camera = new ThirdPersonCamera(engine.camera, input, player, groundRouter);
player.setYawProvider(camera);
// Hook de test headless (?yaw=<rad>) : cap caméra initial déterministe — la
// visée par mouse.move est impossible en pointer lock sous Playwright (seul le
// premier move produit un delta, les suivants aux mêmes coords donnent 0)
const lookParams = new URLSearchParams(location.search);
const yawParam = lookParams.get('yaw');
if (yawParam !== null) camera.yaw = Number(yawParam);
const pitchParam = lookParams.get('pitch');
if (pitchParam !== null) camera.pitch = Number(pitchParam);

// Modèle : héroïne Meshy si présente, capsule placeholder sinon
const playerRoot = new Group();
playerRoot.rotation.order = 'YXZ'; // Ry (cap) puis Rx (inclinaison de grimpe)
// « Aile de Givre » (M9) : aile GLB miroitée + plumes monde (repli delta M7)
const gliderWings = new GliderWings(playerRoot, engine.scene, bundle.gliderWing);
let animations: AnimationStateMachine | null = null;
let assembled: AssembledCharacter | null = null;
if (bundle.character) {
  assembled = assembleCharacter(bundle.character.rigged, bundle.character.clips);
  playerRoot.add(assembled.root);
  animations = new AnimationStateMachine(assembled.mixer, assembled.actions, player);
} else {
  const capsule = new Mesh(
    new CapsuleGeometry(CHARACTER.capsuleRadius, CHARACTER.heightMeters - CHARACTER.capsuleRadius * 2, 6, 14),
    ToonMaterials.placeholder(),
  );
  capsule.position.y = CHARACTER.heightMeters / 2;
  capsule.castShadow = true;
  playerRoot.add(capsule);
  console.info('[main] personnage Meshy absent — capsule placeholder');
}
engine.scene.add(playerRoot);

// ---- Combat (M4) : épée, golems, système, VFX ----
const fightFlag = new URLSearchParams(location.search).has('fight');
const swordMount = assembled
  ? new SwordMount(assembled.skinnedScene, assembled.sceneScale, bundle.sword)
  : new SwordMount(new Group(), 1, null);
const events = new CombatEvents();
const shake = new CameraShake(engine.camera);
// Combat sur le SOL ROUTÉ (M6) : les créatures vivent aussi en Snezhnaya
const projectiles = new ProjectileManager(engine.scene, player, groundRouter, events);
const wraithProp = bundle.snowEnemies.wraith ? loadProp(bundle.snowEnemies.wraith, { targetHeight: 1.7 }) : null;
const enemies = new EnemyManager(
  engine.scene, bundle.golem, camps, player, groundRouter, obstacles, events, fightFlag,
  bundle.snowEnemies, wraithProp, projectiles,
);
const combat = new CombatSystem(input, player, camera, animations, enemies, events, shake, engine, groundRouter, fightFlag);
enemies.setCombat(combat);
projectiles.setCombat(combat);
const vfx = new VfxSystem(engine.scene, events, player, groundRouter, swordMount);

// ---- Chevauchée du train : F pour monter/descendre, sécurité de voie ----
const ride = new RideController(
  input,
  player,
  camera,
  train,
  wagonInterior,
  railTrack.platformCenters,
  (x, z) => groundRouter.getHeight(x, z),
);
// ---- Froid mordant + interactions F de Snezhnaya (M6) ----
const cold = new ColdSystem(player, combat, ride, snow);
// Props de quête M7.1 : deux échelles depuis le même GLB (loadProp clone la géométrie)
const questCrystalBig = bundle.questProps.crystal ? loadProp(bundle.questProps.crystal, { targetHeight: 1.6 }) : null;
const questCrystalSmall = bundle.questProps.crystal ? loadProp(bundle.questProps.crystal, { targetHeight: 0.8 }) : null;
const questAltarProp = bundle.questProps.altar ? loadProp(bundle.questProps.altar, { targetHeight: 2.3 }) : null;
const seelieProp = bundle.questProps.seelie ? loadProp(bundle.questProps.seelie, { targetHeight: QUEST7.seelieModel.height }) : null;
const interactions = new InteractionManager(
  engine.scene, input, player, ride, cold, combat, events, snow, snowDecorProps.brazier, obstacles,
  questCrystalSmall,
);

// ---- BOSS « Garde-Chasse Automate » (M6) : dort près de l'épave ----
let boss: BossEnemy | null = null;
if (bundle.snowEnemies.boss) {
  const ab = assembleCharacter<BossClipName>(bundle.snowEnemies.boss.rigged, bundle.snowEnemies.boss.clips, {
    targetHeight: BOSS.heightM,
  });
  const bossSet = ToonMaterials.golemSet(ab.albedo, 0.012 / ab.sceneScale, '#b78cff');
  ab.skinnedScene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    mesh.material = o.userData.isOutline ? bossSet.outlineMaterial : bossSet.material;
  });
  const bossRoot = new Group();
  bossRoot.add(ab.skinnedScene);
  engine.scene.add(bossRoot);
  const bossActions: Partial<Record<BossClipName, AnimationAction>> = {};
  for (const [name, clip] of Object.entries(ab.clips)) {
    if (clip) bossActions[name as BossClipName] = ab.mixer.clipAction(clip);
  }
  boss = new BossEnemy(
    bossRoot, ab.mixer, new ClipPlayer(bossActions), bossSet,
    { x: WRECK.arena.x, z: WRECK.arena.z - 6 }, groundRouter, obstacles, events, projectiles,
    cold.brazierLit,
  );
  enemies.add(boss);
}
const arena = new ArenaController(engine.scene, player, combat, boss, interactions, snow, obstacles);
// Respawn régionalisé : dernier brasero allumé > quai de gare Toundra > spawn vallée
combat.respawnResolver = (x, z) => {
  if (snow.contains(x, z)) {
    if (cold.lastLitIndex >= 0 && cold.brazierLit[cold.lastLitIndex]) {
      const b = BRAZIERS[cold.lastLitIndex]!;
      return { x: b.x + 1.5, z: b.z + 1.5 };
    }
    if (snow.inCity(x, z)) return { x: RAIL.stationCity.x, z: RAIL.stationCity.z - 4 };
    return { x: RAIL.stationSnow.x + 2.5, z: RAIL.stationSnow.z };
  }
  return { x: 0, z: 0 };
};
combat.onRespawn = () => cold.reset();

// Titres de région à l'arrivée (uniquement si le joueur est à bord)
train.onArrive = (station) => {
  if (!ride.aboard) return;
  if (station === 'snow') hud.regionTitle.show(TRAIN.snowTitle, TRAIN.snowSubtitle);
  else if (station === 'city') hud.regionTitle.show(TRAIN.cityTitle, TRAIN.citySubtitle);
  else hud.regionTitle.show();
};

// ---- HUD ----
const hud = new Hud(
  {
    player,
    orbit: camera,
    camera: engine.camera,
    questPos: terrain.questPosition,
    portraitUrl: bundle.portraitUrl,
    playerVisual: playerRoot, // transform interpolée (roue d'endurance, minimap)
    minimapTrees: props.minimapTrees,
    snapdragonAnchors: props.snapdragonAnchors,
    combat,
    enemies,
    events,
    ride,
    snowMap: { snow, track, buildings: cityField.buildingAnchors },
    cold,
    interactions,
    boss,
  },
  terrain,
  ground,
  input,
);
// Quête de cristaux : le compteur remplace l'objectif dès le premier ramassage
interactions.onCrystals = (n, total) => hud.setQuestObjective(`Cristaux de givre : ${n}/${total}`);

// ---- Quête M7 « La Bénédiction des Vents du Nord » ----
const dialogue = new Dialogue(hud.root);
const npc = new Npc(snow, bundle.npc.rigged, { idle: bundle.npc.idle, talk: bundle.npc.talk });
engine.scene.add(npc.group);
const seelie = new Seelie(snow, seelieProp);
engine.scene.add(seelie.group);
const puzzle = new ResonancePuzzle(snow, questCrystalBig);
engine.scene.add(puzzle.group);
// Hooks audio remplis APRÈS la construction du bloc audio — déclarés AVANT
// QuestSystem : son constructeur appelle le callback d'objectif au boot, un
// `let` déclaré plus bas serait en zone morte temporelle (TDZ, boot bloqué)
let questDing: (() => void) | null = null;
let exploStinger: (() => void) | null = null;
const quest = new QuestSystem(
  engine.scene, input, player, ride, interactions, dialogue, npc, seelie, puzzle,
  windCols, enemies, combat, events, snow,
  terrain.questPosition, // Vector3 PARTAGÉ avec le tracker du HUD
  (t) => {
    hud.setQuestObjective(t);
    questDing?.(); // ding Genshin de mise à jour d'objectif (câblé après l'audio)
  },
  (a, b) => {
    hud.regionTitle.show(a, b);
    sfx.regionStinger();
  },
  questAltarProp,
);
hud.setQuest(quest);

// ---- Exploration M7.3 : stèles de lore, agates de givre, défi des vents ----
const explo = new Exploration(
  engine.scene, input, player, ride, interactions, quest, dialogue, snow,
  (a, b) => {
    hud.regionTitle.show(a, b);
    exploStinger?.(); // même stinger que les toasts de quête (cohérence)
  },
  hud.root,
  {
    stele: bundle.cityProps.stele ? loadProp(bundle.cityProps.stele, { targetHeight: 1.6 }) : null,
    totem: bundle.cityProps.totem ? loadProp(bundle.cityProps.totem, { targetHeight: 2.5 }) : null,
  },
);
hud.setExploration(explo);

// ---- Audio (M8) : SFX procéduraux + nappes mp3 + voix ElevenLabs ----
const audioEngine = new AudioEngine(!new URLSearchParams(location.search).has('noaudio'));
audioEngine.installUnlock(canvas);
// Échantillons foley Magnific (M8.1) — retour utilisateur : « tout doit avoir
// un sfx généré », les recettes procédurales deviennent le REPLI
const sfxSamples = new SamplePlayer(audioEngine);
void sfxSamples.load(); // différé, HORS écran de chargement (boot inchangé)
const sfx = new Sfx(audioEngine, sfxSamples);
const ambience = new AmbienceMixer(audioEngine);
// M8.1 : nappes Lyria NON chargées — retour utilisateur « retire la musique,
// il faut que des sfx ». Le mixer reste inerte (buffers null), fichiers gardés.
const voice = new VoicePlayer(audioEngine);
const audioSys = new AudioSystem({
  engine: audioEngine, sfx, ambience, voice,
  player, camera: engine.camera, events, train, ride, cold, interactions, quest, dialogue, windCols, seelie,
  surfaces: { player, groundRouter, snow, track, ground, terrain },
});
// Voix de dialogue : chaque ligne affichée joue son mp3 (clé `voice:`) + tick UI
dialogue.onLine = (line, index) => {
  if (index > 0) sfx.uiDialogueAdvance();
  if (line.voice) void voice.playLine(line.voice);
};
// Câblages événementiels sans event CombatEvents
train.onDepart = () => {
  const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  train.coachPose(pose);
  const p = { pan: 0, gain: 0 };
  audioEngine.panFor(pose.x, pose.y, pose.z, engine.camera, p);
  if (ride.aboard) sfx.trainWhistle(0, 0.6);
  else if (p.gain > 0.02) sfx.trainWhistle(p.pan, p.gain);
};
{
  const prevArrive = train.onArrive; // chaîné : les titres de région restent
  train.onArrive = (station) => {
    prevArrive?.(station);
    if (ride.aboard) sfx.trainBell(0, 0.5);
  };
  const prevCrystals = interactions.onCrystals; // chaîné : l'objectif HUD reste
  interactions.onCrystals = (n, total) => {
    prevCrystals?.(n, total);
    sfx.crystalPickup();
  };
}
interactions.onChest = () => {
  sfx.chestOpen();
  voice.bark('victory');
};
interactions.onInfusion = () => sfx.infusion();
puzzle.onNote = (i) => sfx.resonanceNote(i);
puzzle.onSolved = () => {
  sfx.resonanceSolved();
  voice.bark('victory');
};
puzzle.onFail = () => sfx.resonanceFail();
windCols.onActivate = () => sfx.windColumnsActivate();
questDing = () => sfx.questDing();
exploStinger = () => sfx.regionStinger();
quest.onGuardians = () => {
  sfx.enemyRoar(0, 0.8); // les spectres gardiens surgissent — annonce immédiate
  sfx.reaction('superconduct');
};
// Exploration M7.3 : agates, anneaux du défi, coffres
explo.onAgate = (n) => sfx.agatePickup(n);
explo.onTrialStart = () => sfx.trialStart();
explo.onTrialRing = (i) => sfx.trialRing(i);
explo.onTrialEnd = (won) => (won ? sfx.resonanceSolved() : sfx.resonanceFail());
explo.onChest = () => {
  sfx.chestOpen();
  voice.bark('victory');
};
hud.skills.onCue = (cue) => (cue === 'cooldownReady' ? sfx.uiCooldownReady() : sfx.uiEnergyFull());
// ?audiodiag : état du mixer + dernier SFX à 1 Hz (canaris [Audio] pour les tests)
if (new URLSearchParams(location.search).has('audiodiag')) {
  setInterval(() => {
    const g = audioSys.diag;
    console.info(`[Audio] diag unlocked=${g.unlocked} lastSfx=${g.lastSfx} lastVoice=${g.lastVoice} gains=${JSON.stringify(g.ambGains)}`);
  }, 1000);
}

// ---- Systèmes ----
engine.add(train);   // AVANT le joueur : snapshot prevS puis avance s — le
                     // frame du wagon est à jour quand le joueur local se compose
engine.add(player);
engine.add(combat);  // consomme Mouse0/E/Q — AVANT clearFrame
engine.add(enemies); // FSM en pas fixe ; mixers + interpolation en update
engine.add(projectiles); // éclats de glace : intégration fixe, rendu interpolé
engine.add(ride);    // consomme KeyF — AVANT clearFrame
engine.add(interactions); // consomme KeyF (braseros/cristaux) — APRÈS ride, AVANT clearFrame
engine.add(quest);        // consomme KeyF (dialogue/cristaux de résonance/autels)
engine.add(explo);        // consomme KeyF (stèles/offrande/défi) — dernier de la chaîne F
engine.add({
  fixedUpdate: (dt) => puzzle.update(dt), // chrono de résonance en pas fixe
  update: (dt) => {
    npc.update(dt, playerRoot.position.x, playerRoot.position.z);
    seelie.update(dt, playerRoot.position.x, playerRoot.position.z);
  },
});
engine.add(cold);    // jauge de froid (drain via combat)
engine.add(arena);   // trigger + murs + coffre du boss
engine.add({ fixedUpdate: () => input.clearFrame() }); // toujours après les consommateurs
engine.add(camera);
engine.add(shake);   // après le lookAt de la caméra, avant les projections HUD
engine.add({
  update: (dt, alpha) => {
    // Rendu interpolé entre les deux derniers pas fixes : à 120 Hz (ProMotion),
    // copier l'état 60 Hz brut fait « strober » le modèle une frame sur deux
    player.renderPosition(alpha, playerRoot.position);
    playerRoot.rotation.y = player.renderHeading(alpha);
    playerRoot.rotation.x = player.renderLean(alpha); // buste vers la paroi en grimpe
    animations?.update(dt);
    sky.followCamera(engine.camera.position.x, engine.camera.position.z);
    lighting.followPlayer(playerRoot.position.x, playerRoot.position.z);
    ripple.update(playerRoot.position.x, playerRoot.position.y, playerRoot.position.z);
    seeds.follow(playerRoot.position.x, playerRoot.position.y, playerRoot.position.z);
    grass.update(engine.camera.position); // culling de distance des chunks d'herbe
    gliderWings.update(dt, player); // ailes du planeur (visibles en plané)
    swordMount.setVisible(player.mode !== 'glide'); // arme rangée en vol (M9.3)
    // Lame embrasée : flammes animées tant que l'infusion Pyro court (M10)
    vfx.setSwordFire(combat.infusion?.element === 'pyro' && player.mode !== 'glide');
    // Ambiances : crossfade vallée→toundra sur le Z monde (dans le noir du
    // tube), puis toundra→NUIT d'aurore sur le viaduc (M6)
    const pz = playerRoot.position.z;
    const ambT = Math.min(Math.max((pz - AMBIENCE.zLo) / (AMBIENCE.zHi - AMBIENCE.zLo), 0), 1);
    const ambS = ambT * ambT * (3 - 2 * ambT);
    const nightT = Math.min(Math.max((pz - AMBIENCE.nightZLo) / (AMBIENCE.nightZHi - AMBIENCE.nightZLo), 0), 1);
    const nightS = nightT * nightT * (3 - 2 * nightT);
    sky.setAmbience(ambS, nightS);
    lighting.setAmbience(ambS, nightS);
    audioSys.setRegion(ambS, nightS);
    const tundraW = ambS * (1 - nightS);
    snowfall.update(
      playerRoot.position.x,
      playerRoot.position.y,
      playerRoot.position.z,
      ambS * (1 - nightS * (1 - AMBIENCE.night.snowfall)),
      Math.min(1, tundraW * AMBIENCE.blizzard.base + quest.envBoost * 0.85),
    );
    hud.update(dt);
  },
});
engine.add(cityField); // volute du palais + cheminées (rendu pur)
engine.add(windCols);  // fondu d'activation des colonnes de vent (M7)
engine.add(vfx); // APRÈS les mixers : la traînée échantillonne l'os déjà posé
engine.add(audioSys); // lit events.list + fronts joueur/train — AVANT events.clear()
engine.add({ update: () => events.clear() }); // TOUJOURS dernier (file sim→rendu)

// ---- Post-processing + précompilation des shaders puis démarrage ----
engine.initPost();
// L'anneau de wading doit être visible pendant le compile (les objets invisibles
// sont sautés par compileAsync ET par le render de warmup — à-coup sinon à la
// première entrée dans l'eau)
ripple.mesh.visible = true;
vfx.setCompileVisible(true); // la tornade du Q compile derrière le chargement
// Le terrain neige est à 190 m DERRIÈRE la caméra de boot : sans ce toggle son
// shader compilerait en jeu au premier regard par la fenêtre du wagon
snow.mesh.frustumCulled = false;
gliderWings.group.visible = true; // ailes du planeur : compile au warmup (M7)
await engine.compile();
ripple.mesh.visible = false;
vfx.setCompileVisible(false);
snow.mesh.frustumCulled = true;
gliderWings.group.visible = false;
loadingScreen.setProgress(1);
engine.start();
await loadingScreen.finish();
hud.regionTitle.show();

// Sondes headless : objets exposés + état + bascules de debug
(window as unknown as { __t?: unknown }).__t = { ride, player, train, camera, input, cold, interactions, combat, enemies, boss, quest, puzzle, seelie, windCols, npc, audio: audioSys, explo, snow };
(window as unknown as { __dbg?: (toggle?: string) => unknown }).__dbg = (toggle?: string) => {
  if (toggle) {
    engine.scene.traverse((o) => {
      if (o.name === toggle) o.visible = !o.visible;
    });
  }
  return {
    playerRoot: playerRoot.position.toArray().map((v) => Number(v.toFixed(2))),
    camera: engine.camera.position.toArray().map((v) => Number(v.toFixed(2))),
    aboard: ride.aboard,
    trainState: train.state,
  };
};
