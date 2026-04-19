import { type FastifyPluginAsync } from 'fastify'

const root: FastifyPluginAsync = async (fastify, opts): Promise<void> => {
  fastify.get('/', async function (request, reply) {
    return { root: true }
  })
  fastify.get('/hello2', async function (request, reply) {
    return 'this is an example'
  })
}

export default root
