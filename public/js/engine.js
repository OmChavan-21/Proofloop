/**
 * ProofLoop Engine Adapter
 * Connects to the /api/generate proxy, formats prompts for Muse Spark Open,
 * enforces strict JSON output, handles code-fence stripping and outermost-JSON extraction,
 * and retries once on JSON parse failure.
 */

const DEFAULT_API_URL = typeof window !== 'undefined'
  ? '/api/generate'
  : 'http://localhost:3000/api/generate';

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_MAX_TOKENS = 16384;

/**
 * Strips markdown code fences (e.g. ```json ... ```) from text.
 * @param {string} text
 * @returns {string}
 */
export function stripCodeFences(text) {
  if (typeof text !== 'string') return '';
  let cleaned = text.trim();
  // Remove starting ```json or ```
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
  // Remove ending ```
  cleaned = cleaned.replace(/\s*```$/i, '');
  return cleaned.trim();
}

/**
 * Extracts the outermost JSON object { ... } from text, tolerating leading or trailing prose.
 * @param {string} text
 * @returns {string}
 */
export function extractOutermostJSON(text) {
  if (typeof text !== 'string') return '';
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');

  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return text.substring(firstBrace, lastBrace + 1);
  }
  return text.trim();
}

/**
 * Attempts to clean and parse JSON from a raw model string.
 * @param {string} raw
 * @returns {any}
 */
export function extractAndParseJSON(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('Empty or invalid response received from model.');
  }

  // 1. Try stripping code fences first
  const fenced = stripCodeFences(raw);
  try {
    return JSON.parse(fenced);
  } catch (err1) {
    // 2. Try extracting outermost JSON object
    const extracted = extractOutermostJSON(fenced);
    try {
      return JSON.parse(extracted);
    } catch (err2) {
      // 3. Try outermost JSON on original raw text
      const rawExtracted = extractOutermostJSON(raw);
      try {
        return JSON.parse(rawExtracted);
      } catch (err3) {
        throw new Error(`Failed to parse JSON: ${err3.message}`);
      }
    }
  }
}

/**
 * Calls /api/generate with retry on JSON parse failure.
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} options
 * @returns {Promise<{data: any, usage: any, duration_ms: number, retried: boolean}>}
 */
async function callProxyWithJSON({ messages, options = {} }) {
  const apiUrl = options.endpoint || DEFAULT_API_URL;
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;
  const max_tokens = options.max_tokens ?? DEFAULT_MAX_TOKENS;
  const timeout = options.timeout ?? 60000;
  const transportTimeout = timeout + 5000;

  const requestPayload = {
    messages,
    temperature,
    max_tokens,
    timeout
  };

  const startTime = performance.now();
  let retried = false;
  let totalUsage = null;

  let res;
  try {
    res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestPayload),
      signal: AbortSignal.timeout(transportTimeout)
    });
  } catch (error) {
    const message = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? `Proxy call timed out after ${transportTimeout}ms`
      : `Proxy call failed: ${error.message}`;
    throw new Error(`${message} (HTTP status unavailable; response length 0 characters).`);
  }

  const responseJson = await res.json();
  if (!res.ok) {
    const status = responseJson.upstream_status ?? res.status;
    const length = responseJson.response_text_length ?? 'unknown';
    const detail = responseJson.error_message || responseJson.error || 'Generate proxy request failed';
    throw new Error(`${detail} (HTTP status ${status}; response length ${length} characters).`);
  }

  totalUsage = responseJson.usage;
  const rawContent = responseJson.content || '';
  const parseResponse = content => options.strictJSON ? JSON.parse(content) : extractAndParseJSON(content);

  try {
    const parsedData = parseResponse(rawContent);
    const totalElapsed = Math.round(performance.now() - startTime);
    return {
      data: parsedData,
      usage: totalUsage,
      duration_ms: totalElapsed,
      retried: false
    };
  } catch (parseError) {
    // Retry once with a clear reminder to return valid JSON
    retried = true;
    console.warn(`[Engine] JSON parse failed (${parseError.message}). Retrying with repair prompt...`);

    const retryMessages = [
      ...messages,
      { role: 'assistant', content: rawContent },
      {
        role: 'user',
        content: `Your previous response could not be parsed as valid JSON.\nParse error: ${parseError.message}\n` +
                 `Please return ONLY the valid raw JSON object. Do not include markdown code fences, comments, or explanatory text.`
      }
    ];

    let retryRes;
    try {
      retryRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: retryMessages,
          temperature,
          max_tokens,
          timeout
        }),
        signal: AbortSignal.timeout(transportTimeout)
      });
    } catch (error) {
      const message = error.name === 'TimeoutError' || error.name === 'AbortError'
        ? `Proxy retry timed out after ${transportTimeout}ms`
        : `Proxy retry failed: ${error.message}`;
      throw new Error(`${message} (HTTP status unavailable; response length 0 characters).`);
    }

    const retryJson = await retryRes.json();
    if (!retryRes.ok) {
      const status = retryJson.upstream_status ?? retryRes.status;
      const length = retryJson.response_text_length ?? 'unknown';
      const detail = retryJson.error_message || retryJson.error || 'Generate proxy retry failed';
      throw new Error(`${detail} (HTTP status ${status}; response length ${length} characters).`);
    }

    const retryContent = retryJson.content || '';
    try {
      const retryParsed = parseResponse(retryContent);
      const totalElapsed = Math.round(performance.now() - startTime);
      return {
        data: retryParsed,
        usage: retryJson.usage || totalUsage,
        duration_ms: totalElapsed,
        retried: true
      };
    } catch (secondError) {
      throw new Error(
        `Failed to parse JSON response from Muse Spark Open even after retry: ${secondError.message}\nRaw response:\n${retryContent.slice(0, 300)}...`
      );
    }
  }
}

/**
 * 1. Generate Tests
 * Calls Muse Spark Open to create 5-8 test cases including edge cases.
 * Schema: { "tests": [ { "name": "...", "input": <single value>, "expected": ... } ] }
 *
 * @param {string} userRequest - Natural language description of the tool
 * @param {object} options
 * @returns {Promise<{tests: Array<{name: string, input: any, expected: any}>, usage: any, duration_ms: number, retried: boolean}>}
 */
export async function generateTests(userRequest, options = {}) {
  const systemPrompt = `You are a strict, world-class Test Architect.
Your task is to design a comprehensive test suite for a small, pure JavaScript tool based on the user's description.

Rules:
1. Generate between 5 and 8 test cases.
2. Include standard expected cases, boundary cases, and at least ONE edge case (e.g. empty input, zero, negative numbers, whitespace, or invalid input).
3. Each test's "input" is the single value passed to solve(input), exactly as written.
   Example: For a list of numbers, input is [85, 92, 78] (not [[85, 92, 78]]).
   Example: For a string, input is "hello world".
   Example: For multiple named values, use one object such as {"amount": 100, "unit": "USD"}.
4. "expected" must be the exact value solve(input) should return (primitive, array, or object).
5. Return ONLY a valid JSON object matching this schema:
{
  "tests": [
    {
      "name": "example list input",
      "input": [85, 92, 78],
      "expected": "exact expected result"
    }
  ]
}
Do not write markdown fences, code blocks, or explanatory commentary. Return raw JSON only.`;

  const userPrompt = `Create a test suite of 5-8 tests for this tool description:
"${userRequest}"`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const result = await callProxyWithJSON({ messages, options });
  const data = result.data;

  if (!data || !Array.isArray(data.tests) || data.tests.length === 0) {
    throw new Error('Model did not return a valid "tests" array.');
  }

  // Normalize test records without changing the input value's shape.
  data.tests = data.tests.map((t, idx) => ({
    name: t.name || `Test #${idx + 1}`,
    input: t.input,
    expected: t.expected
  }));

  return {
    tests: data.tests,
    usage: result.usage,
    duration_ms: result.duration_ms,
    retried: result.retried
  };
}

/**
 * 2. Generate Code
 * Writes a pure JS function solve(input) that passes the tests, plus a clean ui_html.
 * Schema: { "solve_js": "function solve(input){...}", "ui_html": "<div>...</div>" }
 *
 * @param {string} userRequest - Natural language tool description
 * @param {Array<{name: string, input: any, expected: any}>} tests - The verified test cases
 * @param {object} options
 * @returns {Promise<{solve_js: string, ui_html: string, usage: any, duration_ms: number, retried: boolean}>}
 */
export async function generateCode(userRequest, tests, options = {}) {
  const testsSummary = JSON.stringify(tests, null, 2);

  const systemPrompt = `You are a master JavaScript engineer and UI developer.
Write a pure, deterministic JavaScript function named "solve" that satisfies the user's tool description and passes all provided test cases.

Rules for solve_js:
1. Must be a standalone JavaScript function: function solve(input){ ... }
2. Write solve(input) with exactly one parameter, no handling of the arguments object, no guessing input formats.
3. Pure and deterministic: NO network calls (fetch/ajax), NO DOM access, NO window/document globals, and NO external libraries.
4. The one input parameter receives each test's input value as-is; return values must match test.expected.

Rules for ui_html:
1. Provide a clean, modern HTML component (a <div> container) that allows the user to interactively use this tool in a web browser.
2. Include appropriate <input>, <textarea>, or <select> elements, a button with an onclick handler that calls solve(...) and updates an output element.
3. Keep the UI self-contained and inline-styled or using simple classes.

Output schema: Return ONLY a valid JSON object matching:
{
  "solve_js": "function solve(input) {\\n  // implementation\\n}",
  "ui_html": "<div>\\n  <!-- UI inputs and buttons that call solve() -->\\n</div>"
}
Do not write markdown fences, code blocks, or explanatory commentary. Return raw JSON only.`;

  const userPrompt = `Tool Description:
"${userRequest}"

Test Cases to pass:
${testsSummary}

Write the pure solve function and the companion ui_html.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const result = await callProxyWithJSON({ messages, options });
  const data = result.data;

  if (!data || typeof data.solve_js !== 'string' || typeof data.ui_html !== 'string') {
    throw new Error('Model did not return valid "solve_js" and "ui_html" strings.');
  }

  return {
    solve_js: data.solve_js.trim(),
    ui_html: data.ui_html.trim(),
    usage: result.usage,
    duration_ms: result.duration_ms,
    retried: result.retried
  };
}

/**
 * 3. Repair Code
 * Fixes solve_js given failing test execution results while retaining the existing UI.
 * Schema: { "repaired_solve_js": "function solve(input){...}" }
 *
 * @param {string} userRequest - Original tool description
 * @param {{solve_js: string, ui_html: string}} currentCode - Existing code
 * @param {Array<{name: string, input: any, expected: any, got: any, error?: string}>} failingResults - Failed tests
 * @param {object} options
 * @returns {Promise<{solve_js: string, ui_html: string, usage: any, duration_ms: number, retried: boolean}>}
 */
export async function repairCode(userRequest, currentCode, failingResults, options = {}) {
  const failureSummary = JSON.stringify(failingResults, (key, value) =>
    value === undefined ? '[undefined]' : Number.isNaN(value) ? 'NaN' : value, 2);

  const systemPrompt = `You are a code repair expert.
The previously generated solve function failed one or more tests.
Carefully analyze the test failures (expected vs got or runtime errors), identify the bugs in the logic, and repair only the solve function so ALL original tests pass.

Rules:
1. Output repaired pure, deterministic function solve(input){ ... } with exactly one parameter.
2. The one input parameter receives the test input value as-is.
3. NO DOM or network inside solve.
4. Do not modify tests or UI. Return ONLY a valid JSON object matching:
{
  "repaired_solve_js": "function solve(input) {\\n  // repaired implementation\\n}"
}
Do not write markdown fences, code blocks, or explanatory commentary. Return raw JSON only.`;

  const userPrompt = `Tool Description:
"${userRequest}"

Current Code:
${currentCode.solve_js}

Failing Tests:
${failureSummary}

Repair only the solve function so all tests pass. Keep the supplied tests unchanged and return only the required JSON object.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt }
  ];

  const result = await callProxyWithJSON({ messages, options: { ...options, strictJSON: true } });
  const data = result.data;

  if (!data || Object.keys(data).length !== 1 || typeof data.repaired_solve_js !== 'string') {
    throw new Error('Model did not return a valid "repaired_solve_js" string.');
  }

  return {
    solve_js: data.repaired_solve_js.trim(),
    ui_html: currentCode.ui_html,
    usage: result.usage,
    duration_ms: result.duration_ms,
    retried: result.retried
  };
}
