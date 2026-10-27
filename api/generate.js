const BASETEN_ENDPOINT = 'https://inference.baseten.co/v1/chat/completions';
const MODEL_NAME = 'meta-models/muse-spark-open-1026';

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

  const { messages, temperature = 0.2, max_tokens = 4096 } = body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return sendJson(res, 400, {
      error: 'Invalid request: "messages" must be a non-empty array.'
    });
  }

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
        max_tokens
      })
    });

    if (!basetenResponse.ok) {
      const errText = await basetenResponse.text();
      let parsedError;
      try {
        parsedError = JSON.parse(errText);
      } catch {
        parsedError = { message: errText };
      }
      return sendJson(res, basetenResponse.status, {
        error: 'Baseten upstream error',
        details: parsedError
      });
    }

    const data = await basetenResponse.json();
    const firstChoice = data.choices && data.choices[0];

    if (!firstChoice || !firstChoice.message) {
      return sendJson(res, 502, {
        error: 'Invalid response structure from model endpoint.',
        raw: data
      });
    }

    // choices[0].message.content is the final answer
    // choices[0].message.reasoning_content is separate reasoning
    const content = firstChoice.message.content || '';
    const reasoning = firstChoice.message.reasoning_content || '';

    return sendJson(res, 200, {
      content,
      reasoning,
      usage: data.usage || null
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: 'Failed to communicate with Baseten endpoint.',
      message: error.message
    });
  }
}
