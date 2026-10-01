import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // 측정 빌드(`vite build --mode bench`): 일반 프로덕션 빌드에서는 Profiler onRender가 측정값을 주지 않으므로
  // profiling 빌드의 react-dom을 쓴다. 그 밖의 최적화는 프로덕션 빌드와 같다.
  ...(mode === 'bench'
    ? { resolve: { alias: [{ find: /^react-dom\/client$/, replacement: 'react-dom/profiling' }] } }
    : {}),
}))
