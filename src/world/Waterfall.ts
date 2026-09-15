import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Mesh,
  PlaneGeometry,
  SpriteNodeMaterial,
  Vector3,
} from 'three/webgpu';
import {
  cameraPosition,
  color,
  float,
  fract,
  hash,
  instanceIndex,
  mix,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { CASCADE, WATER } from '../config';
import { ToonMaterials } from '../materials/ToonMaterials';

// Cascade : ruban balistique à deux couches plaqué sur l'encoche du déversoir
// (positions issues de la simulation de la carte), écume d'impact elliptique au
// pied, nappes de brume instanciées. Animation 100 % `time` — zéro CPU/frame.

/** Ruban de chute : grille (u = travers, v = haut→bas) bombée vers l'aval. */
function curtainGeometry(layerOffset: number): BufferGeometry {
  const top = CASCADE.top;
  const bottom = CASCADE.bottom;
  const botY = bottom.y - CASCADE.sink;

  // Direction d'écoulement projetée XZ (vers l'aval/le spawn) + axe de largeur
  const fx = bottom.x - top.x;
  const fz = bottom.z - top.z;
  const fl = Math.hypot(fx, fz) || 1;
  const dx = fx / fl;
  const dz = fz / fl;
  const wx = -dz;
  const wz = dx;

  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const sw = CASCADE.segmentsW;
  const sh = CASCADE.segmentsH;

  for (let j = 0; j <= sh; j++) {
    const v = j / sh;
    // Arc balistique : bombé max à mi-chute, dernière rangée courbée sur la crête
    const bulge = CASCADE.bulge * 4 * v * (1 - v);
    const crest = -0.8 * (1 - v) ** 6; // le haut « épouse » la lèvre côté amont
    const cx = top.x + (bottom.x - top.x) * v + dx * (bulge + crest + layerOffset);
    const cz = top.z + (bottom.z - top.z) * v + dz * (bulge + crest + layerOffset);
    const cy = top.y + (botY - top.y) * v;
    // Léger évasement vers le bas
    const halfW = (CASCADE.width / 2) * (0.8 + 0.35 * v);
    for (let i = 0; i <= sw; i++) {
      const u = i / sw;
      positions.push(cx + wx * (u - 0.5) * 2 * halfW, cy, cz + wz * (u - 0.5) * 2 * halfW);
      uvs.push(u, v);
      if (i < sw && j < sh) {
        const a = j * (sw + 1) + i;
        index.push(a, a + 1, a + sw + 1, a + 1, a + sw + 2, a + sw + 1);
      }
    }
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

export class Waterfall {
  readonly group = new Group();

  constructor() {
    // Deux couches : recto rapide, verso lent (épaisseur visuelle)
    const front = new Mesh(curtainGeometry(0.15), ToonMaterials.cascadeCurtain(CASCADE.speedFront, 1));
    const back = new Mesh(curtainGeometry(-0.15), ToonMaterials.cascadeCurtain(CASCADE.speedBack, 0.7));
    front.renderOrder = 9;
    back.renderOrder = 8;
    this.group.add(back);
    this.group.add(front);

    // Écume d'impact : ellipse alignée sur l'écoulement, posée sur le lac
    const foamGeo = new PlaneGeometry(CASCADE.plungeRx * 2, CASCADE.plungeRz * 2);
    foamGeo.rotateX(-Math.PI / 2);
    const foam = new Mesh(foamGeo, ToonMaterials.plungeFoam());
    foam.position.set(CASCADE.bottom.x, CASCADE.bottom.y + 0.05, CASCADE.bottom.z);
    foam.rotation.y = Math.atan2(CASCADE.bottom.x - CASCADE.top.x, CASCADE.bottom.z - CASCADE.top.z);
    foam.renderOrder = 10;
    this.group.add(foam);

    // Brume : nappes molles qui montent lentement du pied de la chute
    this.group.add(buildMist());

    // Aucun castShadow/receiveShadow : la chute est émissive/translucide.
    // frustumCulled false : compileAsync ET le render de warmup frustum-cullent
    // — au spawn la caméra regarde +Z et la chute est ~39 m DERRIÈRE, ses
    // shaders se compileraient donc en jeu au premier regard vers la cascade
    this.group.traverse((o) => {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = false;
    });
  }
}

function buildMist(): InstancedMesh {
  const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false });
  const base = uniform(new Vector3(CASCADE.bottom.x, CASCADE.bottom.y, CASCADE.bottom.z));
  const h = (n: number) => hash(instanceIndex.add(n));
  const S = vec3(CASCADE.mistBox.x, CASCADE.mistBox.y, CASCADE.mistBox.z);
  const boxMin = base.sub(vec3(CASCADE.mistBox.x / 2, 0.4, CASCADE.mistBox.z / 2));

  // Montée lente + dérive, enroulement fract() dans la boîte (base statique)
  const seedPos = vec3(h(0), h(1), h(2)).mul(S);
  const drift = vec3(
    sin(time.mul(0.3).add(h(3).mul(6.2832))).mul(0.6),
    time.mul(0.45),
    sin(time.mul(0.23).add(h(4).mul(6.2832))).mul(0.5),
  );
  const wrapped = boxMin.add(fract(seedPos.add(drift).sub(boxMin).div(S)).mul(S));
  m.positionNode = wrapped;
  const size = mix(float(CASCADE.mistSize[0]!), float(CASCADE.mistSize[1]!), h(7));
  m.scaleNode = vec2(size, size);

  const p = uv().sub(0.5);
  const disc = smoothstep(0.12, 0.5, p.length()).oneMinus();
  const nrmY = wrapped.sub(boxMin).div(S).y;
  const envY = smoothstep(0.0, 0.15, nrmY).mul(smoothstep(0.75, 1.0, nrmY).oneMinus());
  const dist = wrapped.sub(cameraPosition).length();
  const envNear = smoothstep(2.0, 4.0, dist);

  m.colorNode = color(WATER.foamColor);
  m.opacityNode = disc.mul(envY).mul(envNear).mul(CASCADE.mistOpacity);

  const mesh = new InstancedMesh(new PlaneGeometry(1, 1), m, CASCADE.mistCount);
  mesh.frustumCulled = false;
  // Les positions vivent dans positionNode : matrixWorld reste l'identité, donc
  // le tri des transparents classerait la brume à l'origine du monde (le spawn).
  // renderOrder explicite : après les plans d'eau (0), avant le rideau (8/9).
  mesh.renderOrder = 7;
  return mesh;
}
