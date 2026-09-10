import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    // 5173 常被其他项目（如 PLM）的 dev server 占用，固定 5180 + strictPort：
    // 被占时直接报错，避免 tauri devUrl 指向别人的页面（2026-09-10 真机踩坑）
    port: 5180,
    strictPort: true,
    open: false,
  },
  test: {
    environment: 'jsdom',
  },
});
