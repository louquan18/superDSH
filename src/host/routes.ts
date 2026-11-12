import type { SuperagentService } from '../service.js'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

function json(value: any, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS })
}

/**
 * 管家的三条认证 HTTP 路由（`connection.fetch` 要求 path 以 `/api/` 开头，只有 owner Peer 能访问）：
 *
 * - `GET  /api/superagent/state`  快照
 * - `GET  /api/superagent/events` SSE，只发 invalidate 帧
 * - `POST /api/superagent/action` 面板动作
 *
 * 不用 `ctx.webServer.register`：connection.fetch 自带 owner Peer 鉴权和统一挂载。
 */
export function registerRoutes(ctx: any, service: SuperagentService): void {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  if (!connection?.fetch?.register) return
  ctx.effect(() => {
    const pending: Array<Promise<() => Promise<void>>> = []

    pending.push(
      connection.fetch.register({
        path: '/api/superagent/state',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          try {
            return json(await service.snapshot())
          } catch (error) {
            return json({ ok: false, message: String((error as any)?.message ?? error) }, 500)
          }
        },
      }),
    )

    pending.push(
      connection.fetch.register({
        path: '/api/superagent/events',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const encoder = new TextEncoder()
          let cleanup = () => {}
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              let closed = false
              const write = (chunk: string) => {
                if (closed) return
                try {
                  controller.enqueue(encoder.encode(chunk))
                } catch {
                  closed = true
                }
              }
              const send = (payload: any) => write(`data: ${JSON.stringify(payload)}\n\n`)
              send({ type: 'invalidate' })
              const unsubscribe = service.subscribe(() => send({ type: 'invalidate' }))
              const heartbeat = setInterval(() => write(': ping\n\n'), 15_000)
              heartbeat.unref?.()
              cleanup = () => {
                if (closed) return
                closed = true
                clearInterval(heartbeat)
                unsubscribe()
                try {
                  controller.close()
                } catch {
                  // already closed by the transport
                }
              }
              request?.signal?.addEventListener('abort', cleanup, { once: true })
            },
            cancel() {
              cleanup()
            },
          })
          return new Response(stream, {
            headers: {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache, no-transform',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            },
          })
        },
      }),
    )

    pending.push(
      connection.fetch.register({
        path: '/api/superagent/action',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          let body: any
          try {
            const text = await request.text()
            body = text ? JSON.parse(text) : {}
          } catch {
            return json({ ok: false, message: '请求不是合法 JSON' }, 400)
          }
          const action = String(body?.action ?? '')
          if (!action) return json({ ok: false, message: '缺少 action' }, 400)
          try {
            const value = await service.handleAction(action, body?.payload ?? body)
            const ok = !(value && value.ok === false)
            return json({ ok, value }, ok ? 200 : 400)
          } catch (error) {
            return json({ ok: false, message: String((error as any)?.message ?? error) }, 500)
          }
        },
      }),
    )

    return async () => {
      const disposers = await Promise.allSettled(pending)
      for (const result of disposers) {
        if (result.status !== 'fulfilled') continue
        try {
          await result.value()
        } catch {
          // best effort
        }
      }
    }
  }, 'superagent:routes')
}
