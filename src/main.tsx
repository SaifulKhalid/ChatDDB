import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider } from './lib/auth'
import App from './App'
// Imported rather than inlined into index.css: the stylesheet references 60
// font files by relative url(), and Vite only rebases and fingerprints those
// when it resolves the import itself. Must precede index.css so the
// `.markdown .katex*` overrides there win on equal specificity.
import 'katex/dist/katex.min.css'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
)
