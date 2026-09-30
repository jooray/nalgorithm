// Shared fakes for the link preview tests. Nothing here touches the network.

/** A transport that answers from `routes` (url string to a spec, or a function of the request). */
export function fakeTransport(routes) {
  const calls = []
  const transport = async (req) => {
    calls.push({ url: req.url.toString(), ip: req.ip, family: req.family, headers: req.headers })
    const route = routes[req.url.toString()]
    if (!route) throw new Error(`unexpected request to ${req.url}`)
    const spec = typeof route === 'function' ? await route(req) : route
    return response(spec, req.signal)
  }
  transport.calls = calls
  return transport
}

export function response({ status = 200, type = 'text/html; charset=utf-8', headers = {}, body = '', chunks, hang = false }, signal) {
  const h = { ...headers }
  if (type) h['content-type'] = type
  const parts = chunks ?? [Buffer.from(body)]
  const state = { read: 0, destroyed: false }
  async function* gen() {
    for (const p of parts) {
      state.read++
      yield p
    }
    if (hang) await new Promise((resolve) => signal?.addEventListener('abort', resolve, { once: true }))
  }
  return { status, headers: h, body: gen(), destroy: () => (state.destroyed = true), state }
}

export const publicResolver = (map = {}) => async (host) => {
  if (host in map) return map[host]
  return ['93.184.216.34']
}

export const page = (head) => `<!doctype html><html><head>${head}</head><body>hi</body></html>`
