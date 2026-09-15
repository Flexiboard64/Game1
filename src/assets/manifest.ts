// Manifeste typé des assets runtime. Les chemins pointent vers public/.

export const ASSET_URLS = {
  texGrass: '/assets/textures/terrain/grass.jpg',
  texDirt: '/assets/textures/terrain/dirt.jpg',
  texRock: '/assets/textures/terrain/rock.jpg',
  charRigged: '/assets/character/heroine.rigged.glb',
  animIdle: '/assets/character/anim.idle.glb',
  animWalk: '/assets/character/anim.walk.glb',
  animRun: '/assets/character/anim.run.glb',
  animSprint: '/assets/character/anim.sprint.glb',
  animJump: '/assets/character/anim.jump.glb',
  animGlide: '/assets/character/anim.glide.glb', // pose suspendue (Bar_Hang_Idle 478) — plané M9.3
  animClimb: '/assets/character/anim.climb.glb',
  animClimbGrab: '/assets/character/anim.climbgrab.glb',
  animAttack1: '/assets/character/anim.attack1.glb',
  animAttack2: '/assets/character/anim.attack2.glb',
  animAttack3: '/assets/character/anim.attack3.glb',
  animSkill: '/assets/character/anim.skill.glb',
  animBurst: '/assets/character/anim.burst.glb',
  swordBlade: '/assets/character/sword.glb',
  golemRigged: '/assets/enemies/golem.rigged.glb',
  golemIdle: '/assets/enemies/anim.golem.idle.glb',
  golemWalk: '/assets/enemies/anim.golem.walk.glb',
  golemRoar: '/assets/enemies/anim.golem.roar.glb',
  golemAttack: '/assets/enemies/anim.golem.attack.glb',
  golemHit: '/assets/enemies/anim.golem.hit.glb',
  golemDeath: '/assets/enemies/anim.golem.death.glb',
  portrait: '/assets/ui/portrait-cutout.png', // tête détourée (flood-fill local de portrait.png)
  propTreeA: '/assets/props/tree-a.glb',
  propTreeB: '/assets/props/tree-b.glb',
  propBush: '/assets/props/bush.glb',
  propBoulderA: '/assets/props/boulder-a.glb',
  propBoulderB: '/assets/props/boulder-b.glb',
  propFence: '/assets/props/fence.glb',
  propSnapdragon: '/assets/props/snapdragon.glb',
  propTrainLoco: '/assets/props/train-loco.glb',
  propTrainCar: '/assets/props/train-car.glb',
  propLampPost: '/assets/props/lamp-post.glb',
  propWallLantern: '/assets/props/wall-lantern.glb',
  propTrainBench: '/assets/props/train-bench.glb',
  propStationShelter: '/assets/props/station-shelter.glb',
  texFlowerAtlas: '/assets/textures/props/flowers-atlas.png',
  // ---- M6 Snezhnaya : kit ville + toundra ----
  propHouseA: '/assets/props/house-a.glb',
  propHouseB: '/assets/props/house-b.glb',
  propMarketHall: '/assets/props/market-hall.glb',
  propWatchtower: '/assets/props/watchtower.glb',
  propPalace: '/assets/props/palace.glb',
  propCityGate: '/assets/props/city-gate.glb',
  propFrozenStatue: '/assets/props/frozen-statue.glb',
  propDeadTree: '/assets/props/dead-tree.glb',
  propCrystalBush: '/assets/props/crystal-bush.glb',
  propBrazier: '/assets/props/brazier.glb',
  // ---- M6 : créatures (wraith SANS rig ; les autres riggées + clips) ----
  enemyWraith: '/assets/enemies/wraith.glb',
  volkRigged: '/assets/enemies/volkodlak.rigged.glb',
  volkIdle: '/assets/enemies/anim.volk.idle.glb',
  volkWalk: '/assets/enemies/anim.volk.walk.glb',
  volkRun: '/assets/enemies/anim.volk.run.glb',
  volkHowl: '/assets/enemies/anim.volk.howl.glb',
  volkAttack: '/assets/enemies/anim.volk.attack.glb',
  volkHit: '/assets/enemies/anim.volk.hit.glb',
  volkDeath: '/assets/enemies/anim.volk.death.glb',
  opRigged: '/assets/enemies/operative.rigged.glb',
  opIdle: '/assets/enemies/anim.op.idle.glb',
  opWalk: '/assets/enemies/anim.op.walk.glb',
  opAttack: '/assets/enemies/anim.op.attack.glb',
  opParry: '/assets/enemies/anim.op.parry.glb',
  opHit: '/assets/enemies/anim.op.hit.glb',
  opDeath: '/assets/enemies/anim.op.death.glb',
  bossRigged: '/assets/enemies/boss.rigged.glb',
  bossIdle: '/assets/enemies/anim.boss.idle.glb',
  bossWalk: '/assets/enemies/anim.boss.walk.glb',
  bossAttack: '/assets/enemies/anim.boss.attack.glb',
  bossRoar: '/assets/enemies/anim.boss.roar.glb',
  bossDeath: '/assets/enemies/anim.boss.death.glb',
  // ---- M7 : PNJ Nadya (donneuse de la première quête) ----
  npcNadyaRigged: '/assets/npc/nadya.rigged.glb',
  npcNadyaIdle: '/assets/npc/anim.nadya.idle.glb',
  npcNadyaTalk: '/assets/npc/anim.nadya.talk.glb',
  // ---- M7.1 : props de quête en vrais GLB (cristaux + autels) ----
  propQuestCrystal: '/assets/props/crystal-cluster.glb',
  propQuestAltar: '/assets/props/frost-altar.glb',
  // Luciole de givre en vrai GLB (esprit flottant, anims procédurales)
  propSeelie: '/assets/props/seelie-spirit.glb',
  // ---- M9 : aile du planeur en vrai GLB (une aile GAUCHE, miroitée en code) ----
  propGliderWing: '/assets/props/glider-wing.glb',
  // ---- M9.1 : mobilier Snezhnaya en vrais GLB (fin des modèles codés main) ----
  propMarketStall: '/assets/props/market-stall.glb',
  propCrateStack: '/assets/props/crate-stack.glb',
  propBarrel: '/assets/props/barrel.glb',
  propBanner: '/assets/props/banner-pole.glb',
  propLoreStele: '/assets/props/lore-stele.glb',
  propTrialTotem: '/assets/props/trial-totem.glb',
  // ---- M9.2 : lampadaire orné de Snezhnograd + atlas de fenêtres chaudes ----
  propCityLamp: '/assets/props/city-lamp.glb',
  texWindowsAtlas: '/assets/textures/props/windows-atlas.jpg',
} as const;

export type AssetKey = keyof typeof ASSET_URLS;

// ---- M8 : nappes d'ambiance audio (Lyria) — chargées PARESSEUSEMENT par
// AudioEngine.loadBuffer (hors LoadingManager : boot inchangé). Les voix
// (public/assets/audio/voice/*.mp3) suivent une convention de nommage
// (clé `voice:` des DialogueLine, `aeliana-<kind>-<n>` pour les barks).
export const AUDIO_URLS = {
  ambValley: '/assets/audio/ambience/valley-wind.m4a',
  ambRiver: '/assets/audio/ambience/river.m4a',
  ambBlizzard: '/assets/audio/ambience/blizzard.m4a',
  ambCityNight: '/assets/audio/ambience/city-night.m4a',
  ambTrain: '/assets/audio/ambience/train-interior.m4a',
} as const;
