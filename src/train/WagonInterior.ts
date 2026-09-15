import { BoxGeometry, Group, Mesh, Vector3, type Material } from 'three/webgpu';
import { TRAIN } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';
import { ObstacleGrid } from '../world/Obstacles';
import type { GroundSource } from '../world/GroundSource';
import type { LoadedProp } from '../assets/PropLoader';

// Intérieur marchable de la voiture 1 (M5), 100 % procédural — style wagon
// vintage assorti à la livrée Meshy : panneaux cramoisis laqués, piliers de
// fenêtres (baies OUVERTES entre eux : on voit défiler le paysage), filets
// laiton, banquettes capitonnées face à face, tapis central, plafond galbé et
// plafonniers chauds. Le GLB (coquille single-sided, sombre de l'intérieur)
// est masqué à bord — cet habillage est TOUT ce que voit le passager.
// Le groupe est ENFANT du root de la voiture (yaw-only) : il coïncide
// toujours avec le repère de simulation locale du joueur.

/** Sol local du wagon : plat, borné au rectangle intérieur (GroundSource). */
export class WagonGround implements GroundSource {
  constructor(
    private readonly halfW: number,
    private readonly halfL: number,
  ) {}

  getHeight(): number {
    return 0;
  }

  getSlopeDeg(): number {
    return 0;
  }

  getNormal(_x: number, _z: number, out: Vector3): Vector3 {
    return out.set(0, 1, 0);
  }

  inBounds(x: number, z: number): boolean {
    // Rectangle FERMÉ : impossible de tomber du train en marche
    return Math.abs(x) <= this.halfW - 0.28 && Math.abs(z) <= this.halfL - 0.35;
  }
}

export class WagonInterior {
  readonly group = new Group();
  readonly ground: WagonGround;
  readonly obstacles = new ObstacleGrid();

  constructor(
    halfW: number,
    halfL: number,
    floorY: number,
    ceilH: number,
    decor: { bench: LoadedProp | null; lantern: LoadedProp | null } = { bench: null, lantern: null },
  ) {
    this.ground = new WagonGround(halfW, halfL);
    const wood = ToonMaterials.stationWood();
    const dark = ToonMaterials.railWood();
    const panel = ToonMaterials.trainPanel();
    const brass = ToonMaterials.trainBrass();
    const add = (mesh: Mesh): Mesh => {
      this.group.add(mesh);
      return mesh;
    };
    const box = (w: number, h: number, d: number, mat: Material, x: number, y: number, z: number): Mesh => {
      const m = new Mesh(new BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      return add(m);
    };

    const sillH = 0.95;      // allège des fenêtres
    const headH = ceilH - 0.34; // linteau (bandeau haut)

    // ---- Plancher bois + tapis central cramoisi ----
    box(halfW * 2, 0.1, halfL * 2, dark, 0, floorY - 0.05, 0);
    box(0.9, 0.024, halfL * 2 - 0.7, panel, 0, floorY + 0.013, 0);

    // ---- Parois latérales : allège + linteau + piliers (baies ouvertes) ----
    for (const side of [-1, 1]) {
      const x = side * (halfW - 0.05);
      // Allège cramoisie + filet laiton sur son chant supérieur
      box(0.1, sillH, halfL * 2, panel, x, floorY + sillH / 2, 0);
      box(0.06, 0.05, halfL * 2, brass, side * (halfW - 0.1), floorY + sillH + 0.025, 0);
      // Bandeau haut (linteau) cramoisi
      box(0.1, ceilH - headH, halfL * 2, panel, x, floorY + (headH + ceilH) / 2, 0);
      // Piliers de fenêtres (bois clair) — 6 baies régulières
      const n = 7;
      for (let i = 0; i < n; i++) {
        const z = -halfL + 0.55 + (i * (halfL * 2 - 1.1)) / (n - 1);
        box(0.09, headH - sillH, 0.16, wood, x, floorY + (sillH + headH) / 2, z);
      }
    }

    // ---- Cloisons d'extrémité : panneau + porte encadrée laiton ----
    for (const end of [-1, 1]) {
      const z = end * (halfL - 0.05);
      box(halfW * 2, ceilH, 0.1, panel, 0, floorY + ceilH / 2, z);
      box(0.78, 1.72, 0.06, dark, 0, floorY + 0.86, z - end * 0.06);
      box(0.86, 0.06, 0.07, brass, 0, floorY + 1.75, z - end * 0.065);
      box(0.1, 0.1, 0.08, brass, 0.3, floorY + 0.95, z - end * 0.09); // poignée
    }

    // ---- Plafond galbé : caisson central bois + pans latéraux inclinés ----
    box(halfW * 1.05, 0.08, halfL * 2, wood, 0, floorY + ceilH + 0.02, 0);
    for (const side of [-1, 1]) {
      const pan = box(0.62, 0.07, halfL * 2, wood, side * (halfW - 0.28), floorY + ceilH - 0.1, 0);
      pan.rotation.z = side * 0.38;
    }
    // Deux plafonniers chauds (contrat bloom ≥ 1,5) + socles laiton
    const lampMat = ToonMaterials.lantern(TRAIN.windowColor, 1.7);
    for (const t of [-0.45, 0.45]) {
      box(0.22, 0.1, 0.42, brass, 0, floorY + ceilH - 0.05, t * halfL);
      box(0.16, 0.12, 0.34, lampMat, 0, floorY + ceilH - 0.15, t * halfL);
    }

    // ---- Banquettes face à face : GLB Meshy capitonné si présent ----
    for (const side of [-1, 1]) {
      for (const t of [-0.55, 0.55]) {
        const bx = side * (halfW - 0.4);
        const bz = t * halfL;
        if (decor.bench) {
          const b = decor.bench;
          const mesh = new Mesh(b.geometry, b.material);
          // Longueur plafonnée au créneau (l'échelle loadProp est par hauteur)
          const fit = Math.min(1, 1.55 / Math.max(b.lengthX, 0.01));
          mesh.scale.setScalar(fit);
          mesh.position.set(side * (halfW - 0.36 * fit - 0.06), floorY, bz);
          // Axe long du GLB en X → aligné au wagon (Z), dos vers la paroi
          mesh.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
          add(mesh);
        } else {
          box(0.56, 0.36, 1.5, wood, bx, floorY + 0.18, bz);           // caisson
          box(0.54, 0.1, 1.46, panel, bx, floorY + 0.41, bz);          // coussin
          box(0.1, 0.62, 1.5, wood, side * (halfW - 0.14), floorY + 0.72, bz);  // dossier
          box(0.08, 0.3, 1.42, panel, side * (halfW - 0.2), floorY + 0.78, bz); // capiton dossier
        }
        this.obstacles.add({ x: bx, z: bz, r: 0.5 });
      }
    }

    // ---- Lanternes murales Meshy sur les cloisons d'extrémité ----
    if (decor.lantern) {
      const l = decor.lantern;
      for (const end of [-1, 1]) {
        const mesh = new Mesh(l.geometry, l.material);
        mesh.scale.setScalar(0.8);
        mesh.position.set(-halfW * 0.45, floorY + 1.55, end * (halfL - 0.14));
        mesh.rotation.y = end > 0 ? Math.PI : 0; // bras contre la cloison
        add(mesh);
      }
    }

    this.group.traverse((o) => {
      o.frustumCulled = false; // suit le train : compile au warmup, jamais cullé
      o.castShadow = false;
      o.receiveShadow = false;
    });
  }
}
