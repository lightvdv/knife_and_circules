import { defineConfig } from 'vite';

// Две страницы: 3D-версия (index.html) и 2D-прототип (2d.html).
export default defineConfig({
  build: {
    rolldownOptions: {
      input: {
        main: 'index.html',
        game2d: '2d.html',
      },
    },
  },
});
