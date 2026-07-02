import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(rootDir, 'dist')
const port = Number(process.env.PORT || 4173)
const authUser = process.env.BASIC_AUTH_USER
const authPassword = process.env.BASIC_AUTH_PASSWORD
const upstreamUrl = process.env.UPSTREAM_URL || process.env.DASHBOARD_URL
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000)
const postLoginPath = process.env.POST_LOGIN_PATH || '/sessions'
const cookieName = 'hermes_session'

if (!authUser || !authPassword) {
  console.error('Missing BASIC_AUTH_USER or BASIC_AUTH_PASSWORD.')
  process.exit(1)
}

if (!upstreamUrl) {
  console.error('Missing UPSTREAM_URL (e.g. http://service-xxx:5000).')
  process.exit(1)
}

let upstream
try {
  upstream = new URL(upstreamUrl)
} catch {
  console.error(`Invalid UPSTREAM_URL: ${upstreamUrl}`)
  process.exit(1)
}
if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
  console.error(`UPSTREAM_URL must be http/https, got: ${upstreamUrl}`)
  process.exit(1)
}

const sessionSecret = process.env.SESSION_SECRET || randomBytes(32).toString('hex')
if (!process.env.SESSION_SECRET) {
  console.warn('SESSION_SECRET not set; using ephemeral secret (sessions will not survive restart).')
}

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
])

createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = decodeURIComponent(requestUrl.pathname)

    if (pathname === '/login' && req.method === 'POST') {
      await handleLoginPost(req, res)
      return
    }

    if (pathname === '/logout') {
      handleLogout(res)
      return
    }

    if (isLocalStaticPath(pathname)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        methodNotAllowed(res, 'GET, HEAD')
        return
      }
      await serveStatic(req, res, pathname)
      return
    }

    if (!isAuthenticated(req)) {
      redirectTo(res, '/')
      return
    }

    proxyRequest(req, res)
  } catch (error) {
    writeHeaders(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(error instanceof Error ? error.message : 'Internal server error.')
  }
})
  .on('upgrade', (req, socket, head) => {
    try {
      if (!isAuthenticated(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      proxyUpgrade(req, socket, head)
    } catch {
      socket.destroy()
    }
  })
  .listen(port, () => {
    console.log(`Hermes login server running on http://localhost:${port}`)
    console.log(`Proxying authenticated traffic to: ${upstream.origin}`)
  })

function isLocalStaticPath(pathname) {
  if (pathname === '/' || pathname === '/favicon.svg' || pathname === '/favicon.ico') return true
  if (pathname.startsWith('/assets/')) return true
  return false
}

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === '/' ? '/index.html' : pathname
  const filePath = normalize(join(distDir, `.${relativePath}`))

  if (!filePath.startsWith(distDir)) {
    forbidden(res)
    return
  }

  let resolvedPath
  try {
    const fileStat = await stat(filePath)
    if (fileStat.isFile()) resolvedPath = filePath
  } catch {
    // fall through
  }

  if (!resolvedPath && pathname === '/') {
    resolvedPath = join(distDir, 'index.html')
  }

  if (!resolvedPath) {
    notFound(res)
    return
  }

  const body = await readFile(resolvedPath)
  const contentType = mimeTypes.get(extname(resolvedPath)) || 'application/octet-stream'

  writeHeaders(res, 200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': resolvedPath.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
  })

  if (req.method === 'HEAD') {
    res.end()
    return
  }

  res.end(body)
}

async function handleLoginPost(req, res) {
  const body = await readBody(req)
  const form = new URLSearchParams(body)
  const username = form.get('username') || ''
  const password = form.get('password') || ''

  if (!constantTimeMatch(username, authUser) || !constantTimeMatch(password, authPassword)) {
    writeHeaders(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Invalid username or password.')
    return
  }

  const cookie = buildSessionCookie()
  writeHeaders(res, 302, {
    Location: postLoginPath,
    'Set-Cookie': cookie,
  })
  res.end()
}

function handleLogout(res) {
  writeHeaders(res, 302, {
    Location: '/',
    'Set-Cookie': `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  })
  res.end()
}

function buildSessionCookie() {
  const expiry = Date.now() + sessionTtlMs
  const payload = String(expiry)
  const sig = createHmac('sha256', sessionSecret).update(payload).digest('hex')
  const value = `${payload}.${sig}`
  const maxAgeSec = Math.floor(sessionTtlMs / 1000)
  return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`
}

function isAuthenticated(req) {
  const cookieHeader = req.headers.cookie || ''
  const cookies = parseCookies(cookieHeader)
  const raw = cookies.get(cookieName)
  if (!raw) return false
  const dot = raw.lastIndexOf('.')
  if (dot <= 0) return false
  const payload = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  const expiry = Number(payload)
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false
  const expected = createHmac('sha256', sessionSecret).update(payload).digest('hex')
  return constantTimeMatch(sig, expected)
}

function parseCookies(header) {
  const map = new Map()
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    const val = part.slice(eq + 1).trim()
    if (key) map.set(key, val)
  }
  return map
}

function proxyRequest(req, res) {
  const requester = upstream.protocol === 'https:' ? httpsRequest : httpRequest
  const targetPath = req.url || '/'
  const headers = buildForwardHeaders(req)

  const upstreamReq = requester(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: targetPath,
      headers,
    },
    (upstreamRes) => {
      const responseHeaders = { ...upstreamRes.headers }
      res.writeHead(upstreamRes.statusCode || 502, responseHeaders)
      upstreamRes.pipe(res)
    },
  )

  upstreamReq.on('error', (err) => {
    if (res.headersSent) {
      res.end()
      return
    }
    writeHeaders(res, 502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`Upstream error: ${err.message}`)
  })

  req.pipe(upstreamReq)
}

function proxyUpgrade(req, clientSocket, head) {
  const requester = upstream.protocol === 'https:' ? httpsRequest : httpRequest
  const headers = buildForwardHeaders(req)

  const upstreamReq = requester({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: req.url || '/',
    headers,
  })

  upstreamReq.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    const statusLine = `HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage || 'Switching Protocols'}\r\n`
    const headerLines = Object.entries(upstreamRes.headers)
      .flatMap(([key, val]) => (Array.isArray(val) ? val.map((v) => `${key}: ${v}`) : [`${key}: ${val}`]))
      .join('\r\n')
    clientSocket.write(`${statusLine}${headerLines}\r\n\r\n`)
    if (upstreamHead && upstreamHead.length) clientSocket.write(upstreamHead)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
    upstreamSocket.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstreamSocket.destroy())
  })

  upstreamReq.on('error', () => clientSocket.destroy())
  if (head && head.length) upstreamReq.write(head)
  upstreamReq.end()
}

function buildForwardHeaders(req) {
  const headers = { ...req.headers }
  headers.host = upstream.host
  headers['x-forwarded-for'] = req.socket.remoteAddress || ''
  headers['x-forwarded-proto'] = 'https'
  headers['x-forwarded-host'] = req.headers.host || ''
  // Strip our session cookie from what we send upstream
  if (headers.cookie) {
    const filtered = headers.cookie
      .split(';')
      .map((s) => s.trim())
      .filter((s) => !s.startsWith(`${cookieName}=`))
      .join('; ')
    if (filtered) headers.cookie = filtered
    else delete headers.cookie
  }
  return headers
}

function redirectTo(res, location) {
  writeHeaders(res, 302, { Location: location })
  res.end()
}

function methodNotAllowed(res, allow) {
  writeHeaders(res, 405, {
    Allow: allow,
    'Content-Type': 'text/plain; charset=utf-8',
  })
  res.end('Method not allowed.')
}

function forbidden(res) {
  writeHeaders(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Forbidden.')
}

function notFound(res) {
  writeHeaders(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found.')
}

function writeHeaders(res, statusCode, headers) {
  res.writeHead(statusCode, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    ...headers,
  })
}

function constantTimeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left))
  const rightBuffer = Buffer.from(String(right))
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let data = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 16_384) {
        reject(new Error('Request body too large.'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}
