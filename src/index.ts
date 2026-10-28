import { app } from './app'

const port = Number(process.env.PORT ?? 3000)

app.listen(port)

console.log(`🦊 Elysia running at http://${app.server?.hostname}:${app.server?.port}`)
console.log(`📖 OpenAPI docs at /openapi`)
