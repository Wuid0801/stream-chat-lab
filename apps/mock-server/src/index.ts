import { serve } from '@hono/node-server'
import { Hono } from 'hono'

// 턴/스트림 라우트는 M2에서 추가한다.
const app = new Hono()
app.get('/health', (c) => c.text('ok'))

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port })
console.log(`mock-server: http://localhost:${port}`)
