import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // KaTeX and highlight.js together are larger than the app itself, and
        // neither changes when app code does. Splitting them out keeps the entry
        // chunk small and lets both stay cached across deploys.
        //
        // Function form rather than the `{name: [...packages]}` map: the object
        // form is gone from the current Rollup typings. Matching on the path
        // segment after `node_modules` also catches each package's own imports,
        // which the map form never did — `katex` pulled in by `rehype-katex`
        // landed wherever the default heuristic put it.
        manualChunks(id) {
          const pkg = /[\\/]node_modules[\\/](?:(@[^\\/]+)[\\/])?([^\\/]+)/.exec(id)
          if (!pkg) return
          const name = pkg[1] ? `${pkg[1]}/${pkg[2]}` : pkg[2]
          if (name === 'katex' || name === 'rehype-katex') return 'katex'
          if (name === 'highlight.js' || name === 'rehype-highlight' || name === 'lowlight') {
            return 'highlight'
          }
          if (name === 'react-markdown' || name === 'remark-gfm' || name === 'remark-math') {
            return 'markdown'
          }
        },
      },
    },
  },
  server: {
    proxy: {
      // Local Worker (wrangler dev) once the backend exists
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
})
