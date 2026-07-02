import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(rootDir, 'dist')
const port = Number(process.env.PORT || 4173)
const authUser = process.env.BASIC_AUTH_USER
const authPassword = process.env.BASIC_AUTH_PASSWORD
const sessionMaxAgeSeconds = Number(process.env.SESSION_MAX_AGE || 60 * 60 * 8) // 8 hours
const cookieName = 'hermes_auth'
const cookieSecure = process.env.COOKIE_SECURE !== '0' // set COOKIE_SECURE=0 for local http testing
let sessionSecret = process.env.SESSION_SECRET

if (!authUser || !authPassword) {
  console.error('Missing BASIC_AUTH_USER or BASIC_AUTH_PASSWORD.')
  process.exit(1)
}

if (!sessionSecret) {
  sessionSecret = randomBytes(32).toString('hex')
  console.warn(
    'SESSION_SECRET is not set. Generated an ephemeral secret; existing sessions will be invalidated on every restart. Set SESSION_SECRET in production.',
  )
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

    if (pathname === '/auth-check' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleAuthCheck(req, res)
      return
    }

    if (pathname === '/logout') {
      handleLogout(res)
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      methodNotAllowed(res, 'GET, HEAD, POST')
      return
    }

    const relativePath = pathname === '/' || pathname === '/login' ? '/index.html' : pathname
    const filePath = normalize(join(distDir, `.${relativePath}`))

    if (!filePath.startsWith(distDir)) {
      forbidden(res)
      return
    }

    const resolvedPath = await resolvePath(filePath, pathname === '/' || pathname === '/login' || !extname(pathname))
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
  } catch (error) {
    writeHeaders(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(error instanceof Error ? error.message : 'Internal server error.')
  }
}).listen(port, () => {
  console.log(`Hermes login server running on http://localhost:${port}`)
  console.log(`Session cookie: ${cookieName} (Secure=${cookieSecure}, max age ${sessionMaxAgeSeconds}s)`)
})

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

  const cookieValue = issueSessionCookie(username)
  writeHeaders(res, 302, {
    Location: '/',
    'Set-Cookie': cookieValue,
  })
  res.end()
}

function handleAuthCheck(req, res) {
  if (verifySessionCookie(req.headers.cookie || '')) {
    writeHeaders(res, 200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('ok')
    return
  }
  writeHeaders(res, 401, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('unauthorized')
}

function handleLogout(res) {
  writeHeaders(res, 302, {
    Location: '/login',
    'Set-Cookie': buildCookie('', 0),
  })
  res.end()
}

function issueSessionCookie(username) {
  const expiresAt = Math.floor(Date.now() / 1000) + sessionMaxAgeSeconds
  const payload = `${base64UrlEncode(username)}.${expiresAt}`
  const signature = sign(payload)
  const value = `${payload}.${signature}`
  return buildCookie(value, sessionMaxAgeSeconds)
}

function verifySessionCookie(cookieHeader) {
  const value = parseCookie(cookieHeader, cookieName)
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 3) return false
  const [encodedUser, expiresAtRaw, signature] = parts
  const payload = `${encodedUser}.${expiresAtRaw}`
  const expected = sign(payload)
  if (!constantTimeMatch(signature, expected)) return false
  const expiresAt = Number(expiresAtRaw)
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false
  return true
}

function buildCookie(value, maxAgeSeconds) {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Lax']
  if (cookieSecure) attributes.push('Secure')
  attributes.push(`Max-Age=${maxAgeSeconds}`)
  return `${cookieName}=${value}; ${attributes.join('; ')}`
}

function parseCookie(header, name) {
  if (!header) return null
  const pairs = header.split(';')
  for (const raw of pairs) {
    const [rawName, ...rest] = raw.split('=')
    if (rawName.trim() === name) return rest.join('=').trim()
  }
  return null
}

function sign(payload) {
  return createHmac('sha256', sessionSecret).update(payload).digest('base64url')
}

function base64UrlEncode(input) {
  return Buffer.from(String(input), 'utf8').toString('base64url')
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

async function resolvePath(filePath, fallbackToIndex) {
  try {
    const fileStat = await stat(filePath)
    if (fileStat.isFile()) return filePath
  } catch {
    // Fall through to the SPA fallback below.
  }

  if (fallbackToIndex) {
    const indexPath = join(distDir, 'index.html')
    try {
      const indexStat = await stat(indexPath)
      if (indexStat.isFile()) return indexPath
    } catch {
      return null
    }
  }

  return null
}
