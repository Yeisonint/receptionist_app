import { FastifyPluginAsync } from 'fastify'

const timeRoute: FastifyPluginAsync = async (fastify): Promise<void> => {
    fastify.get('/time', async (request, reply) => {
        return {
            serverTime: new Date().toLocaleTimeString(),
            status: 'success'
        }
    })
}

export default timeRoute