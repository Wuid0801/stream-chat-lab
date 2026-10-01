import { serve, type HttpBindings } from '@hono/node-server'
import { createApp } from './app'

const app = createApp({
  dropConnection: (_turnId, c) => {
    // createApp은 런타임과 무관하게 만들어서 env 타입이 없다. Node 바인딩으로 좁힌다.
    const env = c.env as HttpBindings
    env.incoming.socket.destroy()
  },
  seedMessageCount: Number(process.env.SEED_MESSAGES ?? 40),
})

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port })
console.log(`mock-server: http://localhost:${port}`)
