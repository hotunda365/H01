import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/login': {
        target: 'http://localhost:4173',
        changeOrigin: false,
        secure: false,
      },
    },
  },
})
