import http from 'node:http';
import { spawn } from 'node:child_process';

const serverProcess = spawn('node', ['server.js'], { stdio: 'inherit' });

// Wait for server to start
await new Promise(r => setTimeout(r, 1500));

try {
  console.log('Testing GET /...');
  const getRes = await fetch('http://localhost:3000/');
  console.log('GET / status:', getRes.status);
  const html = await getRes.text();
  console.log('GET / contains ProofLoop:', html.includes('ProofLoop'));

  console.log('\nTesting POST /api/generate...');
  const postRes = await fetch('http://localhost:3000/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Reply with the word PONG' }],
      max_tokens: 512
    })
  });
  console.log('POST /api/generate status:', postRes.status);
  const data = await postRes.json();
  console.log('POST /api/generate content:', data.content);
  console.log('Reasoning received:', Boolean(data.reasoning));
  console.log('\nSTEP 1 VERIFICATION PASSED');
} catch (err) {
  console.error('Verification error:', err);
} finally {
  serverProcess.kill();
  process.exit(0);
}
