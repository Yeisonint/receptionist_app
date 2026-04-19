import { FastifyPluginAsync } from 'fastify'
import { GoogleGenAI } from '@google/genai'

const voicePlugin: FastifyPluginAsync = async (fastify) => {
  // Initialize the new Google GenAI SDK
  const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

  fastify.get('/token', async (request, reply) => {
    try {
      // 10 minutes duration for the ephemeral token
      const expireTime = new Date(Date.now() + 10 * 60 * 1000).toISOString()
      
      const response = await genAI.authTokens.create({
        config: {
          uses: 1, 
          expireTime,
          httpOptions: { apiVersion: 'v1alpha' } // required for ephemeral tokens
        }
      })
      
      reply.send({ token: response.name })
    } catch (err) {
      console.error('Error generating token', err)
      reply.status(500).send({ error: 'Failed to generate ephemeral token' })
    }
  })
}

export default voicePlugin