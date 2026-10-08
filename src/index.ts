import { app } from './app'
import { env } from './config/env'

// entry point: ทำแค่เปิด server
app.listen(env.PORT)

console.log(`🦊 Elysia running at http://${app.server?.hostname}:${app.server?.port}`)
console.log(`📖 OpenAPI docs at /openapi`)
