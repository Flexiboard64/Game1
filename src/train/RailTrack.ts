import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from 'three/webgpu';
import { CITY, RAIL, SNOW } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import type { LoadedProp } from '../assets/PropLoader';
import type { TrackSpec, TrackPose } from '../world/TrackSpec';
import type { HeightField } from '../world/HeightField';
import type { ObstacleGrid } from '../world/Obstacles';

/** GLB Meshy du décor ferroviaire (M5.1) — null → repli procédural. */
export interface RailDecorProps {
  lampPost: LoadedProp | null;
  wallLantern: LoadedProp | null;
  stationShelter: LoadedProp | null;
}

// Infrastructure de la voie (M5), 100 % procédurale : rails + traverses
// instanciés le long de la table s→pose, tablier de pont au-dessus de la
// rivière, TUBE de tunnel enterré sous le rempart (boîte sombre BackSide — la
// forme d'arche est donnée par les portails de pierre qui encadrent les
// bouches), lanternes intérieures qui défilent aux fenêtres, deux gares.

export class RailTrack {
  readonly group = new Group();
  /** Centre du quai de chaque gare (côté calculé) — porte du wagon, prompt F. */
  readonly platformCenters: { valley: Vector3; snow: Vector3; city: Vector3 } = {
    valley: new Vector3(),
    snow: new Vector3(),
    city: new Vector3(),
  };

  constructor(
    private readonly track: TrackSpec,
    ground: HeightField,
    obstacles: ObstacleGrid | null,
    private readonly decor: RailDecorProps = { lampPost: null, wallLantern: null, stationShelter: null },
    snowHeightAt: ((x: number, z: number) => number) | null = null,
  ) {
    this.buildRails();
    this.buildSleepers();
    this.buildBridge(ground);
    this.buildTube();
    this.buildViaduct(snowHeightAt, obstacles);
    this.buildPortals(obstacles);
    this.buildStation(track.sValley, obstacles, this.platformCenters.valley, new Vector3(0, 0, 0));
    this.buildStation(track.sSnow, obstacles, this.platformCenters.snow, new Vector3(SNOW.center.x, 0, SNOW.center.z));
    this.buildStation(track.sCity, obstacles, this.platformCenters.city, new Vector3(CITY.plaza.x, 0, CITY.plaza.z));
    this.buildBuffers(obstacles);
    // Tout est loin/étroit : le culling par bounding sphere ne gagnerait rien et
    // le tube DOIT compiler au warmup (piège Waterfall)
    this.group.traverse((o) => {
      o.frustumCulled = false;
    });
  }

  // ---- Helpers ----

  /** right = tangente × up (côté droit en regardant vers +s). */
  private static right(pose: TrackPose, out: Vector3): Vector3 {
    return out.set(-Math.cos(pose.yaw), 0, Math.sin(pose.yaw));
  }

  private static poseQuat(pose: TrackPose, out: Quaternion): Quaternion {
    _e1.set(0, 1, 0);
    out.setFromAxisAngle(_e1, pose.yaw);
    _e1.set(1, 0, 0);
    _q2.setFromAxisAngle(_e1, -pose.pitch);
    return out.multiply(_q2);
  }

  // ---- Rails : boîtes instanciées orientées, chevauchement léger ----

  private buildRails(): void {
    const step = RAIL.railStep;
    const n = Math.floor(this.track.length / step);
    const mesh = new InstancedMesh(
      new BoxGeometry(RAIL.railW, RAIL.railH, step * 1.06),
      ToonMaterials.railSteel(),
      n * 2,
    );
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * step;
      this.track.pose(s, _pose);
      RailTrack.right(_pose, _right);
      RailTrack.poseQuat(_pose, _q);
      for (const side of [-1, 1]) {
        _p.set(_pose.x, _pose.y + RAIL.sleeper.h + RAIL.railH / 2, _pose.z)
          .addScaledVector(_right, (side * RAIL.gauge) / 2);
        _m.compose(_p, _q, _one);
        mesh.setMatrixAt(idx++, _m);
      }
    }
    mesh.count = idx;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = 'rail-rails';
    this.group.add(mesh);
  }

  private buildSleepers(): void {
    const n = Math.floor(this.track.length / RAIL.sleeperEvery);
    const mesh = new InstancedMesh(
      new BoxGeometry(RAIL.sleeper.w, RAIL.sleeper.h, RAIL.sleeper.d),
      ToonMaterials.railWood(),
      n,
    );
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) * RAIL.sleeperEvery;
      this.track.pose(s, _pose);
      RailTrack.poseQuat(_pose, _q);
      _p.set(_pose.x, _pose.y + RAIL.sleeper.h / 2, _pose.z);
      _m.compose(_p, _q, _one);
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = 'rail-sleepers';
    this.group.add(mesh);
  }

  // ---- Pont : tablier + poutres là où la voie survole la rivière ----

  private buildBridge(ground: HeightField): void {
    // Plage s du franchissement : |lowerSdf| < seuil autour de l'axe
    let sStart = -1;
    let sEnd = -1;
    for (let s = 0; s < this.track.sPortal; s += 1) {
      this.track.pose(s, _pose);
      const over = Math.abs(ground.getLowerSdf(_pose.x, _pose.z)) < RAIL.bridgeWaterSdfHi;
      if (over && sStart < 0) sStart = s;
      if (over) sEnd = s;
    }
    if (sStart < 0) return;
    sStart -= RAIL.bridgeMargin;
    sEnd += RAIL.bridgeMargin;

    const step = 2;
    const count = Math.ceil((sEnd - sStart) / step);
    const deck = new InstancedMesh(
      new BoxGeometry(RAIL.bridgeDeckW, RAIL.bridgeDeckThick, step * 1.05),
      ToonMaterials.railWood(),
      count * 3, // tablier + 2 garde-corps bas
    );
    let idx = 0;
    for (let i = 0; i < count; i++) {
      const s = sStart + (i + 0.5) * step;
      this.track.pose(s, _pose);
      RailTrack.right(_pose, _right);
      RailTrack.poseQuat(_pose, _q);
      // Tablier sous les traverses
      _p.set(_pose.x, _pose.y - RAIL.bridgeDeckThick / 2 + 0.02, _pose.z);
      _m.compose(_p, _q, _one);
      deck.setMatrixAt(idx++, _m);
      // Garde-corps (simples lisses basses)
      for (const side of [-1, 1]) {
        _p.set(_pose.x, _pose.y + 0.55, _pose.z)
          .addScaledVector(_right, side * (RAIL.bridgeDeckW / 2 - 0.08));
        _scale.set(0.06, 3.2, 1);
        _m.compose(_p, _q, _scale);
        deck.setMatrixAt(idx++, _m);
      }
    }
    deck.count = idx;
    deck.instanceMatrix.needsUpdate = true;
    deck.castShadow = true;
    deck.receiveShadow = true;
    deck.name = 'rail-bridge';
    this.group.add(deck);
  }

  // ---- Tube du tunnel : boîte sombre BackSide + lanternes ----

  private buildTube(): void {
    // Le tube démarre DERRIÈRE la façade et finit avant celle côté neige (une
    // dalle qui dépasse du portail lisait comme un bloc gris posé dans l'herbe)
    const s0 = this.track.sPortal + 0.5;
    const s1 = this.track.sTubeExit - 0.5;
    const step = 4;
    const count = Math.ceil((s1 - s0) / step);
    // Murs À L'INTÉRIEUR de la tranchée du heightfield (±3,4 m) : sinon les
    // parois de terrain étirées passent devant la maçonnerie
    const halfW = 3.3;
    const height = RAIL.tubeRadius + RAIL.tubeWallDrop;
    // 4 DALLES par segment (murs, plafond, plancher) — jamais de face en
    // travers de l'alésage (un caisson fermé coupait le tunnel en murs noirs).
    // Murs/plafond en maçonnerie lisible, plancher ballast sombre
    const wallMat = ToonMaterials.tunnelWall();
    const wallGeom = new BoxGeometry(0.25, height, step * 1.2);
    const ceilGeom = new BoxGeometry(halfW * 2 + 0.5, 0.25, step * 1.2);
    const floorGeom = new BoxGeometry(halfW * 2 + 0.5, 0.25, step * 1.2);
    const inner = new InstancedMesh(wallGeom, wallMat, count * 2);
    const ceils = new InstancedMesh(ceilGeom, wallMat, count);
    const floors = new InstancedMesh(floorGeom, ToonMaterials.tunnelFloor(), count);
    let wi = 0;
    for (let i = 0; i < count; i++) {
      const s = s0 + (i + 0.5) * step;
      this.track.pose(s, _pose);
      RailTrack.right(_pose, _right);
      RailTrack.poseQuat(_pose, _q);
      const midY = _pose.y + height / 2 - 0.4;
      for (const side of [-1, 1]) {
        _p.set(_pose.x, midY, _pose.z).addScaledVector(_right, side * halfW);
        _m.compose(_p, _q, _one);
        inner.setMatrixAt(wi++, _m);
      }
      _p.set(_pose.x, _pose.y + height - 0.4, _pose.z); // plafond
      _m.compose(_p, _q, _one);
      ceils.setMatrixAt(i, _m);
      _p.set(_pose.x, _pose.y - 0.45, _pose.z); // plancher (sous les traverses)
      _m.compose(_p, _q, _one);
      floors.setMatrixAt(i, _m);
    }
    for (const mesh of [inner, ceils, floors]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = 'rail-tube';
      this.group.add(mesh);
    }

    // Cintres de soutènement en bois (façon galerie de mine) : deux poteaux +
    // linteau tous les lampEvery, décalés d'une demi-période avec les lanternes —
    // c'est L'HABILLAGE du tunnel, ce qui défile aux fenêtres avec les lampes
    const ribEvery = RAIL.lampEvery;
    const nRibs = Math.floor((s1 - s0) / ribEvery);
    const ribWood = ToonMaterials.stationWood(); // bois CLAIR : lisible sur la maçonnerie
    const postGeom = new BoxGeometry(0.4, height - 1.2, 0.4);
    const lintelGeom = new BoxGeometry(halfW * 2 - 0.3, 0.42, 0.4);
    const posts = new InstancedMesh(postGeom, ribWood, nRibs * 2);
    const lintels = new InstancedMesh(lintelGeom, ribWood, nRibs);
    for (let i = 0; i < nRibs; i++) {
      const s = s0 + (i + 0.5) * ribEvery;
      this.track.pose(s, _pose);
      RailTrack.right(_pose, _right);
      RailTrack.poseQuat(_pose, _q);
      for (const side of [-1, 1]) {
        _p.set(_pose.x, _pose.y + (height - 1.2) / 2 - 0.3, _pose.z)
          .addScaledVector(_right, side * (halfW - 0.35));
        _m.compose(_p, _q, _one);
        posts.setMatrixAt(i * 2 + (side > 0 ? 1 : 0), _m);
      }
      _p.set(_pose.x, _pose.y + height - 1.15, _pose.z);
      _m.compose(_p, _q, _one);
      lintels.setMatrixAt(i, _m);
    }
    for (const mesh of [posts, lintels]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = 'rail-tube-ribs';
      this.group.add(mesh);
    }

    // Lanternes murales alternées — GLB Meshy (bras en bois + cage laiton) avec
    // cœur émissif instancié, boxes émissives sinon
    const nLamps = Math.floor((s1 - s0) / RAIL.lampEvery);
    const coreMat = ToonMaterials.lantern(RAIL.lampColor, RAIL.lampIntensity);
    const wl = this.decor.wallLantern;
    const bodies = wl
      ? new InstancedMesh(wl.geometry, wl.material, nLamps)
      : new InstancedMesh(new BoxGeometry(0.3, 0.44, 0.3), coreMat, nLamps);
    const cores = wl ? new InstancedMesh(new BoxGeometry(0.14, 0.2, 0.14), coreMat, nLamps) : null;
    for (let i = 0; i < nLamps; i++) {
      const s = s0 + i * RAIL.lampEvery; // décalées d'une demi-période vs cintres
      this.track.pose(s, _pose);
      RailTrack.right(_pose, _right);
      const side = i % 2 === 0 ? 1 : -1;
      _p.set(_pose.x, _pose.y + 2.4, _pose.z).addScaledVector(_right, side * (halfW - 0.45));
      // Bras contre la paroi : la lanterne pend vers l'intérieur du tunnel
      _e1.set(0, 1, 0);
      _q.setFromAxisAngle(_e1, _pose.yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2));
      _m.compose(_p, _q, _one);
      bodies.setMatrixAt(i, _m);
      if (cores && wl) {
        _p.y -= wl.height * 0.12;
        _m.compose(_p, _q, _one);
        cores.setMatrixAt(i, _m);
      }
    }
    bodies.instanceMatrix.needsUpdate = true;
    bodies.name = 'rail-tube-lamps';
    this.group.add(bodies);
    if (cores) {
      cores.instanceMatrix.needsUpdate = true;
      cores.name = 'rail-tube-lamps';
      this.group.add(cores);
    }
  }

  // ---- Viaduc de Snezhnograd (M6) : là où la voie décolle du sol neige,
  // tablier de pierre + parapets ; piles massives tous les pileEvery ; arches
  // elliptiques en éventail de boxes entre piles hautes (silhouette réf 1).

  private buildViaduct(snowHeightAt: ((x: number, z: number) => number) | null, obstacles: ObstacleGrid | null): void {
    if (!snowHeightAt) return;
    const stone = ToonMaterials.masonry();
    const s0 = this.track.sTubeExit + 2;
    const s1 = this.track.length - 1;

    // 1) Tablier + parapets (pas de 2 m, dès 25 cm de jour — couvre aussi la
    // bande de transition remblai→viaduc créée par la garde de remblai)
    const step = 2;
    const segs: { s: number; gap: number }[] = [];
    for (let s = s0; s <= s1; s += step) {
      this.track.pose(s, _pose);
      const gap = _pose.y - snowHeightAt(_pose.x, _pose.z);
      if (gap > 0.25) segs.push({ s, gap });
    }
    if (segs.length === 0) return;
    const deck = new InstancedMesh(new BoxGeometry(3.2, 0.55, step * 1.1), stone, segs.length);
    const parapet = new InstancedMesh(new BoxGeometry(0.28, 0.9, step * 1.1), stone, segs.length * 2);
    let di = 0;
    let pi = 0;
    for (const seg of segs) {
      this.track.pose(seg.s, _pose);
      RailTrack.right(_pose, _right);
      RailTrack.poseQuat(_pose, _q);
      _p.set(_pose.x, _pose.y - 0.28, _pose.z);
      _m.compose(_p, _q, _one);
      deck.setMatrixAt(di++, _m);
      if (seg.gap > 1.2) {
        for (const side of [-1, 1]) {
          _p.set(_pose.x, _pose.y + 0.42, _pose.z).addScaledVector(_right, side * 1.55);
          _m.compose(_p, _q, _one);
          parapet.setMatrixAt(pi++, _m);
        }
      }
    }
    deck.count = di;
    parapet.count = pi;
    for (const mesh of [deck, parapet]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'rail-viaduct';
      this.group.add(mesh);
    }

    // 2) Piles massives + chapiteaux (boxes unitaires scalées en hauteur)
    const pileEvery = 11;
    const piles: { s: number; gap: number; y: number }[] = [];
    for (let s = s0 + 4; s <= s1 - 3; s += pileEvery) {
      this.track.pose(s, _pose);
      const gap = _pose.y - snowHeightAt(_pose.x, _pose.z);
      if (gap > 2.0) piles.push({ s, gap, y: _pose.y });
    }
    if (piles.length > 0) {
      const shafts = new InstancedMesh(new BoxGeometry(1.7, 1, 1.7), stone, piles.length);
      const caps = new InstancedMesh(new BoxGeometry(2.7, 0.6, 2.7), stone, piles.length);
      for (let i = 0; i < piles.length; i++) {
        const pile = piles[i]!;
        this.track.pose(pile.s, _pose);
        RailTrack.poseQuat(_pose, _q);
        const h = pile.gap + 0.6; // ancrée sous le sol (talus/écran de discrétisation)
        _p.set(_pose.x, _pose.y - 0.55 - h / 2, _pose.z);
        _m.compose(_p, _q, _scale.set(1, h, 1));
        shafts.setMatrixAt(i, _m);
        _p.set(_pose.x, _pose.y - 0.85, _pose.z);
        _m.compose(_p, _q, _one);
        caps.setMatrixAt(i, _m);
        obstacles?.add({ x: _pose.x, z: _pose.z, r: 1.2 });
      }
      for (const mesh of [shafts, caps]) {
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = 'rail-viaduct-piles';
        this.group.add(mesh);
      }

      // 3) Arches elliptiques entre piles hautes consécutives (7 voussoirs/travée)
      const VOUSSOIRS = 7;
      const arcs: Matrix4[] = [];
      for (let i = 1; i < piles.length; i++) {
        const a = piles[i - 1]!;
        const b = piles[i]!;
        if (b.s - a.s > pileEvery + 0.5) continue; // travée interrompue (gap < 2 entre les deux)
        if (Math.min(a.gap, b.gap) < 3.2) continue;
        const halfSpan = (b.s - a.s) / 2 - 0.9;
        const rV = Math.min(4.6, Math.min(a.gap, b.gap) * 0.5);
        const sMid = (a.s + b.s) / 2;
        this.track.pose(sMid, _pose);
        RailTrack.right(_pose, _right);
        const crownY = _pose.y - 1.15;
        const fwdX = Math.sin(_pose.yaw);
        const fwdZ = Math.cos(_pose.yaw);
        for (let v = 0; v < VOUSSOIRS; v++) {
          const th = (Math.PI * (14 + (152 * v) / (VOUSSOIRS - 1))) / 180;
          const along = Math.cos(th) * halfSpan;
          const y = crownY - rV + Math.sin(th) * rV;
          _p.set(_pose.x + fwdX * along, y, _pose.z + fwdZ * along);
          _e1.set(0, 1, 0);
          _q.setFromAxisAngle(_e1, _pose.yaw);
          _q2.setFromAxisAngle(_e1.set(1, 0, 0), Math.PI / 2 - th);
          _q.multiply(_q2);
          _m.compose(_p, _q, _scale.set(1, 1, 1));
          arcs.push(_m.clone());
        }
      }
      if (arcs.length > 0) {
        // Dimension LE LONG DE L'ARC = Z (1,9 ≈ le pas entre voussoirs : anneau continu)
        const ring = new InstancedMesh(new BoxGeometry(1.4, 1.2, 1.9), stone, arcs.length);
        for (let i = 0; i < arcs.length; i++) ring.setMatrixAt(i, arcs[i]!);
        ring.instanceMatrix.needsUpdate = true;
        ring.castShadow = true;
        ring.name = 'rail-viaduct-arches';
        this.group.add(ring);
      }
    }
  }

  // ---- Portails : VRAIE entrée de tunnel — façade de maçonnerie percée d'une
  // bouche sombre (arche de voussoirs), murs en aile, parapet. Le « trou dans
  // la montagne » doit se lire depuis le spawn, et le train doit visiblement
  // ENTRER dedans (pas traverser le flanc de colline).

  private buildPortals(obstacles: ObstacleGrid | null): void {
    const stone = ToonMaterials.masonry();
    for (const s of [this.track.sPortal, this.track.sTubeExit]) {
      this.track.pose(s, _pose);
      RailTrack.right(_pose, _right);
      const portal = new Group();
      const yawQ = _q.setFromAxisAngle(_e1.set(0, 1, 0), _pose.yaw).clone();
      const place = (mesh: Mesh, lat: number, up: number, fwd: number): Mesh => {
        _p.set(_pose.x, _pose.y + up, _pose.z)
          .addScaledVector(_right, lat)
          .addScaledVector(_e1.set(Math.sin(_pose.yaw), 0, Math.cos(_pose.yaw)), fwd);
        mesh.position.copy(_p);
        mesh.quaternion.copy(yawQ);
        mesh.castShadow = true;
        portal.add(mesh);
        return mesh;
      };

      const archR = RAIL.portalArchR;      // rayon de la bouche
      const springY = 2.6;                 // hauteur des naissances de l'arc
      const crownY = springY + archR;      // clef de voûte
      const depth = RAIL.portalDepth;

      // Voussoirs le long du demi-cercle (l'anneau de la bouche)
      const blocks = new InstancedMesh(
        new BoxGeometry(1.35, 1.1, depth + 0.3),
        stone,
        RAIL.portalBlocks,
      );
      for (let i = 0; i < RAIL.portalBlocks; i++) {
        const th = (Math.PI * (8 + (164 * i) / (RAIL.portalBlocks - 1))) / 180;
        _p.set(_pose.x, _pose.y + springY, _pose.z)
          .addScaledVector(_right, Math.cos(th) * archR);
        _p.y += Math.sin(th) * archR;
        _e1.set(0, 1, 0);
        _q.setFromAxisAngle(_e1, _pose.yaw);
        _e1.set(0, 0, 1);
        _q2.setFromAxisAngle(_e1, th - Math.PI / 2);
        _q.multiply(_q2);
        _m.compose(_p, _q, _one);
        blocks.setMatrixAt(i, _m);
      }
      blocks.instanceMatrix.needsUpdate = true;
      blocks.castShadow = true;
      portal.add(blocks);

      // Façade PLEINE mais COMPACTE (une version haute lisait comme un mur gris
      // géant) : ouverture rectangulaire percée dans un mur bas serti dans le
      // tertre, anneau de voussoirs par-dessus — ce qu'on voit par les coins est
      // l'INTÉRIEUR sombre du tube, jamais le ciel
      const openHalf = 3.6;
      const wallTop = crownY + 1.2;
      for (const side of [-1, 1]) {
        // Montants pleins de part et d'autre de l'ouverture
        place(new Mesh(new BoxGeometry(3.0, wallTop, depth), stone), side * (openHalf + 1.5), wallTop / 2, 0);
        // Murs en aile évasés (retiennent le talus, cachent la couture terrain/tube)
        const wing = place(new Mesh(new BoxGeometry(0.9, springY + 2.8, 5.4), stone), side * (openHalf + 3.2), (springY + 2.8) / 2 - 0.2, -1.7);
        wing.rotation.y = _pose.yaw + side * 0.5;
        obstacles?.add({ x: wing.position.x, z: wing.position.z, r: 1.4 });
        obstacles?.add({ x: _pose.x + _right.x * side * (openHalf + 1.5), z: _pose.z + _right.z * side * (openHalf + 1.5), r: 1.5 });
      }
      // Linteau plein au-dessus de l'ouverture + parapet de couronnement
      const lintelBase = springY + archR * 0.88;
      place(new Mesh(new BoxGeometry(openHalf * 2, Math.max(wallTop - lintelBase, 0.8), depth), stone), 0, (wallTop + lintelBase) / 2, 0);
      place(new Mesh(new BoxGeometry((openHalf + 3.0) * 2, 0.75, depth * 0.7), stone), 0, wallTop + 0.37, 0.1);

      portal.name = 'rail-portal';
      this.group.add(portal);
    }
  }

  // ---- Gares : quai bas + lampadaires + enseigne ----

  private buildStation(
    s: number,
    obstacles: ObstacleGrid | null,
    outCenter: Vector3,
    towards: Vector3,
  ): void {
    this.track.pose(s, _pose);
    RailTrack.right(_pose, _right);
    // Quai du côté qui regarde `towards` (spawn pour la vallée, cœur de la région neige)
    const side = Math.sign(_right.dot(_p.set(towards.x - _pose.x, 0, towards.z - _pose.z))) || 1;
    const offset = RAIL.gauge / 2 + RAIL.platformW / 2 + 0.7;

    const station = new Group();
    const wood = ToonMaterials.stationWood();

    const slab = new Mesh(new BoxGeometry(RAIL.platformW, 0.5, RAIL.platformLen), wood);
    _p.set(_pose.x, _pose.y + RAIL.platformLift - 0.25, _pose.z).addScaledVector(_right, side * offset);
    slab.position.copy(_p);
    slab.rotation.y = _pose.yaw;
    slab.receiveShadow = true;
    station.add(slab);
    outCenter.copy(_p).y = _pose.y + RAIL.platformLift;

    // 3 lampadaires en fond de quai — GLB Meshy si présent, boxes sinon
    const lanternMat = ToonMaterials.lantern(RAIL.lampColor, RAIL.lanternIntensity);
    const coreGeom = new BoxGeometry(0.16, 0.22, 0.16);
    const stationYaw = _pose.yaw;
    for (const t of [-0.4, 0, 0.4]) {
      // Position le long du quai (axe local Z = tangente)
      _e1.set(Math.sin(stationYaw), 0, Math.cos(stationYaw));
      _p2.copy(_p).addScaledVector(_e1, t * RAIL.platformLen)
        .addScaledVector(_right, side * (RAIL.platformW / 2 - 0.25));
      if (this.decor.lampPost) {
        const lp = this.decor.lampPost;
        const mesh = new Mesh(lp.geometry, lp.material);
        mesh.position.copy(_p2);
        mesh.rotation.y = stationYaw;
        mesh.castShadow = true;
        station.add(mesh);
        // Cœur émissif dans la tête (l'albédo Meshy ne bloome pas)
        const core = new Mesh(coreGeom, lanternMat);
        core.position.copy(_p2).y += lp.height * 0.82;
        station.add(core);
      } else {
        const post = new Mesh(new BoxGeometry(0.14, 2.6, 0.14), wood);
        post.position.copy(_p2).y += 1.3;
        post.castShadow = true;
        station.add(post);
        const lamp = new Mesh(new BoxGeometry(0.34, 0.4, 0.34), lanternMat);
        lamp.position.copy(_p2).y += 2.75;
        station.add(lamp);
      }
      obstacles?.add({ x: _p2.x, z: _p2.z, r: 0.3 });
    }

    // Abri de quai Meshy en fond de quai (face à la voie)
    if (this.decor.stationShelter) {
      const sh = this.decor.stationShelter;
      const mesh = new Mesh(sh.geometry, sh.material);
      _p2.copy(_p).addScaledVector(_right, side * (RAIL.platformW / 2 + sh.radiusXZ * 0.55));
      mesh.position.copy(_p2);
      // Front ouvert vers la voie : l'axe long du GLB est en X après loadProp
      mesh.rotation.y = stationYaw + (side > 0 ? Math.PI : 0);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      station.add(mesh);
      obstacles?.add({ x: _p2.x, z: _p2.z, r: sh.radiusXZ * 0.7 });
    }
    station.name = 'rail-station';
    this.group.add(station);
  }

  // ---- Heurtoirs aux deux extrémités ----

  private buildBuffers(obstacles: ObstacleGrid | null): void {
    const wood = ToonMaterials.railWood();
    for (const s of [0.6, this.track.length - 0.6]) {
      this.track.pose(s, _pose);
      const buffer = new Mesh(new BoxGeometry(2.2, 1.3, 0.7), wood);
      buffer.position.set(_pose.x, _pose.y + 0.65, _pose.z);
      buffer.rotation.y = _pose.yaw;
      buffer.castShadow = true;
      buffer.name = 'rail-buffer';
      this.group.add(buffer);
      obstacles?.add({ x: _pose.x, z: _pose.z, r: 1.0 });
    }
  }
}

const _pose: TrackPose = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
const _p = new Vector3();
const _p2 = new Vector3();
const _right = new Vector3();
const _e1 = new Vector3();
const _q = new Quaternion();
const _q2 = new Quaternion();
const _m = new Matrix4();
const _one = new Vector3(1, 1, 1);
const _scale = new Vector3();
