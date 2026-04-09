import { defineConfig, loadEnv } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
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
