import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { crx } from '@crxjs/vite-plugin';

export default defineConfig(async ({ mode }) => {
  const configDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(configDir, '..');
  const backendDir = resolve(repoRoot, 'backend');

  const env = {
    ...loadEnv(mode, repoRoot, ''),
    ...loadEnv(mode, backendDir, ''),
    ...loadEnv(mode, configDir, ''),
    ...process.env,
  };

  Object.assign(process.env, env);
  const { default: manifest } = await import('./manifest.config');

  return {
    plugins: [crx({ manifest })],
    define: {
      'process.env.ODDITY_BACKEND_URL': JSON.stringify(
        env.ODDITY_BACKEND_URL || env.VITE_BACKEND_URL || undefined
      ),
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
    },
  };
});
