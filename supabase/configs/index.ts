import * as jose from 'jsr:@panva/jose@6'

console.log('main function started')

const MAX_WORKER_RETRIES = 3

const JWT_SECRET = Deno.env.get('JWT_SECRET')
const SUPABASE_JWKS = parseJwks(Deno.env.get('SUPABASE_JWKS'))
const LOCAL_JWKS = SUPABASE_JWKS ? jose.createLocalJWKSet(SUPABASE_JWKS) : null
const VERIFY_JWT = Deno.env.get('VERIFY_JWT') === 'true'

type AuthFailure = {
  code: RequestErrors
  message?: string
}

type FunctionFailure = {
  code: RequestErrors
  message: string
  status: number
}

export enum RequestErrors {
  InvalidLegacyJWT = 'UNAUTHORIZED_LEGACY_JWT',
  InvalidAsymmetricJWT = 'UNAUTHORIZED_ASYMMETRIC_JWT',
  InvalidTokenFormat = 'UNAUTHORIZED_INVALID_JWT_FORMAT',
  UnsupportedTokenAlgorithm = 'UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM',
  MissingAuthHeader = 'UNAUTHORIZED_NO_AUTH_HEADER',
  NotFound = 'NOT_FOUND',
  BootError = 'BOOT_ERROR',
  EdgeFunctionError = 'EDGE_FUNCTION_ERROR',
  IdleTimeout = 'IDLE_TIMEOUT',
  WorkerResourceLimit = 'WORKER_RESOURCE_LIMIT',
  WorkerError = 'WORKER_ERROR',
  InvalidResponseStatusCode = 'INVALID_RESPONSE_STATUS_CODE',
}

function getFunctionErrorResponse({ code, message, status }: FunctionFailure): Response {
  return Response.json(
    { code, message },
    {
      status,
      headers: {
        'sb-error-code': code,
        'Access-Control-Expose-Headers': 'sb-error-code',
      },
    }
  )
}

function handleWorkerResponse(response: Response): Response {
  if (response.status < 500) return response

  const headers = new Headers(response.headers)
  headers.set('sb-error-code', RequestErrors.EdgeFunctionError)

  const exposedHeaders = (headers.get('Access-Control-Expose-Headers') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (!exposedHeaders.some((name) => name.toLowerCase() === 'sb-error-code')) {
    exposedHeaders.push('sb-error-code')
  }
  headers.set('Access-Control-Expose-Headers', exposedHeaders.join(', '))

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function resolveRuntimeError(e: unknown): FunctionFailure {
  // These error classes are supplied by Edge Runtime, rather than stock Deno.
  if (e instanceof Deno.errors.InvalidWorkerCreation) {
    return {
      code: RequestErrors.BootError,
      message: 'Function failed to start (please check logs)',
      status: 503,
    }
  }
  if (e instanceof Deno.errors.WorkerRequestCancelled) {
    return {
      code: RequestErrors.WorkerResourceLimit,
      message: 'Function failed due to not having enough compute resources (please check logs)',
      status: 546,
    }
  }
  if (e instanceof Deno.errors.WorkerRequestIdleTimeout) {
    return {
      code: RequestErrors.IdleTimeout,
      message: 'Request idle timeout limit (150s) reached',
      status: 504,
    }
  }
  // No dedicated runtime error class exists for invalid response statuses.
  // The Response constructor throws directly here or inside the user worker.
  if (
    (e instanceof RangeError || e instanceof Deno.errors.InvalidWorkerResponse) &&
    e.message.includes('is not equal to 101 and outside the range [200, 599]')
  ) {
    return {
      code: RequestErrors.InvalidResponseStatusCode,
      message: 'Function returned an invalid HTTP status code (please check logs)',
      status: 500,
    }
  }
  if (
    e instanceof Deno.errors.WorkerAlreadyRetired ||
    e instanceof Deno.errors.InvalidWorkerResponse
  ) {
    return {
      code: RequestErrors.WorkerError,
      message: 'Function exited due to an error (please check logs)',
      status: 500,
    }
  }
  return { code: RequestErrors.EdgeFunctionError, message: 'Internal Server Error', status: 500 }
}

// NOTE:(kallebysantos) We don't check for valid keys but just the bare array parsing,
// let this for 'jose' lib verification
export function parseJwks(raw: string | undefined): jose.JSONWebKeySet | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.keys && Array.isArray(parsed.keys)) {
      return parsed as jose.JSONWebKeySet
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract JWT token from 'Authorization' header or fallback to 'sb-api-key' compatibility
 *
 * Parses the Authorization header to extract the Bearer token.
 * Expects format: "Bearer <token>"
 *
 * @param req - The HTTP request object
 * @returns The JWT token string or an authentication failure
 */
function extractBearerToken(authHeader: string | null): string | null {
  const tokenParts = (authHeader ?? '').trim().split(/\s+/)
  const [bearer, token] = tokenParts
  if (bearer.toLowerCase() !== 'bearer' || tokenParts.length !== 2 || !token) {
    return null
  }
  return token
}

function getAuthToken(req: Request): string | AuthFailure {
  const authHeader = req.headers.get('authorization')
  const sbApiKeyCompatibilityToken = req.headers.get('sb-api-key')

  if (!authHeader && !sbApiKeyCompatibilityToken) {
    return {
      code: RequestErrors.MissingAuthHeader,
      message: 'Missing authorization header',
    }
  }

  // NOTE:(kallebysantos) Compatibility mode is triggered when all conditions match:
  // - API proxy mints a temp token
  // - Original bearer is not present or is ApiKey
  const bearerToken = extractBearerToken(authHeader)
  const token = !bearerToken || bearerToken.startsWith('sb_')
    ? sbApiKeyCompatibilityToken
    : bearerToken

  if (!token) {
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: 'Invalid JWT format',
    }
  }

  return token
}

function getAuthErrorResponse({ code, message = 'Invalid JWT' }: AuthFailure) {
  return Response.json(
    {
      code,
      message,
      // DEPRECATED: Retained for backward compatibility.
      msg: message,
    },
    {
      status: 401,
      headers: {
        'sb-error-code': code,
        'Access-Control-Expose-Headers': 'sb-error-code',
      },
    }
  )
}

async function isValidLegacyJWT(jwt: string): Promise<AuthFailure | null> {
  if (!JWT_SECRET) {
    console.error('JWT_SECRET not available for HS256 token verification')
    return { code: RequestErrors.InvalidLegacyJWT }
  }

  const encoder = new TextEncoder();
  const secretKey = encoder.encode(JWT_SECRET);

  try {
    await jose.jwtVerify(jwt, secretKey);
  } catch (e) {
    console.error('Symmetric Legacy JWT verification error', e);
    return { code: RequestErrors.InvalidLegacyJWT }
  }
  return null
}

async function isValidJWT(jwt: string): Promise<AuthFailure | null> {
  if (!LOCAL_JWKS) {
    console.error('JWKS not available for ES256/RS256 token verification')
    return { code: RequestErrors.InvalidAsymmetricJWT }
  }

  try {
    await jose.jwtVerify(jwt, LOCAL_JWKS);
  } catch (e) {
    console.error('Asymmetric JWT verification error', e);
    return { code: RequestErrors.InvalidAsymmetricJWT }
  }

  return null
}

/**
 * Verify JWT token, handling both legacy (HS256) and newer (ES256/RS256) algorithms
 * 
 * This function automatically detects the algorithm used in the token and applies
 * the appropriate verification method:
 * - HS256: Uses JWT_SECRET (symmetric key)
 * - ES256/RS256: Uses JWKS endpoint (asymmetric public keys)
 * 
 * This fix ensures compatibility with both legacy tokens and newer asymmetric tokens,
 * resolving the "Key for the ES256 algorithm must be of type CryptoKey" error.
 * 
 * @param jwt - The JWT token string to verify
 * @returns Authentication failure details, or null when verification succeeds
 */
async function isValidHybridJWT(jwt: string): Promise<AuthFailure | null> {
  let jwtAlgorithm: string | undefined
  try {
    jwtAlgorithm = jose.decodeProtectedHeader(jwt).alg
  } catch (e) {
    console.error('JWT format error', e)
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: 'Invalid JWT format',
    }
  }

  if (!jwtAlgorithm) {
    return {
      code: RequestErrors.InvalidTokenFormat,
      message: 'Invalid JWT format',
    }
  }

  if (jwtAlgorithm === 'HS256') {
    console.log(`Legacy token type detected, attempting ${jwtAlgorithm} verification.`)

    return await isValidLegacyJWT(jwt)
  }

  if (jwtAlgorithm === 'ES256' || jwtAlgorithm === 'RS256') {
    return await isValidJWT(jwt)
  }

  return {
    code: RequestErrors.UnsupportedTokenAlgorithm,
    message: `Unsupported JWT algorithm ${jwtAlgorithm}`,
  }
}

const ROOT = '/home/deno/functions'
const SLUG_RE = /^[A-Za-z][A-Za-z0-9_-]*$/
const ENV_DENYLIST = new Set(['MANAGEMENT_TOKEN'])
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.mjs', 'index.jsx']
const BUNDLE_CACHE_SIZE = 16

const memoryLimitMb = 150
// Keep the wall clock above the 150s request idle timeout configured in Compose.
const workerTimeoutMs = Number(Deno.env.get('FUNCTIONS_WORKER_TIMEOUT_MS') ?? 400_000)
const requestAbsentTimeoutMs = 60_000
const noModuleCache = false

type ActiveVersion = {
  version: number
  service_path: string
  entrypoint: string
  import_map: string | null
  static_patterns: string[]
} & ({ kind: 'source'; bundle: null } | { kind: 'bundle'; bundle: string })

type FunctionRecord = {
  id: string
  status: 'ACTIVE' | 'REMOVED' | 'THROTTLED'
  verify_jwt: boolean
  active: ActiveVersion
}

type Secrets = {
  version: number
  values: Record<string, string>
}

const fileCache = new Map<string, { stamp: string; value: unknown }>()
const bundleCache = new Map<string, Uint8Array>()

function notFound(): Response {
  return getFunctionErrorResponse({
    code: RequestErrors.NotFound,
    message: 'Requested function was not found',
    status: 404,
  })
}

function bootError(): Response {
  return getFunctionErrorResponse({
    code: RequestErrors.BootError,
    message: 'Function failed to start (please check logs)',
    status: 503,
  })
}

async function statOrNull(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.stat(path)
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null
    throw e
  }
}

async function hasIndexFile(servicePath: string): Promise<boolean> {
  for (const name of INDEX_FILES) {
    if ((await statOrNull(`${servicePath}/${name}`))?.isFile) return true
  }
  return false
}

async function readCached<T>(path: string, parse: (text: string) => T): Promise<T | null> {
  const info = await statOrNull(path)
  if (!info) {
    fileCache.delete(path)
    return null
  }
  const stamp = `${info.mtime?.getTime()}:${info.size}:${info.ino}`
  const cached = fileCache.get(path)
  if (cached?.stamp === stamp) return cached.value as T
  const value = parse(await Deno.readTextFile(path))
  fileCache.set(path, { stamp, value })
  return value
}

function readRecord(servicePath: string): Promise<FunctionRecord | null> {
  return readCached(`${servicePath}/.function.json`, (text) => JSON.parse(text) as FunctionRecord)
}

async function readSecrets(): Promise<Secrets> {
  const secrets = await readCached(`${ROOT}/.management/secrets.json`, (text) => {
    let file: { version: number; secrets: Record<string, { value: string }> }
    try {
      file = JSON.parse(text)
    } catch {
      throw new Error('secrets.json is not valid JSON')
    }
    const values = Object.fromEntries(Object.entries(file.secrets).map(([name, secret]) => [name, secret.value]))
    return { version: file.version, values }
  })
  return secrets ?? { version: 0, values: {} }
}

async function readBundle(key: string, path: string): Promise<Uint8Array> {
  const bytes = bundleCache.get(key) ?? (await Deno.readFile(path))
  bundleCache.delete(key)
  bundleCache.set(key, bytes)
  if (bundleCache.size > BUNDLE_CACHE_SIZE) {
    const [oldest] = bundleCache.keys()
    bundleCache.delete(oldest)
  }
  return bytes
}

async function legacyImportMapPath(servicePath: string): Promise<string> {
  // A function's own deno.json wins over the shared import map, as on hosted Supabase.
  let importMapPath = `/home/deno/functions/deno.jsonc`
  for (const name of ['deno.json', 'deno.jsonc']) {
    try {
      if ((await Deno.stat(`${servicePath}/${name}`)).isFile) {
        importMapPath = `${servicePath}/${name}`
        break
      }
    } catch {}
  }
  return importMapPath
}

async function workerOptions(slug: string, servicePath: string, record: FunctionRecord | null) {
  const secrets = await readSecrets()
  const base = Object.entries(Deno.env.toObject()).filter(([name]) => !ENV_DENYLIST.has(name))
  const envVars = Object.entries({ ...Object.fromEntries(base), ...secrets.values, SUPABASE_FUNCTION_SLUG: slug })
  const poolKey = `${slug}@${record ? `${record.id}@${record.active.version}` : 'legacy'}@${secrets.version}`
  const common = { poolKey, memoryLimitMb, workerTimeoutMs, noModuleCache, envVars }
  const supervisor = { requestAbsentTimeoutMs }
  if (!record) {
    return { ...common, servicePath, importMapPath: await legacyImportMapPath(servicePath), context: { supervisor } }
  }
  const { active } = record
  if (active.kind === 'source') {
    return {
      ...common,
      servicePath: active.service_path,
      maybeEntrypoint: active.entrypoint,
      staticPatterns: active.static_patterns,
      context: { supervisor, ...(active.import_map ? { importMapPath: active.import_map } : {}) },
    }
  }
  return {
    ...common,
    servicePath: active.service_path,
    maybeEszip: await readBundle(`${record.id}@${active.version}`, active.bundle),
    maybeEntrypoint: active.entrypoint,
    context: { supervisor },
  }
}

Deno.serve(async (req: Request) => {
  const service_name = new URL(req.url).pathname.split('/')[1]
  if (!service_name || !SLUG_RE.test(service_name) || service_name.toLowerCase() === 'main') {
    return notFound()
  }

  const servicePath = `${ROOT}/${service_name}`
  let record: FunctionRecord | null
  try {
    if (!(await statOrNull(servicePath))?.isDirectory) return notFound()
    record = await readRecord(servicePath)
    if (record?.status === 'REMOVED') return notFound()
    if (!record && !(await hasIndexFile(servicePath))) return notFound()
  } catch (e) {
    console.error(e)
    return bootError()
  }

  if (req.method !== 'OPTIONS' && (record ? record.verify_jwt : VERIFY_JWT)) {
    try {
      const token = getAuthToken(req)
      if (typeof token !== 'string') {
        return getAuthErrorResponse(token)
      }
      const authFailure = await isValidHybridJWT(token)
      if (authFailure) {
        return getAuthErrorResponse(authFailure)
      }
    } catch (e) {
      console.error(e)
      return getAuthErrorResponse({
        code: RequestErrors.InvalidTokenFormat,
        message: 'Invalid JWT format',
      })
    }
  }

  console.error(`serving the request with ${servicePath}`)

  const options = await workerOptions(service_name, servicePath, record).catch((e) => {
    console.error(e)
    return null
  })
  if (!options) return bootError()

  const callWorker = async (req: Request, retriesLeft = MAX_WORKER_RETRIES): Promise<Response> => {
    // Preserve the body before fetch() can consume it, even on a failed attempt.
    // Must run before `new Request(req)` below, which takes over the body.
    // The unread retry branch can buffer the entire body in main-worker memory,
    // even when the first attempt succeeds.
    const retryReq = retriesLeft > 0 ? req.clone() : null

    try {
      const worker = await EdgeRuntime.userWorkers.create(options)
      // Gateway-minted internal JWT is for this router only; never expose it to user functions.
      const userReq = new Request(req)
      userReq.headers.delete('sb-api-key')
      EdgeRuntime.applySupabaseTag(req, userReq)
      return handleWorkerResponse(await worker.fetch(userReq))
    } catch (e) {
      // Retirement rejects before dispatch, so user code has not run yet.
      if (e instanceof Deno.errors.WorkerAlreadyRetired && retryReq) {
        console.warn(`${service_name}: worker retired before dispatch; retrying (${retriesLeft} left)`)
        // Request.clone() does not copy the tag that connects streaming to the client.
        EdgeRuntime.applySupabaseTag(req, retryReq)
        return await callWorker(retryReq, retriesLeft - 1)
      }

      console.error(e)
      return getFunctionErrorResponse(resolveRuntimeError(e))
    }
  }

  return await callWorker(req)
})
