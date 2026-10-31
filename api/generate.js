const BASETEN_ENDPOINT = 'https://inference.baseten.co/v1/chat/completions';
const MODEL_NAME = 'meta-models/muse-spark-open-1026';
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_EMPTY_RESPONSE_RETRIES = 2;
const EMPTY_RETRY_DELAYS_MS = [2000, 4000];

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

function logModelCall({ status, elapsedMs, responseLength, finishReason, errorMessage, apiKey }) {
  let safeError = errorMessage;
  if (safeError && apiKey) safeError = safeError.split(apiKey).join('[redacted]');
  console.info(
    `[Muse Spark Open] HTTP ${status} | duration=${elapsedMs}ms | response_text_length=${responseLength} | finish_reason=${finishReason ?? 'not reported'} | error=${safeError ? JSON.stringify(String(safeError).slice(0, 1000)) : 'none'}`
  );
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Reads request body stream into a string if not already parsed.
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
      } catch (err) {
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
 * Vercel and Node serverless handler.
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

  const apiKey = process.env.BASETEN_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    return sendJson(res, 500, {
      error: 'BASETEN_API_KEY is not configured on the server.'
    });
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
    timeout = DEFAULT_TIMEOUT_MS
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
          model: MODEL_NAME,
          messages,
          temperature,
          max_tokens: maxTokens
        }),
        signal: AbortSignal.timeout(perAttemptTimeout)
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
        logModelCall({ status: upstreamStatus, elapsedMs, responseLength, finishReason, errorMessage: apiError, apiKey: apiKey.trim() });
        return sendJson(res, basetenResponse.status, {
          error: 'Baseten upstream error',
          error_message: apiError,
          details: data,
          upstream_status: upstreamStatus,
          response_text_length: responseLength,
          duration_ms: elapsedMs
        });
      }

      const firstChoice = data.choices && data.choices[0];
      const rawContent = firstChoice?.message?.content;
      const content = typeof rawContent === 'string' ? rawContent : rawContent == null ? '' : JSON.stringify(rawContent);
      responseLength = content.length;
      finishReason = getFinishReason(data);
      const elapsedMs = Math.round(performance.now() - startTime);

      if (!content.trim()) {
        const message = firstChoice?.message ? 'Model returned empty content.' : 'Model response did not contain a message.';
        logModelCall({ status: upstreamStatus, elapsedMs, responseLength, finishReason, errorMessage: message, apiKey: apiKey.trim() });
        if (attempt < MAX_EMPTY_RESPONSE_RETRIES) {
          await wait(EMPTY_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        return sendJson(res, 502, {
          error: `Model returned an empty response after ${attempt + 1} attempts.`,
          upstream_status: upstreamStatus,
          response_text_length: responseLength,
          attempts: attempt + 1,
          duration_ms: Math.round(performance.now() - totalStartTime)
        });
      }

      logModelCall({ status: upstreamStatus, elapsedMs, responseLength, finishReason, apiKey: apiKey.trim() });
      return sendJson(res, 200, {
        content,
        usage: data.usage || null,
        duration_ms: elapsedMs
      });
    } catch (error) {
      const elapsedMs = Math.round(performance.now() - startTime);
      const isTimeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      const message = isTimeout
        ? `Model request timed out after ${perAttemptTimeout}ms.`
        : error.message || 'Failed to communicate with Baseten endpoint.';
      logModelCall({ status: upstreamStatus, elapsedMs, responseLength, finishReason, errorMessage: message, apiKey: apiKey.trim() });
      return sendJson(res, isTimeout ? 504 : 502, {
        error: message,
        upstream_status: upstreamStatus,
        response_text_length: responseLength,
        duration_ms: elapsedMs
      });
    }
  }
}
