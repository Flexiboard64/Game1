import { LoadingManager, SRGBColorSpace, RepeatWrapping, Texture, TextureLoader } from 'three/webgpu';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { ASSET_URLS } from '../assets/manifest';
import type { BossClipName, ClipName, GolemClipName, OperativeClipName, VolkodlakClipName } from '../assets/CharacterLoader';

export interface CharacterAssets {
  rigged: GLTF;
  /** Record COMPLET : ajouter un ClipName force à décider de son chargement ici. */
  clips: Record<ClipName, GLTF | null>;
}

export interface GolemAssets {
  rigged: GLTF;
  clips: Record<GolemClipName, GLTF | null>;
}

export interface PropAssets {
  treeA: GLTF | null;
  treeB: GLTF | null;
  bush: GLTF | null;
  boulderA: GLTF | null;
  boulderB: GLTF | null;
  fence: GLTF | null;
  snapdragon: GLTF | null;
}

/** GLB du train (M5) — null → caisses procédurales de secours (boxes toon). */
export interface TrainAssets {
  loco: GLTF | null;
  car: GLTF | null;
}

/** Décor ferroviaire Meshy (M5.1) — chaque null → repli procédural gracieux. */
export interface RailDecorAssets {
  lampPost: GLTF | null;
  wallLantern: GLTF | null;
  trainBench: GLTF | null;
  stationShelter: GLTF | null;
}

/** Kit ville + toundra Snezhnaya (M6) — chaque null → élément simplement absent. */
export interface SnowDecorAssets {
  houseA: GLTF | null;
  houseB: GLTF | null;
  marketHall: GLTF | null;
  watchtower: GLTF | null;
  palace: GLTF | null;
  cityGate: GLTF | null;
  frozenStatue: GLTF | null;
  deadTree: GLTF | null;
  crystalBush: GLTF | null;
  brazier: GLTF | null;
}

/** Créatures Snezhnaya (M6). Wraith = mesh statique (anims TSL, pas de rig). */
export interface SnowEnemyAssets {
  wraith: GLTF | null;
  volkodlak: { rigged: GLTF; clips: Record<VolkodlakClipName, GLTF | null> } | null;
  operative: { rigged: GLTF; clips: Record<OperativeClipName, GLTF | null> } | null;
  boss: { rigged: GLTF; clips: Record<BossClipName, GLTF | null> } | null;
}

export interface AssetBundle {
  textures: { grass: Texture; dirt: Texture; rock: Texture };
  /** null si les GLB Meshy ne sont pas (encore) présents → capsule placeholder. */
  character: CharacterAssets | null;
  /** null si le portrait n'est pas (encore) généré → pastille placeholder. */
  portraitUrl: string | null;
  /** Chaque prop null → espèce simplement absente du semis (warn console). */
  props: PropAssets;
  flowerAtlas: Texture | null;
  /** null → Aeliana combat à mains nues (montage dégradé, jamais de crash). */
  sword: GLTF | null;
  /** null → aucun ennemi semé (combat à vide fonctionnel + warn). */
  golem: GolemAssets | null;
  train: TrainAssets;
  railDecor: RailDecorAssets;
  snowDecor: SnowDecorAssets;
  snowEnemies: SnowEnemyAssets;
  /** PNJ Nadya (M7) — null → silhouette de secours, quête jouable quand même. */
  npc: { rigged: GLTF | null; idle: GLTF | null; talk: GLTF | null };
  /** Props de quête M7.1 — null → repli procédural (octaèdres/autel codé main). */
  questProps: { crystal: GLTF | null; altar: GLTF | null; seelie: GLTF | null };
  /** Aile de planeur M9 — null → repli voilures delta procédurales (M7). */
  gliderWing: GLTF | null;
  /** Mobilier Snezhnaya M9.1 — chaque null → repli codé main (M6.2/M7.3). */
  cityProps: {
    marketStall: GLTF | null;
    crate: GLTF | null;
    barrel: GLTF | null;
    banner: GLTF | null;
    stele: GLTF | null;
    totem: GLTF | null;
    /** M9.2 : lampadaire orné dédié — null → lampadaire de quai (M5.1). */
    cityLamp: GLTF | null;
  };
  /** M9.2 : atlas 2×2 de fenêtres chaudes — null → quads émissifs unis (M6). */
  windowsAtlas: Texture | null;
}

export class AssetManager {
  onProgress: ((ratio: number) => void) | null = null;

  async loadAll(): Promise<AssetBundle> {
    const manager = new LoadingManager();
    manager.onProgress = (_url, loaded, total) => {
      this.onProgress?.(total > 0 ? loaded / total : 0);
    };

    const texLoader = new TextureLoader(manager);
    const gltfLoader = new GLTFLoader(manager);

    const loadTexture = async (url: string): Promise<Texture> => {
      const t = await texLoader.loadAsync(url);
      t.colorSpace = SRGBColorSpace;
      t.wrapS = RepeatWrapping;
      t.wrapT = RepeatWrapping;
      t.anisotropy = 8;
      // Indispensable : le WebGPURenderer fige le sampler au premier upload,
      // les changements de wrap doivent être re-signalés
      t.needsUpdate = true;
      return t;
    };

    const tryGltf = async (url: string): Promise<GLTF | null> => {
      try {
        return await gltfLoader.loadAsync(url);
      } catch {
        console.warn(`[AssetManager] asset absent ou illisible : ${url}`);
        return null;
      }
    };

    /** Texture optionnelle (atlas alpha) : pas de RepeatWrapping, 404 toléré. */
    const tryTexture = async (url: string): Promise<Texture | null> => {
      try {
        const t = await texLoader.loadAsync(url);
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = 4;
        t.needsUpdate = true;
        return t;
      } catch {
        console.warn(`[AssetManager] texture absente : ${url}`);
        return null;
      }
    };

    const tryImage = (url: string): Promise<string | null> =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(url);
        img.onerror = () => {
          console.warn(`[AssetManager] portrait absent : ${url}`);
          resolve(null);
        };
        img.src = url;
      });

    const [grass, dirt, rock, rigged, idle, walk, run, sprint, jump, glide,
      climb, climbGrab, attack1, attack2, attack3, skill, burst, sword,
      golemRigged, golemIdle, golemWalk, golemRoar, golemAttack, golemHit, golemDeath,
      portraitUrl,
      treeA, treeB, bush, boulderA, boulderB, fence, snapdragon, flowerAtlas,
      trainLoco, trainCar, lampPost, wallLantern, trainBench, stationShelter,
      houseA, houseB, marketHall, watchtower, palace, cityGate, frozenStatue, deadTree, crystalBush, brazier,
      wraith,
      volkRigged, volkIdle, volkWalk, volkRun, volkHowl, volkAttack, volkHit, volkDeath,
      opRigged, opIdle, opWalk, opAttack, opParry, opHit, opDeath,
      bossRigged, bossIdle, bossWalk, bossAttack, bossRoar, bossDeath,
      npcRigged, npcIdle, npcTalk, questCrystal, questAltar, questSeelie, gliderWing,
      marketStall, crateStack, barrelProp, bannerPole, loreStele, trialTotem,
      cityLamp, windowsAtlas] =
      await Promise.all([
        loadTexture(ASSET_URLS.texGrass),
        loadTexture(ASSET_URLS.texDirt),
        loadTexture(ASSET_URLS.texRock),
        tryGltf(ASSET_URLS.charRigged),
        tryGltf(ASSET_URLS.animIdle),
        tryGltf(ASSET_URLS.animWalk),
        tryGltf(ASSET_URLS.animRun),
        tryGltf(ASSET_URLS.animSprint),
        tryGltf(ASSET_URLS.animJump),
        tryGltf(ASSET_URLS.animGlide),
        tryGltf(ASSET_URLS.animClimb),
        tryGltf(ASSET_URLS.animClimbGrab),
        tryGltf(ASSET_URLS.animAttack1),
        tryGltf(ASSET_URLS.animAttack2),
        tryGltf(ASSET_URLS.animAttack3),
        tryGltf(ASSET_URLS.animSkill),
        tryGltf(ASSET_URLS.animBurst),
        tryGltf(ASSET_URLS.swordBlade),
        tryGltf(ASSET_URLS.golemRigged),
        tryGltf(ASSET_URLS.golemIdle),
        tryGltf(ASSET_URLS.golemWalk),
        tryGltf(ASSET_URLS.golemRoar),
        tryGltf(ASSET_URLS.golemAttack),
        tryGltf(ASSET_URLS.golemHit),
        tryGltf(ASSET_URLS.golemDeath),
        tryImage(ASSET_URLS.portrait),
        tryGltf(ASSET_URLS.propTreeA),
        tryGltf(ASSET_URLS.propTreeB),
        tryGltf(ASSET_URLS.propBush),
        tryGltf(ASSET_URLS.propBoulderA),
        tryGltf(ASSET_URLS.propBoulderB),
        tryGltf(ASSET_URLS.propFence),
        tryGltf(ASSET_URLS.propSnapdragon),
        tryTexture(ASSET_URLS.texFlowerAtlas),
        tryGltf(ASSET_URLS.propTrainLoco),
        tryGltf(ASSET_URLS.propTrainCar),
        tryGltf(ASSET_URLS.propLampPost),
        tryGltf(ASSET_URLS.propWallLantern),
        tryGltf(ASSET_URLS.propTrainBench),
        tryGltf(ASSET_URLS.propStationShelter),
        tryGltf(ASSET_URLS.propHouseA),
        tryGltf(ASSET_URLS.propHouseB),
        tryGltf(ASSET_URLS.propMarketHall),
        tryGltf(ASSET_URLS.propWatchtower),
        tryGltf(ASSET_URLS.propPalace),
        tryGltf(ASSET_URLS.propCityGate),
        tryGltf(ASSET_URLS.propFrozenStatue),
        tryGltf(ASSET_URLS.propDeadTree),
        tryGltf(ASSET_URLS.propCrystalBush),
        tryGltf(ASSET_URLS.propBrazier),
        tryGltf(ASSET_URLS.enemyWraith),
        tryGltf(ASSET_URLS.volkRigged),
        tryGltf(ASSET_URLS.volkIdle),
        tryGltf(ASSET_URLS.volkWalk),
        tryGltf(ASSET_URLS.volkRun),
        tryGltf(ASSET_URLS.volkHowl),
        tryGltf(ASSET_URLS.volkAttack),
        tryGltf(ASSET_URLS.volkHit),
        tryGltf(ASSET_URLS.volkDeath),
        tryGltf(ASSET_URLS.opRigged),
        tryGltf(ASSET_URLS.opIdle),
        tryGltf(ASSET_URLS.opWalk),
        tryGltf(ASSET_URLS.opAttack),
        tryGltf(ASSET_URLS.opParry),
        tryGltf(ASSET_URLS.opHit),
        tryGltf(ASSET_URLS.opDeath),
        tryGltf(ASSET_URLS.bossRigged),
        tryGltf(ASSET_URLS.bossIdle),
        tryGltf(ASSET_URLS.bossWalk),
        tryGltf(ASSET_URLS.bossAttack),
        tryGltf(ASSET_URLS.bossRoar),
        tryGltf(ASSET_URLS.bossDeath),
        tryGltf(ASSET_URLS.npcNadyaRigged),
        tryGltf(ASSET_URLS.npcNadyaIdle),
        tryGltf(ASSET_URLS.npcNadyaTalk),
        tryGltf(ASSET_URLS.propQuestCrystal),
        tryGltf(ASSET_URLS.propQuestAltar),
        tryGltf(ASSET_URLS.propSeelie),
        tryGltf(ASSET_URLS.propGliderWing),
        tryGltf(ASSET_URLS.propMarketStall),
        tryGltf(ASSET_URLS.propCrateStack),
        tryGltf(ASSET_URLS.propBarrel),
        tryGltf(ASSET_URLS.propBanner),
        tryGltf(ASSET_URLS.propLoreStele),
        tryGltf(ASSET_URLS.propTrialTotem),
        tryGltf(ASSET_URLS.propCityLamp),
        tryTexture(ASSET_URLS.texWindowsAtlas),
      ]);

    return {
      textures: { grass, dirt, rock },
      character: rigged
        ? { rigged, clips: { idle, walk, run, sprint, jump, glide, climb, climbGrab, attack1, attack2, attack3, skill, burst } }
        : null,
      portraitUrl,
      props: { treeA, treeB, bush, boulderA, boulderB, fence, snapdragon },
      flowerAtlas,
      sword,
      golem: golemRigged
        ? { rigged: golemRigged, clips: { idle: golemIdle, walk: golemWalk, roar: golemRoar, attack: golemAttack, hit: golemHit, death: golemDeath } }
        : null,
      train: { loco: trainLoco, car: trainCar },
      railDecor: { lampPost, wallLantern, trainBench, stationShelter },
      snowDecor: { houseA, houseB, marketHall, watchtower, palace, cityGate, frozenStatue, deadTree, crystalBush, brazier },
      snowEnemies: {
        wraith,
        volkodlak: volkRigged
          ? { rigged: volkRigged, clips: { idle: volkIdle, walk: volkWalk, run: volkRun, howl: volkHowl, attack: volkAttack, hit: volkHit, death: volkDeath } }
          : null,
        operative: opRigged
          ? { rigged: opRigged, clips: { idle: opIdle, walk: opWalk, attack: opAttack, parry: opParry, hit: opHit, death: opDeath } }
          : null,
        boss: bossRigged
          ? { rigged: bossRigged, clips: { idle: bossIdle, walk: bossWalk, attack: bossAttack, roar: bossRoar, death: bossDeath } }
          : null,
      },
      npc: { rigged: npcRigged, idle: npcIdle, talk: npcTalk },
      questProps: { crystal: questCrystal, altar: questAltar, seelie: questSeelie },
      gliderWing,
      cityProps: {
        marketStall,
        crate: crateStack,
        barrel: barrelProp,
        banner: bannerPole,
        stele: loreStele,
        totem: trialTotem,
        cityLamp,
      },
      windowsAtlas,
    };
  }
}
