import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual } from 'node:crypto'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const distDir = join(rootDir, 'dist')
const port = Number(process.env.PORT || 4173)
const authUser = process.env.BASIC_AUTH_USER
const authPassword = process.env.BASIC_AUTH_PASSWORD
const dashboardUrl = process.env.DASHBOARD_URL || 'http://hermes-dashboard:5000/sessions'

if (!authUser || !authPassword) {
  console.error('Missing BASIC_AUTH_USER or BASIC_AUTH_PASSWORD.')
  process.exit(1)
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
  console.log(`Dashboard URL: ${dashboardUrl}`)
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

  writeHeaders(res, 302, { Location: dashboardUrl })
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
