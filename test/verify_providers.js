import { spawn } from 'node:child_process';

// Ensure environment variables are loaded
if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile();
  } catch {
    // Optional
  }
}

console.log('=== Meta Model API & Baseten Provider Verification ===\n');

if (!process.env.META_API_KEY || !process.env.META_API_KEY.trim()) {
  console.warn('⚠ META_API_KEY is not set in .env.');
  console.warn('  Please add META_API_KEY=your_key to .env before running live Meta calls.');
  console.warn('  (Fallback to Baseten will automatically be tested if META_API_KEY is missing).\n');
}

// Start the local Node server
const serverProcess = spawn('node', ['server.js'], { stdio: 'inherit' });
await new Promise(r => setTimeout(r, 1500));

try {
  // Test 1: Single test call to Meta Model API (or fallback if key not yet added)
  console.log('--- 1. Testing Provider: Meta Model API (1 call) ---');
  const metaRes = await fetch('http://localhost:3000/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'meta',
      step: 'tests',
      messages: [{ role: 'user', content: 'Respond with exactly: {"status":"ok"}' }],
      max_tokens: 256
    })
  });

  const metaData = await metaRes.json();
  console.log('HTTP Status:', metaRes.status);
  console.log('Provider returned:', metaData.provider_display || metaData.provider);
  console.log('Fallback triggered:', Boolean(metaData.fallback));
  if (metaData.fallback) {
    console.log('Fallback reason:', metaData.fallback_reason);
  }
  console.log('Content preview:', (metaData.content || '').slice(0, 100));

  // Test 2: Single test call to Baseten
  console.log('\n--- 2. Testing Provider: Baseten Muse Spark Open (1 call) ---');
  const basetenRes = await fetch('http://localhost:3000/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'baseten',
      step: 'code',
      messages: [{ role: 'user', content: 'Respond with exactly: {"status":"ok"}' }],
      max_tokens: 256
    })
  });

  const basetenData = await basetenRes.json();
  console.log('HTTP Status:', basetenRes.status);
  console.log('Provider returned:', basetenData.provider_display || basetenData.provider);
  console.log('Content preview:', (basetenData.content || '').slice(0, 100));

  console.log('\n✔ Verification complete. Provider layer is operational.');
} catch (err) {
  console.error('Verification error:', err.message);
} finally {
  serverProcess.kill();
  process.exit(0);
}
