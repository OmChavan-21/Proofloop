import { spawn } from 'node:child_process';
import {
  stripCodeFences,
  extractOutermostJSON,
  extractAndParseJSON,
  generateTests,
  generateCode,
  repairCode
} from '../public/js/engine.js';

// --- Part 1: Offline Unit Tests for JSON Extraction & Stripping ---
console.log('=== PART 1: Testing Code-Fence Stripping & Outermost Extraction ===');

// Test 1: Markdown code fences
const fencedText = '```json\n{\n  "tests": [\n    {"name": "test 1", "input": [1], "expected": 2}\n  ]\n}\n```';
const parsedFromFenced = extractAndParseJSON(fencedText);
if (parsedFromFenced.tests && parsedFromFenced.tests.length === 1) {
  console.log('✔ Successfully parsed markdown fenced JSON');
} else {
  throw new Error('Failed to parse fenced JSON');
}

// Test 2: Leading and trailing explanatory text
const proseWrappedText = 'Here is the JSON you requested:\n\n{\n  "solve_js": "function solve() {}",\n  "ui_html": "<div></div>"\n}\n\nHope this helps you build your tool!';
const parsedFromProse = extractAndParseJSON(proseWrappedText);
if (parsedFromProse.solve_js && parsedFromProse.ui_html) {
  console.log('✔ Successfully extracted outermost JSON from surrounding prose');
} else {
  throw new Error('Failed to extract outermost JSON from prose');
}

// --- Part 2: Live Integration Tests with Baseten Endpoint ---
console.log('\n=== PART 2: Live Integration with Muse Spark Open (3 Demos) ===');

// Start the local Node server to handle /api/generate
const serverProcess = spawn('node', ['server.js'], { stdio: 'pipe' });
await new Promise(r => setTimeout(r, 1500));

const DEMOS = {
  grades: 'Calculate letter grades (A: 90+, B: 80-89, C: 70-79, D: 60-69, F: <60) and class average from a list of numerical marks.',
  cleaner: 'Clean and format a list of names: trim whitespace, collapse multiple spaces into one, and capitalize each name in title-case.',
  converter: 'Convert temperature between Celsius and Fahrenheit and length between meters and feet, with validation for non-numeric input.'
};

try {
  // Demo 1: Generate Tests for Grade Calculator
  console.log('\n--- 1. Testing generateTests (Grade Calculator) ---');
  console.log(`Prompt: "${DEMOS.grades}"`);
  const testsResult = await generateTests(DEMOS.grades, { endpoint: 'http://localhost:3000/api/generate' });
  console.log(`✔ Generated ${testsResult.tests.length} tests in ${testsResult.duration_ms}ms (retried: ${testsResult.retried})`);
  console.log(`  Token usage:`, testsResult.usage);
  console.log(`  Sample test #1:`, testsResult.tests[0]);

  // Demo 2: Generate Code for Text Cleaner
  console.log('\n--- 2. Testing generateCode (Text Cleaner) ---');
  console.log(`Prompt: "${DEMOS.cleaner}"`);
  const sampleCleanerTests = [
    { name: 'Trim and title case', input: '  john doe  ', expected: 'John Doe' },
    { name: 'Multiple names', input: 'alice smith,   bob   jones', expected: 'Alice Smith, Bob Jones' }
  ];
  const codeResult = await generateCode(DEMOS.cleaner, sampleCleanerTests, { endpoint: 'http://localhost:3000/api/generate' });
  console.log(`✔ Generated solve_js (${codeResult.solve_js.length} chars) & ui_html (${codeResult.ui_html.length} chars) in ${codeResult.duration_ms}ms`);
  console.log(`  Token usage:`, codeResult.usage);
  console.log(`  Code preview:`, codeResult.solve_js.split('\n')[0]);

  // Demo 3: Repair Code for Unit Converter
  console.log('\n--- 3. Testing repairCode (Unit Converter) ---');
  console.log(`Prompt: "${DEMOS.converter}"`);
  const buggyCode = {
    solve_js: 'function solve(input) { return input.value * 2; }',
    ui_html: '<div><input id="v"><button onclick="solve()">Convert</button></div>'
  };
  const failingTests = [
    {
      name: 'Celsius to Fahrenheit',
      input: { value: 0, unit: 'C_to_F' },
      expected: 32,
      got: 0,
      error: 'Expected 32, got 0'
    },
    {
      name: 'Invalid input validation',
      input: { value: 'invalid', unit: 'C_to_F' },
      expected: null,
      got: NaN,
      error: 'Expected null, got NaN'
    }
  ];
  const repairResult = await repairCode(DEMOS.converter, buggyCode, failingTests, { endpoint: 'http://localhost:3000/api/generate' });
  console.log(`✔ Repaired solve_js in ${repairResult.duration_ms}ms (retried: ${repairResult.retried})`);
  console.log(`  Token usage:`, repairResult.usage);
  console.log(`  Repaired solve preview:`, repairResult.solve_js.split('\n')[0]);

  console.log('\n========================================');
  console.log('🎉 ALL STEP 2 ENGINE ADAPTER TESTS PASSED');
  console.log('========================================');
} catch (err) {
  console.error('❌ Step 2 Test Error:', err);
} finally {
  serverProcess.kill();
  process.exit(0);
}
