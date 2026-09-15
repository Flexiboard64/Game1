import { Bone, Group, Mesh, Object3D, Vector3 } from 'three/webgpu';

const _ws = new Vector3();
const _wp = new Vector3();
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { SWORD } from '../config';
import { loadProp } from '../assets/PropLoader';

// Épée d'Aeliana : GLB Meshy normalisé (lame le long de +Y, garde à y=0) attaché
// à l'os de la main droite du rig. L'os vit DANS la scène skinnée à l'échelle du
// GLB : le groupe compense (1/sceneScale) pour que lame et offsets restent en
// mètres monde. Introuvable → canari + combat à mains nues, jamais de crash.

export class SwordMount {
  readonly found: boolean = false;
  private readonly group = new Group();

  constructor(skinnedScene: Object3D, sceneScale: number, swordGltf: GLTF | null) {
    if (!swordGltf) {
      console.warn('[Sword] GLB absent — combat à mains nues');
      return;
    }
    const prop = loadProp(swordGltf, { targetHeight: SWORD.lengthM });
    if (!prop) {
      console.warn('[Sword] GLB illisible — combat à mains nues');
      return;
    }

    const re = new RegExp(SWORD.boneRegex, 'i');
    let bone: Object3D | null = null;
    const candidates: string[] = [];
    skinnedScene.traverse((o: Object3D) => {
      if (!(o as Bone).isBone) return;
      if (/hand/i.test(o.name)) candidates.push(o.name);
      if (!bone && re.test(o.name)) bone = o;
    });
    if (!bone) {
      console.warn('[Sword] os de main introuvable — candidats :', candidates);
      return;
    }

    // Compensation par l'échelle MONDE de l'os : les rigs Meshy portent des
    // échelles INTERNES dans la hiérarchie (style FBX ~0,01) — compenser la
    // seule échelle de scène laissait une épée de quelques millimètres
    void sceneScale;
    skinnedScene.updateWorldMatrix(true, true);
    (bone as Object3D).getWorldScale(_ws);
    (bone as Object3D).getWorldPosition(_wp);
    const ws = _ws.x > 1e-8 ? _ws.x : 1;
    console.info(
      `[Sword] monté sur « ${(bone as Object3D).name} » — os à (${_wp.x.toFixed(2)}, ${_wp.y.toFixed(2)}, ${_wp.z.toFixed(2)}), échelle monde ${ws.toFixed(5)}`,
    );

    const mesh = new Mesh(prop.geometry, prop.material);
    mesh.castShadow = true;
    mesh.frustumCulled = false; // suit un os : bounding statique fausse
    // Le POINT DE GRIP de la géométrie est ramené à l'origine du groupe AVANT
    // toute rotation : le manche reste dans la paume quelle que soit
    // l'orientation (les offsets en espace os dérivaient — retour utilisateur)
    mesh.position.y = -SWORD.gripY;
    this.group.add(mesh);
    this.group.scale.setScalar(1 / ws);
    this.group.position.set(
      SWORD.offset.x / ws,
      SWORD.offset.y / ws,
      SWORD.offset.z / ws,
    );
    this.group.rotation.set(
      (SWORD.rotDeg.x * Math.PI) / 180,
      (SWORD.rotDeg.y * Math.PI) / 180,
      (SWORD.rotDeg.z * Math.PI) / 180,
    );
    (bone as Object3D).add(this.group);
    (this as { found: boolean }).found = true;
  }

  /** Épée escamotée en plané (M9.3) : une lame nue dans la main levée jurait. */
  setVisible(v: boolean): void {
    this.group.visible = v;
  }

  /** Garde et pointe de la lame en MONDE (traînée d'épée). */
  sampleBlade(hilt: Vector3, tip: Vector3): boolean {
    if (!this.found) return false;
    this.group.updateWorldMatrix(true, false);
    // Géométrie normalisée : base à y=0, pointe à y=lengthM ; l'échelle 1/s du
    // groupe et l'échelle s de la scène s'annulent → coordonnées lame en mètres
    hilt.set(0, SWORD.hiltY - SWORD.gripY, 0).applyMatrix4(this.group.matrixWorld);
    tip.set(0, SWORD.tipY - SWORD.gripY, 0).applyMatrix4(this.group.matrixWorld);
    return true;
  }
}
