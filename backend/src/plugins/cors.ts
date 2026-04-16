import fp from 'fastify-plugin'
import cors, { FastifyCorsOptions } from '@fastify/cors'

export default fp<FastifyCorsOptions>(async (fastify) => {
    fastify.register(cors, {
        // Permitir explícitamente el origen de Angular
        origin: "http://localhost:4200",
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
        credentials: true
    })
})