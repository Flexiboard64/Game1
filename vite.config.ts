import { defineConfig } from 'vite';

export default defineConfig({
  // Tous les imports 'three' (y compris ceux internes aux addons comme GLTFLoader)
  // pointent vers le build WebGPU — indispensable pour éviter une double instance de three.
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  build: { target: 'esnext' },
  optimizeDeps: { esbuildOptions: { target: 'esnext' } },
  assetsInclude: ['**/*.glb'],
  server: { port: 5173 },
});
