import { RenderPipeline, type PerspectiveCamera, type Scene, type WebGPURenderer } from 'three/webgpu';
import type { PassNode } from 'three/webgpu';
import { float, pass, screenUV, smoothstep, vec4 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { POST } from '../config';

// Pipeline de rendu : passe scène (MSAA + HalfFloat hérités du renderer — le
// chemin direct passe DÉJÀ par une RT offscreen + blit, donc l'image de base
// est identique au pixel près) → bloom additif seuillé → vignette douce →
// renderOutput appliqué par RenderPipeline (mêmes toneMapping/colorSpace).
// Ne PAS toucher renderer.toneMapping dans le cadre de cette feature.

export interface PostPipeline {
  readonly pipeline: RenderPipeline;
  /** Pour compileAsync ciblé sur la RT de la passe (contexte ≠ framebuffer). */
  readonly scenePass: PassNode;
}

export function createPostPipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: PerspectiveCamera,
): PostPipeline {
  const scenePass = pass(scene, camera); // samples/type hérités du renderer
  const scenePassColor = scenePass.getTextureNode('output');

  const bloomed = bloom(scenePassColor, POST.bloomStrength, POST.bloomRadius, POST.bloomThreshold);
  bloomed.smoothWidth.value = POST.bloomSmoothWidth;

  // Vignette : assombrissement radial très léger, en espace linéaire
  const d = screenUV.sub(0.5).length().mul(2); // 0 centre → ~1.41 coin
  const vig = smoothstep(float(POST.vignetteStart), float(1.45), d)
    .mul(POST.vignetteStrength)
    .oneMinus();

  const composite = scenePassColor.add(bloomed);
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = vec4(composite.rgb.mul(vig), composite.a);
  return { pipeline, scenePass };
}
