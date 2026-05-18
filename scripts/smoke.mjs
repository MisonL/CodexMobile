const url = process.env.CODEXMOBILE_URL || 'http://127.0.0.1:3321/api/status';
const timeoutMs = Number(process.env.CODEXMOBILE_SMOKE_TIMEOUT_MS || 15000);

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const response = await fetch(url);
      const data = await response.json();
      if (!response.ok || !data.connected) {
        console.error('Smoke failed:', response.status, data);
        process.exit(1);
      }
      console.log(`Smoke ok: ${data.hostName} ${data.provider}/${data.model} synced=${data.syncedAt}`);
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  console.error(`Smoke failed: ${lastError?.message || 'timeout'}`);
  process.exit(1);
}

main();
