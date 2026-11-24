/** Fake OpenAI and Gemini clients: record requests, return canned responses. Never touch the network. */
import type { GeminiLike } from '../ai/providers/gemini.js'
import type { OpenAILike } from '../ai/providers/openai.js'

type Reply = Record<string, unknown> | Error

export function fakeOpenAI(replies: Reply[] = [], secret: Reply = { value: 'ek_test_123', expires_at: 1_900_000_000 }) {
  const calls: any[] = []
  const secretCalls: any[] = []
  const client: OpenAILike = {
    responses: {
      async create(body: any) {
        calls.push(body)
        const r = replies.shift() ?? { model: body.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok from openai' }] }], usage: { input_tokens: 10, output_tokens: 5 } }
        if (r instanceof Error) throw r
        return r
      },
    },
    realtime: {
      clientSecrets: {
        async create(body: any) {
          secretCalls.push(body)
          if (secret instanceof Error) throw secret
          return secret
        },
      },
    },
  }
  return { client, calls, secretCalls }
}

export function fakeGemini(replies: Reply[] = []) {
  const calls: any[] = []
  const client: GeminiLike = {
    models: {
      async generateContent(params: any) {
        calls.push(params)
        const r = replies.shift() ?? { modelVersion: params.model, candidates: [{ content: { role: 'model', parts: [{ text: 'ok from gemini' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 } }
        if (r instanceof Error) throw r
        return r
      },
    },
  }
  return { client, calls }
}

/** an error shaped like the SDKs' HTTP errors */
export function httpError(status: number, message = `HTTP ${status}`) {
  return Object.assign(new Error(message), { status })
}
