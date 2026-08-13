const CUSTOMER_TOKEN = 'eyJhbGciOiJFUzI1NiIsImtpZCI6ImRmOWMzZTE1LTgzNzctNDBiOC05OWQzLTI5YmJlNmU2MjhiNyIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2hib2ZxeGxwb2NmeGthcHh5d3FqLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJkOTRjYzM1Ny1mNDY1LTQ2ZWQtYWQ5OS00ZjFiOGQwZGQ5NWUiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzg2NTk0NjM5LCJpYXQiOjE3ODY1OTEwMzksImVtYWlsIjoiY3VzdG9tZXIxQHRlc3QuY29tIiwicGhvbmUiOiIiLCJhcHBfbWV0YWRhdGEiOnsicHJvdmlkZXIiOiJlbWFpbCIsInByb3ZpZGVycyI6WyJlbWFpbCJdfSwidXNlcl9tZXRhZGF0YSI6eyJlbWFpbF92ZXJpZmllZCI6dHJ1ZX0sInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYWFsIjoiYWFsMSIsImFtciI6W3sibWV0aG9kIjoicGFzc3dvcmQiLCJ0aW1lc3RhbXAiOjE3ODY1OTEwMzl9XSwic2Vzc2lvbl9pZCI6ImZhM2MyNmZkLWM1YTItNDBhMi1hNmJhLTFhOTViMzRmMDMxMSIsImlzX2Fub255bW91cyI6ZmFsc2V9.fcYGUg5J0FbOVfi1fwc1SJjl3lqnVu_GCx9-amzg41jmMftyayXxSuQ_7Udqi1mMLNQIUzYdEZMF8wKYJaX1Tg';
const PRODUCT_ID = '54f7a661-0a87-4a7c-9b7c-e3675f718792';

async function placeOrder(label) {
  const res = await fetch('http://localhost:3000/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CUSTOMER_TOKEN}`,
    },
    body: JSON.stringify({
      items: [{ product_id: PRODUCT_ID, quantity: 1 }],
    }),
  });

  const body = await res.json();
  console.log(`[${label}] Status: ${res.status}`);
  console.log(`[${label}] Response:`, JSON.stringify(body, null, 2));
  return { label, status: res.status, body };
}

async function runConcurrencyTest() {
  console.log('Firing two simultaneous orders for the last item in stock...\n');

  const [resultA, resultB] = await Promise.all([
    placeOrder('Customer A'),
    placeOrder('Customer B'),
  ]);

  console.log('\n--- RESULT ---');
  const successes = [resultA, resultB].filter((r) => r.status === 201);
  const failures = [resultA, resultB].filter((r) => r.status !== 201);

  console.log(`Successes: ${successes.length}`);
  console.log(`Failures: ${failures.length}`);

  if (successes.length === 1 && failures.length === 1) {
    console.log('PASS: Exactly one order succeeded, the other was correctly rejected.');
  } else {
    console.log('FAIL: Expected exactly 1 success and 1 failure.');
  }
}

runConcurrencyTest();
