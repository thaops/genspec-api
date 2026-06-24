const http = require('http');
const https = require('https');

const LOCAL_URL = 'http://localhost:4000';
const PROD_URL = 'https://genspec-api.onrender.com';
const EMAIL = 'admin@genspec.dev';
const PASSWORD = 'genspec123';

async function request(baseUrl, path, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const client = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    const payload = body ? JSON.stringify(body) : '';
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(data);
            }
          } else {
            reject(new Error(`Request failed (${res.statusCode}): ${data}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function runTests() {
  let baseUrl = LOCAL_URL;
  console.log(`Connecting to local API at ${LOCAL_URL}...`);
  let token;
  try {
    const res = await request(baseUrl, '/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
    token = res.token;
    console.log('Successfully connected to LOCAL API.');
  } catch (err) {
    console.log(`Local API not available (${err.message}). Trying production API...`);
    baseUrl = PROD_URL;
    try {
      const res = await request(baseUrl, '/auth/login', 'POST', { email: EMAIL, password: PASSWORD });
      token = res.token;
      console.log('Successfully connected to PRODUCTION API.');
    } catch (prodErr) {
      console.error('Failed to connect to both Local and Production API. Is the server running?', prodErr.message);
      process.exit(1);
    }
  }

  try {
    console.log('\n--- STARTING API TEST FLOW ---');

    // 1. Tạo một dự toán test
    console.log('1. Creating a new test estimate...');
    const estimate = await request(baseUrl, '/estimates', 'POST', { name: 'Dự án Test Patch History' }, token);
    const estimateId = estimate.id;
    console.log(`Estimate created successfully. ID: ${estimateId}`);

    // 2. Thêm vật tư VL.TEST qua applyActions
    console.log('2. Adding a test material (VL.TEST)...');
    const actions = [
      {
        type: 'upsert_material',
        code: 'VL.TEST',
        name: 'Vật tư kiểm thử tự động',
        unit: 'kg',
        price: 75000,
        source: {
          name: 'Thông báo giá test',
          type: 'market',
        },
      },
    ];

    const applyRes = await request(baseUrl, `/estimates/${estimateId}/actions`, 'POST', { actions, source: 'manual' }, token);
    console.log(`Material applied. Total actions: ${applyRes.applied}`);

    // 3. Lấy estimate chi tiết và kiểm tra patchHistory
    console.log('3. Verifying patch was recorded in history...');
    const updatedEstimate = await request(baseUrl, `/estimates/${estimateId}`, 'GET', null, token);
    const history = updatedEstimate.patchHistory ?? [];
    console.log(`Current patch history length: ${history.length}`);
    
    if (history.length === 0) {
      throw new Error('Test failed: patchHistory is empty!');
    }

    const latestPatch = history[history.length - 1];
    console.log(`Latest patch ID: ${latestPatch.id}`);
    console.log(`Description: ${latestPatch.description}`);
    console.log(`Changes: ${JSON.stringify(latestPatch.changes)}`);

    // 4. Kiểm tra xem vật tư đã xuất hiện trong danh sách chưa
    const matExists = updatedEstimate.materials.some(m => m.code === 'VL.TEST');
    if (!matExists) {
      throw new Error('Test failed: Material VL.TEST not found in estimate!');
    }
    console.log('Material VL.TEST is present in estimate state.');

    // 5. Thực hiện Rollback
    console.log(`4. Performing rollback to patch: ${latestPatch.id}...`);
    const rollbackRes = await request(baseUrl, `/estimates/${estimateId}/rollback`, 'POST', { patchId: latestPatch.id }, token);
    
    // 6. Kiểm tra xem vật tư đã biến mất sau rollback chưa
    console.log('5. Verifying estimate state after rollback...');
    const rolledBackEstimate = await request(baseUrl, `/estimates/${estimateId}`, 'GET', null, token);
    const matStillExists = rolledBackEstimate.materials.some(m => m.code === 'VL.TEST');
    
    if (matStillExists) {
      throw new Error('Test failed: Material VL.TEST still exists after rollback!');
    }
    console.log('Material VL.TEST has been successfully removed after rollback.');
    console.log(`Current patch history length: ${rolledBackEstimate.patchHistory?.length ?? 0}`);

    // 7. Xóa estimate test
    console.log('6. Cleaning up test estimate...');
    await request(baseUrl, `/estimates/${estimateId}`, 'DELETE', null, token);
    console.log('Test estimate cleaned up.');

    console.log('\n======================================');
    console.log('🎉 API TEST SUCCESSFUL! ALL TESTS PASSED.');
    console.log('======================================');

  } catch (testErr) {
    console.error('\n❌ TEST FAILED:', testErr.message);
    process.exit(1);
  }
}

runTests();
