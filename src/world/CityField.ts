import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Texture,
  Vector3,
} from 'three/webgpu';
import { color, mix, mx_noise_float, smoothstep, time, uv, vec2 } from 'three/tsl';
import { CITY, FATUI, FIRE, MESA, TRAIN } from '../config';
import { FireVfx } from '../vfx/FireVfx';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { LoadedProp } from '../assets/PropLoader';
import type { ObstacleGrid } from './Obstacles';
import type { SnowField } from './SnowField';
import type { TrackSpec } from './TrackSpec';
import type { Updatable } from '../core/Engine';

// Snezhnograd (M6) : la ville sur la mesa — maisons instanciées le long de la
// rue et autour de la place, halle, statue, palais Zapolyarny sur son tertre,
// porte de ville sertie dans la tranchée du rail, tours de guet sur le rebord.
// Fenêtres chaudes = quads émissifs instanciés (contraste chaud/froid, réf 1).
// Volute magique au-dessus de la flèche + cheminées fumantes (pool CPU).

interface Placement {
  x: number;
  z: number;
  yaw: number;
  s: number;
  prop: LoadedProp;
}

interface Puff {
  x: number;
  y: number;
  z: number;
  age: number;
  live: boolean;
}

const SMOKE = { count: 24, rate: 1.15, life: 3.4, rise: 1.5, drift: 0.35, size0: 0.3, size1: 0.95 } as const;

export class CityField implements Updatable {
  readonly group = new Group();
  /** Ancres XZ des bâtiments (minimap + exclusions éventuelles). */
  readonly buildingAnchors: { x: number; z: number; r: number }[] = [];

  private wisp: Mesh | null = null;
  private readonly smoke: Puff[] = [];
  private smokeMesh: InstancedMesh | null = null;
  private readonly chimneys: Vector3[] = [];
  private smokeAcc = 0;

  constructor(
    snow: SnowField,
    track: TrackSpec,
    obstacles: ObstacleGrid | null,
    decor: {
      houseA: LoadedProp | null;
      houseB: LoadedProp | null;
      marketHall: LoadedProp | null;
      watchtower: LoadedProp | null;
      palace: LoadedProp | null;
      cityGate: LoadedProp | null;
      frozenStatue: LoadedProp | null;
    },
    furniture: {
      lampPost: LoadedProp | null;
      bench: LoadedProp | null;
      marketStall?: LoadedProp | null;
      crate?: LoadedProp | null;
      barrel?: LoadedProp | null;
      banner?: LoadedProp | null;
      /** M9.2 : lampadaire orné dédié — repli lampadaire de quai. */
      cityLamp?: LoadedProp | null;
    } = { lampPost: null, bench: null },
    windowsAtlas: Texture | null = null,
  ) {
    const st = CITY.streets[0]!;
    const dirX = st.bx - st.ax;
    const dirZ = st.bz - st.az;
    const len = Math.hypot(dirX, dirZ);
    const ux = dirX / len;
    const uz = dirZ / len;
    const nx = -uz; // normale gauche de la rue
    const nz = ux;

    // ---- Maisons : 2 rangées le long de la rue + anneau autour de la place ----
    const housesA: Placement[] = [];
    const housesB: Placement[] = [];
    const pushHouse = (list: Placement[], prop: LoadedProp, x: number, z: number, yaw: number, s: number) => {
      list.push({ x, z, yaw, s, prop });
      const r = prop.radiusXZ * s * 0.62;
      this.buildingAnchors.push({ x, z, r });
      obstacles?.add({ x, z, r });
      // Cheminée + fenêtres dérivées de la même pose (cf. buildLights)
      this.chimneys.push(new Vector3(x, 0, z));
    };
    if (decor.houseA && decor.houseB) {
      let flip = false;
      for (const t of [3.5, 12.5, 21]) {
        for (const side of [-1, 1]) {
          const lat = side * (st.halfW + 4.6);
          const x = st.ax + ux * t + nx * lat;
          const z = st.az + uz * t + nz * lat;
          const yaw = Math.atan2(-nx * side, -nz * side); // face à la rue
          const prop = flip ? decor.houseB : decor.houseA;
          pushHouse(flip ? housesB : housesA, prop, x, z, yaw + (Math.sin(t * 7.3) * 0.1), 1);
          flip = !flip;
        }
      }
      // Anneau de la place (secteurs libres : la rue entre par l'Est)
      for (const ang of [2.6, 3.5, 4.4, 5.6]) {
        const x = CITY.plaza.x + Math.sin(ang) * (CITY.plaza.r + 4.5);
        const z = CITY.plaza.z + Math.cos(ang) * (CITY.plaza.r + 4.5);
        const yaw = Math.atan2(CITY.plaza.x - x, CITY.plaza.z - z); // face à la place
        const prop = ang > 4 ? decor.houseB : decor.houseA;
        pushHouse(ang > 4 ? housesB : housesA, prop, x, z, yaw, 1);
      }
      // Quartiers des ruelles secondaires (M6.2) : maisons en quinconce
      for (let si = 1; si < CITY.streets.length; si++) {
        const s2 = CITY.streets[si]!;
        const dx2 = s2.bx - s2.ax;
        const dz2 = s2.bz - s2.az;
        const len2 = Math.hypot(dx2, dz2);
        const ux2 = dx2 / len2;
        const uz2 = dz2 / len2;
        const nx2 = -uz2;
        const nz2 = ux2;
        for (const [t, side] of [[8, 1], [15, -1], [len2 - 4, 1]] as const) {
          const lat = side * (s2.halfW + 4.2);
          const x = s2.ax + ux2 * t + nx2 * lat;
          const z = s2.az + uz2 * t + nz2 * lat;
          if (Math.hypot(x - MESA.cx, z - MESA.cz) > MESA.rTop - 6) continue; // jamais au bord de la falaise
          const yaw = Math.atan2(-nx2 * side, -nz2 * side);
          const prop = (t + si) % 2 === 0 ? decor.houseA : decor.houseB;
          pushHouse(prop === decor.houseA ? housesA : housesB, prop!, x, z, yaw + Math.sin(t * 3.7) * 0.12, 1);
        }
      }
    }
    if (decor.houseA) this.group.add(instancedFrom(housesA, ToonMaterials.snowProp(decor.houseA.material.map ?? null), snow));
    if (decor.houseB) this.group.add(instancedFrom(housesB, ToonMaterials.snowProp(decor.houseB.material.map ?? null), snow));

    // ---- Uniques : halle, statue, palais, tours, porte ----
    const unique = (prop: LoadedProp | null, x: number, z: number, yaw: number, s = 1, obstacleR = 0.62): Mesh | null => {
      if (!prop) return null;
      const mesh = new Mesh(prop.geometry, ToonMaterials.snowProp(prop.material.map ?? null));
      mesh.position.set(x, footY(snow, x, z, prop.radiusXZ * s), z);
      mesh.rotation.y = yaw;
      mesh.scale.setScalar(s);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      this.group.add(mesh);
      const r = prop.radiusXZ * s * obstacleR;
      this.buildingAnchors.push({ x, z, r });
      obstacles?.add({ x, z, r });
      return mesh;
    };

    unique(decor.marketHall, CITY.plaza.x + 8.5, CITY.plaza.z + 9.5, Math.atan2(-8.5, -9.5));
    unique(decor.frozenStatue, CITY.plaza.x, CITY.plaza.z, 0.6, 1, 0.5);
    const pm = MESA.palaceMound;
    const palace = unique(decor.palace, pm.x, pm.z, Math.atan2(CITY.plaza.x - pm.x, CITY.plaza.z - pm.z), 1, 0.5);
    for (const ang of [2.9, 3.9, 5.0]) {
      const x = MESA.cx + Math.sin(ang) * (MESA.rTop - 3.5);
      const z = MESA.cz + Math.cos(ang) * (MESA.rTop - 3.5);
      unique(decor.watchtower, x, z, Math.atan2(MESA.cx - x, MESA.cz - z), 1, 0.5);
    }
    // Porte de ville : sertie sur l'axe du rail là où il franchit le rebord
    if (decor.cityGate) {
      const pose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
      let gateS = -1;
      for (let s = track.sCity; s > track.sCity - 120; s -= 1) {
        track.pose(s, pose);
        if (Math.hypot(pose.x - MESA.cx, pose.z - MESA.cz) > 53) {
          gateS = s;
          break;
        }
      }
      if (gateS > 0) {
        track.pose(gateS, pose);
        const mesh = new Mesh(decor.cityGate.geometry, ToonMaterials.snowProp(decor.cityGate.material.map ?? null));
        mesh.position.set(pose.x, pose.y - 0.15, pose.z);
        mesh.rotation.y = pose.yaw;
        mesh.castShadow = true;
        this.group.add(mesh);
        const lat = decor.cityGate.lengthX * 0.3;
        for (const side of [-1, 1]) {
          const ox = pose.x + Math.cos(pose.yaw) * -side * lat;
          const oz = pose.z + Math.sin(pose.yaw) * side * lat;
          obstacles?.add({ x: ox, z: oz, r: 1.6 });
        }
      }
    }

    // ---- Mobilier urbain (M6.2) : lampadaires, étals, caisses, tonneaux,
    // bannières, bancs, congères — la ville respire façon Genshin, 0 crédit ----
    let seed = 48271;
    const rng = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const wood = ToonMaterials.stationWood();
    const darkWood = ToonMaterials.railWood();
    const crimson = ToonMaterials.trainPanel();
    const lampCore = ToonMaterials.lantern('#ffca7a', CITY.lampIntensity);

    // Lampadaires (M9.2 : GLB Meshy orné dédié, repli lampadaire de quai puis
    // poteau procédural) — rues en côtés alternés + couronne de la place.
    // Chaque lampe dépose un halo de lumière chaude au sol (1 draw instancié).
    const lampProp = furniture.cityLamp ?? furniture.lampPost;
    // GLB ville : verre auto-émissif (la cage opaque cacherait un cœur box)
    const lampMat = furniture.cityLamp
      ? ToonMaterials.lampGlass(furniture.cityLamp.material.map ?? null)
      : lampProp?.material ?? null;
    const lampSpots: { x: number; y: number; z: number }[] = [];
    const placeLamp = (x: number, z: number, yaw: number): void => {
      const y = snow.getHeight(x, z);
      if (lampProp && lampMat) {
        const lp = new Mesh(lampProp.geometry, lampMat);
        lp.position.set(x, y - 0.04, z);
        lp.rotation.y = yaw;
        lp.castShadow = true;
        this.group.add(lp);
        if (!furniture.cityLamp) {
          // Lampadaire de quai : tête à claire-voie, le cœur box reste visible
          const core = new Mesh(new BoxGeometry(0.16, 0.22, 0.16), lampCore);
          core.position.set(x, y + lampProp.height * 0.82, z);
          this.group.add(core);
        }
      } else {
        const post = new Mesh(new BoxGeometry(0.14, 2.6, 0.14), wood);
        post.position.set(x, y + 1.3, z);
        this.group.add(post);
        const lamp = new Mesh(new BoxGeometry(0.3, 0.34, 0.3), lampCore);
        lamp.position.set(x, y + 2.7, z);
        this.group.add(lamp);
      }
      obstacles?.add({ x, z, r: 0.28 });
      lampSpots.push({ x, y, z });
    };
    for (const s2 of CITY.streets) {
      const len = Math.hypot(s2.bx - s2.ax, s2.bz - s2.az);
      const ux2 = (s2.bx - s2.ax) / len;
      const uz2 = (s2.bz - s2.az) / len;
      let side = 1;
      for (let t = CITY.lampEvery * 0.6; t < len; t += CITY.lampEvery) {
        const x = s2.ax + ux2 * t + -uz2 * side * (s2.halfW + 1.1);
        const z = s2.az + uz2 * t + ux2 * side * (s2.halfW + 1.1);
        side = -side;
        if (Math.hypot(x - CITY.plaza.x, z - CITY.plaza.z) < CITY.plaza.r) continue;
        // Bras tourné vers l'axe de la rue (la lanterne éclaire la chaussée)
        placeLamp(x, z, Math.atan2(uz2 * side, -ux2 * side));
      }
    }
    for (const ang of CITY.lampPool.plazaAngles) {
      const x = CITY.plaza.x + Math.sin(ang) * (CITY.plaza.r + 0.9);
      const z = CITY.plaza.z + Math.cos(ang) * (CITY.plaza.r + 0.9);
      placeLamp(x, z, Math.atan2(CITY.plaza.x - x, CITY.plaza.z - z));
    }
    if (lampSpots.length > 0) {
      const pools = new InstancedMesh(new CircleGeometry(1, 28), ToonMaterials.lightPool(), lampSpots.length);
      const pq = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
      for (let i = 0; i < lampSpots.length; i++) {
        const sp = lampSpots[i]!;
        _v.set(sp.x, sp.y + 0.07, sp.z);
        _m.compose(_v, pq, _s.set(CITY.lampPool.r, CITY.lampPool.r, 1));
        pools.setMatrixAt(i, _m);
      }
      pools.instanceMatrix.needsUpdate = true;
      pools.name = 'city-lamp-pools';
      this.group.add(pools);
    }

    // Étals de marché sur le pourtour de la place — GLB Meshy (M9.1),
    // repli codé main (poteaux + auvent + comptoir) si absent
    for (let i = 0; i < CITY.stallCount; i++) {
      const ang = 0.5 + i * 1.05;
      const x = CITY.plaza.x + Math.sin(ang) * (CITY.plaza.r - 2.2);
      const z = CITY.plaza.z + Math.cos(ang) * (CITY.plaza.r - 2.2);
      const y = snow.getHeight(x, z);
      const yaw = Math.atan2(CITY.plaza.x - x, CITY.plaza.z - z);
      if (furniture.marketStall) {
        const stall = new Mesh(furniture.marketStall.geometry, furniture.marketStall.material);
        stall.position.set(x, y - 0.03, z);
        stall.rotation.y = yaw;
        stall.castShadow = true;
        this.group.add(stall);
        obstacles?.add({ x, z, r: Math.min(1.4, furniture.marketStall.radiusXZ * 0.8) });
        continue;
      }
      const stall = new Group();
      for (const [ox, oz] of [[-1.05, -0.65], [1.05, -0.65], [-1.05, 0.65], [1.05, 0.65]] as const) {
        const post = new Mesh(new BoxGeometry(0.09, 2.1, 0.09), wood);
        post.position.set(ox, 1.05, oz);
        stall.add(post);
      }
      const roof = new Mesh(new BoxGeometry(2.5, 0.07, 1.75), crimson);
      roof.position.set(0, 2.16, 0);
      roof.rotation.x = 0.16;
      stall.add(roof);
      const counter = new Mesh(new BoxGeometry(2.2, 0.85, 0.8), darkWood);
      counter.position.set(0, 0.43, 0.35);
      stall.add(counter);
      const goods = new Mesh(new BoxGeometry(0.5, 0.3, 0.4), wood);
      goods.position.set(-0.5, 1.0, 0.35);
      goods.rotation.y = 0.4;
      stall.add(goods);
      stall.position.set(x, y, z);
      stall.rotation.y = yaw;
      stall.traverse((o) => {
        (o as Mesh).castShadow = true;
      });
      this.group.add(stall);
      obstacles?.add({ x, z, r: 1.25 });
    }

    // Caisses (empilées) et tonneaux, en grappes contre les bâtiments —
    // GLB Meshy (M9.1 : pile de caisses / tonneau), repli boîtes/cylindres
    const crateGeom = new BoxGeometry(0.55, 0.55, 0.55);
    const barrelGeom = new CylinderGeometry(0.3, 0.34, 0.74, 10);
    for (let i = 0; i < CITY.crateCount + CITY.barrelCount; i++) {
      const anchor = this.buildingAnchors[Math.floor(rng() * this.buildingAnchors.length)];
      if (!anchor) break;
      const ang = rng() * Math.PI * 2;
      const d = anchor.r + 0.7 + rng() * 1.6;
      const x = anchor.x + Math.sin(ang) * d;
      const z = anchor.z + Math.cos(ang) * d;
      if (Math.hypot(x - MESA.cx, z - MESA.cz) > MESA.rTop - 4) continue;
      const y = snow.getHeight(x, z);
      if (i < CITY.crateCount) {
        if (furniture.crate) {
          const stack = new Mesh(furniture.crate.geometry, furniture.crate.material);
          stack.position.set(x, y - 0.02, z);
          stack.rotation.y = rng() * Math.PI * 2;
          // Variation d'échelle : une pile identique répétée lit comme un motif
          stack.scale.setScalar(0.82 + rng() * 0.3);
          stack.castShadow = true;
          this.group.add(stack);
          continue;
        }
        const crate = new Mesh(crateGeom, wood);
        crate.position.set(x, y + 0.26, z);
        crate.rotation.y = rng() * Math.PI;
        crate.castShadow = true;
        this.group.add(crate);
        if (rng() < 0.4) {
          const top = new Mesh(crateGeom, darkWood);
          top.scale.setScalar(0.82);
          top.position.set(x + 0.07, y + 0.75, z - 0.05);
          top.rotation.y = rng() * Math.PI;
          top.castShadow = true;
          this.group.add(top);
        }
      } else if (furniture.barrel) {
        const barrel = new Mesh(furniture.barrel.geometry, furniture.barrel.material);
        barrel.position.set(x, y - 0.02, z);
        barrel.rotation.y = rng() * Math.PI * 2;
        barrel.scale.setScalar(0.88 + rng() * 0.24);
        barrel.castShadow = true;
        this.group.add(barrel);
      } else {
        const barrel = new Mesh(barrelGeom, darkWood);
        barrel.position.set(x, y + 0.36, z);
        barrel.castShadow = true;
        this.group.add(barrel);
      }
    }

    // Bannières cramoisies (identité Genshin) : mât + potence + étendard
    const bannerGeom = new BoxGeometry(0.5, 1.15, 0.03);
    for (let i = 0; i < CITY.bannerCount; i++) {
      const onPlaza = i < 4;
      const ang = onPlaza ? 0.9 + i * 1.5 : 0;
      const t = 4 + (i - 4) * 8;
      const x = onPlaza
        ? CITY.plaza.x + Math.sin(ang) * (CITY.plaza.r + 1.2)
        : st.ax + ((st.bx - st.ax) / Math.hypot(st.bx - st.ax, st.bz - st.az)) * t + 0.6;
      const z = onPlaza
        ? CITY.plaza.z + Math.cos(ang) * (CITY.plaza.r + 1.2)
        : st.az + ((st.bz - st.az) / Math.hypot(st.bx - st.ax, st.bz - st.az)) * t - (st.halfW + 0.9);
      const y = snow.getHeight(x, z);
      if (furniture.banner) {
        // GLB Meshy (M9.1) : mât + potence + étendard d'un seul tenant
        const b = new Mesh(furniture.banner.geometry, furniture.banner.material);
        b.position.set(x, y - 0.02, z);
        b.rotation.y = rng() * Math.PI * 2;
        b.castShadow = true;
        this.group.add(b);
        obstacles?.add({ x, z, r: 0.22 });
        continue;
      }
      const pole = new Mesh(new BoxGeometry(0.09, 3.6, 0.09), darkWood);
      pole.position.set(x, y + 1.8, z);
      pole.castShadow = true;
      this.group.add(pole);
      const arm = new Mesh(new BoxGeometry(0.7, 0.06, 0.06), darkWood);
      arm.position.set(x + 0.3, y + 3.45, z);
      this.group.add(arm);
      const banner = new Mesh(bannerGeom, crimson);
      banner.position.set(x + 0.52, y + 2.85, z);
      banner.rotation.y = rng() * 0.5 - 0.25;
      this.group.add(banner);
      obstacles?.add({ x, z, r: 0.22 });
    }

    // Bancs (GLB banquette du train) autour de la statue de la place
    if (furniture.bench) {
      for (let i = 0; i < CITY.benchCount; i++) {
        const ang = (i / CITY.benchCount) * Math.PI * 2 + 0.5;
        const x = CITY.plaza.x + Math.sin(ang) * 3.6;
        const z = CITY.plaza.z + Math.cos(ang) * 3.6;
        const bench = new Mesh(furniture.bench.geometry, furniture.bench.material);
        bench.position.set(x, snow.getHeight(x, z), z);
        bench.rotation.y = ang + Math.PI / 2;
        bench.castShadow = true;
        this.group.add(bench);
        obstacles?.add({ x, z, r: 0.55 });
      }
    }

    // Congères contre les murs (demi-sphères écrasées, blanc neige)
    const driftMat = ToonMaterials.snowProp(null);
    for (let i = 0; i < CITY.driftCount; i++) {
      const anchor = this.buildingAnchors[Math.floor(rng() * this.buildingAnchors.length)];
      if (!anchor) break;
      const ang = rng() * Math.PI * 2;
      const x = anchor.x + Math.sin(ang) * (anchor.r + 0.4);
      const z = anchor.z + Math.cos(ang) * (anchor.r + 0.4);
      const drift = new Mesh(new SphereGeometry(0.7 + rng() * 0.7, 10, 8), driftMat);
      drift.scale.y = 0.32;
      drift.position.set(x, snow.getHeight(x, z) + 0.05, z);
      this.group.add(drift);
    }

    // ---- Fenêtres chaudes (M9.2) : atlas Magnific plaqué sur la VRAIE façade.
    // Le plan de mur est MESURÉ sur les sommets du GLB à hauteur de fenêtre
    // (le radiusXZ embarque le débord de toit : les quads flottaient devant les
    // murs). Allumage aléatoire déterministe par fenêtre — les éteintes
    // n'existent simplement pas. ----
    const lights: Matrix4[] = [];
    const lm = new Matrix4();
    const lq = new Quaternion();
    const ls = new Vector3(1, 1, 1);
    const up = new Vector3(0, 1, 0);
    const extCache = new Map<LoadedProp, { hx: number; hz: number }>();
    const winHash = (a: number, b: number): number => {
      const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
      return s - Math.floor(s);
    };
    for (const p of [...housesA, ...housesB]) {
      let ext = extCache.get(p.prop);
      if (!ext) {
        ext = wallExtents(p.prop);
        extCache.set(p.prop, ext);
      }
      const baseY = footY(snow, p.x, p.z, p.prop.radiusXZ * p.s);
      const h = p.prop.height * p.s;
      let wi = 0;
      for (const face of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const onZ = face === 0 || face === Math.PI; // face ±Z locale
        const half = (onZ ? ext.hx : ext.hz) * p.s; // demi-LARGEUR du mur
        const dist = (onZ ? ext.hz : ext.hx) * p.s + CITY.windows.gap;
        const offsets = half >= CITY.windows.twoAbove ? [-half * 0.45, half * 0.45] : [0];
        for (const rowFrac of CITY.windows.rowFracs) {
          for (const ox of offsets) {
            wi++;
            if (winHash(p.x * 3.1 + wi, p.z * 1.7 + face) > CITY.windows.litChance) continue;
            // Repère local du mur : normale n=(sin f, cos f), tangente (cos f, −sin f)
            const lx = Math.sin(face) * dist + Math.cos(face) * ox;
            const lz = Math.cos(face) * dist - Math.sin(face) * ox;
            const wx = p.x + lx * Math.cos(p.yaw) + lz * Math.sin(p.yaw);
            const wz = p.z - lx * Math.sin(p.yaw) + lz * Math.cos(p.yaw);
            lq.setFromAxisAngle(up, p.yaw + face);
            const sc = 0.92 + winHash(wi * 2.3, p.x + p.z) * 0.18;
            _v.set(wx, baseY + h * rowFrac, wz);
            lm.compose(_v, lq, ls.set(sc, sc, 1));
            lights.push(lm.clone());
          }
        }
      }
    }
    if (lights.length > 0) {
      const winMat = windowsAtlas
        ? ToonMaterials.cityWindow(windowsAtlas)
        : ToonMaterials.lantern(TRAIN.windowColor, 1.8);
      const windows = new InstancedMesh(
        new PlaneGeometry(CITY.windows.w, CITY.windows.h),
        winMat,
        lights.length,
      );
      for (let i = 0; i < lights.length; i++) windows.setMatrixAt(i, lights[i]!);
      windows.instanceMatrix.needsUpdate = true;
      windows.name = 'city-windows';
      this.group.add(windows);
    }

    // ---- Flèches du palais : cœurs émissifs bleu-glace + VOLUTE magique ----
    if (palace && decor.palace) {
      const topY = palace.position.y + decor.palace.height;
      const spireMat = ToonMaterials.lantern('#bfe8ff', 2.2);
      for (const [ox, oy, oz, sz] of [
        [0, -0.04, 0, 0.5],
        [decor.palace.radiusXZ * 0.34, -0.16, decor.palace.radiusXZ * 0.2, 0.34],
        [-decor.palace.radiusXZ * 0.3, -0.14, -decor.palace.radiusXZ * 0.24, 0.34],
      ] as const) {
        const core = new Mesh(new SphereGeometry(sz, 10, 8), spireMat);
        core.position.set(palace.position.x + ox, topY + decor.palace.height * oy, palace.position.z + oz);
        this.group.add(core);
      }
      // Volute : cylindre ouvert additif, bandes de bruit qui montent (réf 1)
      const wispMat = new MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        fog: false,
      });
      const wuv = uv();
      const bands = mx_noise_float(vec2(wuv.x.mul(5.2), wuv.y.mul(3.0).sub(time.mul(0.45)))).mul(0.5).add(0.5);
      const taper = smoothstep(0.0, 0.25, wuv.y).mul(smoothstep(0.75, 1.0, wuv.y).oneMinus());
      wispMat.colorNode = mix(color('#bfe8ff'), color('#7fe8d8'), wuv.y).mul(1.9);
      wispMat.opacityNode = bands.mul(bands).mul(taper).mul(0.5);
      const wisp = new Mesh(new CylinderGeometry(1.6, 0.35, 9, 12, 1, true), wispMat);
      wisp.position.set(palace.position.x, topY + 4.2, palace.position.z);
      this.group.add(wisp);
      this.wisp = wisp;
    }

    // ---- Cheminées fumantes : pool CPU de boules toon (patron du train) ----
    if (this.chimneys.length > 0) {
      const mesh = new InstancedMesh(new SphereGeometry(1, 10, 8), ToonMaterials.smokePuff(), SMOKE.count);
      for (let i = 0; i < SMOKE.count; i++) {
        this.smoke.push({ x: 0, y: 0, z: 0, age: 0, live: false });
        mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = 'city-smoke';
      this.group.add(mesh);
      this.smokeMesh = mesh;
      // Hauteur de sortie des cheminées (approx toit)
      for (const c of this.chimneys) c.y = snow.getHeight(c.x, c.z) + 5.6;
    }

    // La ville est loin du frustum de boot : tout doit compiler au warmup
    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  update(dt: number): void {
    if (this.wisp) this.wisp.rotation.y += dt * 0.35;
    const mesh = this.smokeMesh;
    if (!mesh || this.chimneys.length === 0) return;
    this.smokeAcc += dt;
    if (this.smokeAcc >= SMOKE.rate) {
      this.smokeAcc = 0;
      const p = this.smoke.find((sp) => !sp.live);
      if (p) {
        const c = this.chimneys[Math.floor(Math.random() * this.chimneys.length)]!;
        p.x = c.x + (Math.random() - 0.5) * 0.4;
        p.y = c.y;
        p.z = c.z + (Math.random() - 0.5) * 0.4;
        p.age = 0;
        p.live = true;
      }
    }
    for (let i = 0; i < this.smoke.length; i++) {
      const p = this.smoke[i]!;
      if (!p.live) {
        mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      p.age += dt;
      if (p.age >= SMOKE.life) {
        p.live = false;
        mesh.setMatrixAt(i, _m.makeScale(0, 0, 0));
        continue;
      }
      const t = p.age / SMOKE.life;
      p.y += SMOKE.rise * dt;
      p.x += SMOKE.drift * dt;
      const grow = Math.min(t / 0.7, 1);
      const shrink = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
      const size = (SMOKE.size0 + (SMOKE.size1 - SMOKE.size0) * grow) * shrink;
      _v.set(p.x, p.y, p.z);
      _m.compose(_v, _qi, _s.set(size, size, size));
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Assise d'un bâtiment : MINIMUM du sol sous l'emprise (centre + 4 points du
 * pourtour) − 0,1 m. Poser sur la hauteur du CENTRE laissait le côté aval
 * flotter sur le micro-relief du plateau (retour utilisateur).
 */
/**
 * Plan de façade MESURÉ (M9.2) : demi-étendues X/Z des murs au niveau des
 * fenêtres, lues sur les sommets du GLB normalisé (bande y ∈ [0.18h, 0.52h] —
 * sous le débord de toit). Percentile 92 : une cheminée ou une enseigne qui
 * dépasse ne repousse pas le mur. Repli radiusXZ*0.7 si la bande est vide.
 */
function wallExtents(prop: LoadedProp): { hx: number; hz: number } {
  const pos = prop.geometry.getAttribute('position');
  const y0 = prop.height * 0.18;
  const y1 = prop.height * 0.52;
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    if (y < y0 || y > y1) continue;
    xs.push(Math.abs(pos.getX(i)));
    zs.push(Math.abs(pos.getZ(i)));
  }
  if (xs.length < 16) return { hx: prop.radiusXZ * 0.7, hz: prop.radiusXZ * 0.7 };
  xs.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const q = (arr: number[]): number => arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.92))]!;
  return { hx: q(xs), hz: q(zs) };
}

function footY(snow: SnowField, x: number, z: number, r: number): number {
  const rr = Math.max(r * 0.7, 0.5);
  let y = snow.getHeight(x, z);
  y = Math.min(y, snow.getHeight(x + rr, z));
  y = Math.min(y, snow.getHeight(x - rr, z));
  y = Math.min(y, snow.getHeight(x, z + rr));
  y = Math.min(y, snow.getHeight(x, z - rr));
  return y - 0.1;
}

/** InstancedMesh depuis une liste de placements (pieds posés sur le sol neige). */
function instancedFrom(list: Placement[], material: LoadedProp['material'], snow: SnowField): InstancedMesh {
  const first = list[0];
  const mesh = new InstancedMesh(first ? first.prop.geometry : new BoxGeometry(1, 1, 1), material, Math.max(list.length, 1));
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    q.setFromAxisAngle(up, p.yaw);
    _v.set(p.x, footY(snow, p.x, p.z, p.prop.radiusXZ * p.s), p.z);
    _m.compose(_v, q, _s.set(p.s, p.s, p.s));
    mesh.setMatrixAt(i, _m);
  }
  mesh.count = list.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.name = 'city-houses';
  return mesh;
}

/** Camp Fatui de la toundra : brasero géant + lueur de falaise (réf 2). */
export function buildFatuiCamp(snow: SnowField, obstacles: ObstacleGrid | null, brazier: LoadedProp | null): Group {
  const group = new Group();
  if (brazier) {
    const mesh = new Mesh(brazier.geometry, ToonMaterials.snowProp(brazier.material.map ?? null));
    const y = snow.getHeight(FATUI.brazier.x, FATUI.brazier.z);
    mesh.position.set(FATUI.brazier.x, y - 0.06, FATUI.brazier.z);
    mesh.scale.setScalar(2.1);
    mesh.castShadow = true;
    group.add(mesh);
    obstacles?.add({ x: FATUI.brazier.x, z: FATUI.brazier.z, r: brazier.radiusXZ * 2.1 * 0.7 });
    // Vrai feu animé dans la vasque (M10) : toujours actif, braises comprises —
    // piloté par le nœud time TSL, aucun update CPU nécessaire
    const fire = new FireVfx(FIRE.giantScale, true);
    fire.group.position.set(FATUI.brazier.x, y + brazier.height * 2.1 * FIRE.bowlFrac, FATUI.brazier.z);
    group.add(fire.group);
  }
  // Lueur orange sur la falaise (perce le blizzard — fog:false du lantern)
  const glow = new Mesh(new SphereGeometry(1.5, 10, 8), ToonMaterials.lantern(FATUI.glowColor, FATUI.glowIntensity));
  glow.position.set(FATUI.cliffGlow.x, FATUI.cliffGlow.y, FATUI.cliffGlow.z);
  group.add(glow);
  group.traverse((o) => {
    o.frustumCulled = false;
  });
  return group;
}

const _m = new Matrix4();
const _v = new Vector3();
const _s = new Vector3(1, 1, 1);
const _qi = new Quaternion();
