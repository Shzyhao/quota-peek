import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    open: false,
  },
  test: {
    environment: 'jsdom',
  },
});
