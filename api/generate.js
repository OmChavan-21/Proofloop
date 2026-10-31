import { performance } from 'node:perf_hooks';

// Ensure .env is loaded if running directly under Node
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // .env is optional when running with pre-configured env vars (e.g. Vercel)
  }
}

const META_ENDPOINT = 'https://api.meta.ai/v1/chat/completions';
const BASETEN_ENDPOINT = 'https://inference.baseten.co/v1/chat/completions';

const DEFAULT_META_MODEL = 'muse-spark-1.3';
const DEFAULT_BASETEN_MODEL = 'meta-models/muse-spark-open-1026';

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_EMPTY_RESPONSE_RETRIES = 2;
const EMPTY_RETRY_DELAYS_MS = [2000, 4000];

function sanitize(message, keys = []) {
  if (!message || typeof message !== 'string') return message;
  let clean = message;
  for (const k of keys) {
    if (k && typeof k === 'string' && k.trim().length > 3) {
      clean = clean.split(k.trim()).join('[redacted]');
    }
  }
  return clean;
}

function getApiErrorMessage(payload, rawText) {
  const error = payload?.error;
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  if (typeof payload?.message === 'string') return payload.message;
  return rawText.slice(0, 1000) || 'No error message returned.';
}

function getFinishReason(payload) {
  const choice = payload?.choices?.[0];
  return choice?.finish_reason ?? choice?.stop_reason ?? payload?.finish_reason ?? payload?.stop_reason ?? 'not reported';
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads request body stream into an object if not already parsed.
 */
async function getRawBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string') {
    return JSON.parse(req.body);
  }
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON in request body'));
      }
    });
    req.on('error', err => reject(err));
  });
}

/**
 * Helper to send JSON responses across Vercel serverless and Node http.
 */
function sendJson(res, statusCode, payload) {
  if (typeof res.status === 'function' && typeof res.json === 'function') {
    return res.status(statusCode).json(payload);
  }
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

/**
 * Infer step (tests, code, repair) from request body or messages content.
 */
function inferStep(body) {
  if (body.step && ['tests', 'code', 'repair'].includes(body.step)) {
    return body.step;
  }
  const messages = body.messages;
  if (Array.isArray(messages)) {
    const combined = messages.map(m => m.content || '').join('\n');
    if (combined.includes('Test Architect') || (combined.includes('"tests":') && !combined.includes('solve_js'))) {
      return 'tests';
    }
    if (combined.includes('repaired_solve_js') || combined.includes('code repair expert')) {
      return 'repair';
    }
    if (combined.includes('solve_js') || combined.includes('master JavaScript engineer')) {
      return 'code';
    }
  }
  return 'tests';
}

/**
 * Resolves the target provider ('meta' or 'baseten') for a given step.
 */
function resolveProviderForStep(step, requestedProvider) {
  if (requestedProvider && ['meta', 'baseten'].includes(requestedProvider.toLowerCase())) {
    return requestedProvider.toLowerCase();
  }
  const testerProvider = (process.env.TESTER_PROVIDER || 'meta').toLowerCase();
  const coderProvider = (process.env.CODER_PROVIDER || 'baseten').toLowerCase();
  const repairProvider = (process.env.REPAIR_PROVIDER || coderProvider || 'baseten').toLowerCase();

  switch (step) {
    case 'tests':
      return testerProvider;
    case 'code':
      return coderProvider;
    case 'repair':
      return repairProvider;
    default:
      return testerProvider;
  }
}

/**
 * Call Meta Model API (dev.meta.ai, OpenAI-compatible).
 */
async function callMetaModelApi({ messages, temperature, maxTokens, timeout, apiKey, model }) {
  const startTime = performance.now();
  let upstreamStatus = 'none';
  let responseLength = 0;
  let finishReason = 'not reported';

  try {
    const metaResponse = await fetch(META_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens
      }),
      signal: AbortSignal.timeout(timeout)
    });

    upstreamStatus = metaResponse.status;
    const responseText = await metaResponse.text();
    responseLength = responseText.length;

    let data;
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = {};
    }
    finishReason = getFinishReason(data);

    if (!metaResponse.ok) {
      const apiError = getApiErrorMessage(data, responseText);
      const elapsedMs = Math.round(performance.now() - startTime);
      return {
        ok: false,
        status: upstreamStatus,
        responseLength,
        elapsedMs,
        finishReason,
        errorMessage: apiError,
        data
      };
    }

    const firstChoice = data.choices && data.choices[0];
    const rawContent = firstChoice?.message?.content;
    const content = typeof rawContent === 'string' ? rawContent : rawContent == null ? '' : JSON.stringify(rawContent);
    const elapsedMs = Math.round(performance.now() - startTime);

    if (!content.trim()) {
      return {
        ok: false,
        status: upstreamStatus,
        responseLength: 0,
        elapsedMs,
        finishReason,
        errorMessage: 'Meta Model API returned empty content.',
        data
      };
    }

    return {
      ok: true,
      status: upstreamStatus,
      content,
      usage: data.usage || null,
      responseLength: content.length,
      elapsedMs,
      finishReason,
      data
    };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - startTime);
    const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
    const message = isTimeout
      ? `Meta Model API timed out after ${timeout}ms.`
      : error.message || 'Failed to communicate with Meta Model API endpoint.';
    return {
      ok: false,
      status: upstreamStatus,
      responseLength: 0,
      elapsedMs,
      finishReason,
      errorMessage: message,
      isTimeout
    };
  }
}

/**
 * Call Baseten Muse Spark Open endpoint with existing retry behavior.
 */
async function callBasetenApi({ messages, temperature, maxTokens, timeout, apiKey, model }) {
  const totalStartTime = performance.now();

  for (let attempt = 0; attempt <= MAX_EMPTY_RESPONSE_RETRIES; attempt++) {
    const startTime = performance.now();
    let upstreamStatus = 'none';
    let responseLength = 0;
    let finishReason = 'not reported';

    try {
      const basetenResponse = await fetch(BASETEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens
        }),
        signal: AbortSignal.timeout(timeout)
      });

      upstreamStatus = basetenResponse.status;
      const responseText = await basetenResponse.text();
      responseLength = responseText.length;

      let data;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        data = {};
      }
      finishReason = getFinishReason(data);

      if (!basetenResponse.ok) {
        const apiError = getApiErrorMessage(data, responseText);
        const elapsedMs = Math.round(performance.now() - startTime);
        return {
          ok: false,
          status: upstreamStatus,
          responseLength,
          elapsedMs,
          finishReason,
          errorMessage: apiError,
          data
        };
      }

      const firstChoice = data.choices && data.choices[0];
      const rawContent = firstChoice?.message?.content;
      const content = typeof rawContent === 'string' ? rawContent : rawContent == null ? '' : JSON.stringify(rawContent);
      const elapsedMs = Math.round(performance.now() - startTime);

      if (!content.trim()) {
        if (attempt < MAX_EMPTY_RESPONSE_RETRIES) {
          await wait(EMPTY_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return {
          ok: false,
          status: upstreamStatus,
          responseLength: 0,
          elapsedMs: Math.round(performance.now() - totalStartTime),
          finishReason,
          errorMessage: `Baseten returned empty response after ${attempt + 1} attempts.`,
          data
        };
      }

      return {
        ok: true,
        status: upstreamStatus,
        content,
        usage: data.usage || null,
        responseLength: content.length,
        elapsedMs,
        finishReason,
        data
      };
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - startTime);
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      const message = isTimeout
        ? `Baseten request timed out after ${timeout}ms.`
        : error.message || 'Failed to communicate with Baseten endpoint.';
      return {
        ok: false,
        status: upstreamStatus,
        responseLength: 0,
        elapsedMs,
        finishReason,
        errorMessage: message,
        isTimeout
      };
    }
  }
}

/**
 * Serverless / Express / Node HTTP handler.
 */
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed. Use POST.' });
  }

  let body;
  try {
    body = await getRawBody(req);
  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }

  const {
    messages,
    temperature = 0.2,
    max_tokens = 16384,
    timeout = DEFAULT_TIMEOUT_MS,
    provider: requestedProvider
  } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return sendJson(res, 400, {
      error: 'Invalid request: "messages" must be a non-empty array.'
    });
  }

  const perAttemptTimeout = Math.min(
    Number.isFinite(Number(timeout)) && Number(timeout) > 0 ? Number(timeout) : DEFAULT_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );
  const maxTokens = Math.max(1, Math.floor(Number(max_tokens) || 16384));

  const step = inferStep(body);
  const selectedProvider = resolveProviderForStep(step, requestedProvider);

  const metaApiKey = process.env.META_API_KEY || '';
  const basetenApiKey = process.env.BASETEN_API_KEY || '';
  const knownKeys = [metaApiKey, basetenApiKey].filter(Boolean);

  const metaModel = process.env.META_MODEL || DEFAULT_META_MODEL;
  const basetenModel = process.env.BASETEN_MODEL || DEFAULT_BASETEN_MODEL;

  // 1. PRIMARY PROVIDER: META
  if (selectedProvider === 'meta') {
    let fallbackNeeded = false;
    let fallbackReason = '';

    // Check if META_API_KEY is available
    if (!metaApiKey.trim()) {
      fallbackNeeded = true;
      fallbackReason = 'META_API_KEY is not configured or empty in environment';
      console.warn(
        `[Meta Model API -> Fallback to Baseten] Status: none | response_length=0 | reason: ${fallbackReason}`
      );
    } else {
      // Attempt call to Meta Model API
      const metaResult = await callMetaModelApi({
        messages,
        temperature,
        maxTokens,
        timeout: perAttemptTimeout,
        apiKey: metaApiKey,
        model: metaModel
      });

      if (metaResult.ok && metaResult.content?.trim()) {
        console.info(
          `[Meta Model API] HTTP ${metaResult.status} | duration=${metaResult.elapsedMs}ms | response_length=${metaResult.responseLength} | finish_reason=${metaResult.finishReason}`
        );
        return sendJson(res, 200, {
          content: metaResult.content,
          usage: metaResult.usage,
          duration_ms: metaResult.elapsedMs,
          provider: 'meta',
          model: metaModel,
          provider_display: `Meta ${metaModel}`,
          fallback: false,
          step
        });
      }

      // Meta call failed or returned empty content -> trigger fallback
      fallbackNeeded = true;
      const safeError = sanitize(metaResult.errorMessage || 'Empty or invalid response', knownKeys);
      fallbackReason = `Meta call failed (HTTP ${metaResult.status}, length=${metaResult.responseLength}, error=${safeError})`;
      console.warn(
        `[Meta Model API -> Fallback to Baseten] Status: ${metaResult.status} | response_length=${metaResult.responseLength} | error=${safeError}`
      );
    }

    // FALLBACK TO BASETEN
    if (fallbackNeeded) {
      if (!basetenApiKey.trim()) {
        return sendJson(res, 500, {
          error: 'Meta Model API failed and BASETEN_API_KEY fallback is not configured on the server.',
          fallback_attempted: true,
          fallback_reason: fallbackReason
        });
      }

      const basetenResult = await callBasetenApi({
        messages,
        temperature,
        maxTokens,
        timeout: perAttemptTimeout,
        apiKey: basetenApiKey,
        model: basetenModel
      });

      if (!basetenResult.ok) {
        const safeError = sanitize(basetenResult.errorMessage || 'Baseten fallback failed', knownKeys);
        console.error(
          `[Baseten Fallback Failed] HTTP ${basetenResult.status} | response_length=${basetenResult.responseLength} | error=${safeError}`
        );
        return sendJson(res, basetenResult.isTimeout ? 504 : 502, {
          error: 'Both Meta and Baseten fallback failed.',
          primary_failure: fallbackReason,
          fallback_error: safeError,
          upstream_status: basetenResult.status,
          response_text_length: basetenResult.responseLength
        });
      }

      console.info(
        `[Baseten Muse Spark Open (Fallback)] HTTP ${basetenResult.status} | duration=${basetenResult.elapsedMs}ms | response_length=${basetenResult.responseLength}`
      );
      return sendJson(res, 200, {
        content: basetenResult.content,
        usage: basetenResult.usage,
        duration_ms: basetenResult.elapsedMs,
        provider: 'baseten',
        model: basetenModel,
        provider_display: 'Baseten Muse Spark Open',
        fallback: true,
        fallback_reason: fallbackReason,
        step
      });
    }
  }

  // 2. PRIMARY PROVIDER: BASETEN
  if (!basetenApiKey.trim()) {
    return sendJson(res, 500, {
      error: 'BASETEN_API_KEY is not configured on the server.'
    });
  }

  const basetenResult = await callBasetenApi({
    messages,
    temperature,
    maxTokens,
    timeout: perAttemptTimeout,
    apiKey: basetenApiKey,
    model: basetenModel
  });

  if (!basetenResult.ok) {
    const safeError = sanitize(basetenResult.errorMessage || 'Baseten request failed', knownKeys);
    console.error(
      `[Baseten Muse Spark Open] HTTP ${basetenResult.status} | duration=${basetenResult.elapsedMs}ms | response_length=${basetenResult.responseLength} | error=${safeError}`
    );
    return sendJson(res, basetenResult.isTimeout ? 504 : 502, {
      error: 'Baseten upstream error',
      error_message: safeError,
      upstream_status: basetenResult.status,
      response_text_length: basetenResult.responseLength,
      duration_ms: basetenResult.elapsedMs
    });
  }

  console.info(
    `[Baseten Muse Spark Open] HTTP ${basetenResult.status} | duration=${basetenResult.elapsedMs}ms | response_length=${basetenResult.responseLength} | finish_reason=${basetenResult.finishReason}`
  );
  return sendJson(res, 200, {
    content: basetenResult.content,
    usage: basetenResult.usage,
    duration_ms: basetenResult.elapsedMs,
    provider: 'baseten',
    model: basetenModel,
    provider_display: 'Baseten Muse Spark Open',
    fallback: false,
    step
  });
}
