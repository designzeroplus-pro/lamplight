/* AI for export: reshape a note with Claude (API key) or ChatGPT (chatgpt.js).
 *
 * The API key is entered by the user in the app and stored with Electron's
 * safeStorage (encrypted with a key held in the macOS Keychain). Without a
 * stored key the SDK's own credential lookup is used (ANTHROPIC_API_KEY or an
 * `ant auth login` profile), which is handy in development. */
const { app, ipcMain, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const sdk = require('@anthropic-ai/sdk');
const gpt = require('./chatgpt');

const Anthropic = sdk.Anthropic || sdk.default || sdk;
const MODEL = 'claude-opus-5-5';

const keyFile = () => path.join(app.getPath('userData'), 'anthropic-key.bin');

async function readStoredKey() {
  try {
    const buf = await fs.readFile(keyFile());
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

async function keyStatus() {
  const stored = await readStoredKey();
  if (stored) return { hasKey: true, source: 'stored', hint: `…${stored.slice(-4)}` };
  if (process.env.ANTHROPIC_API_KEY) return { hasKey: true, source: 'env', hint: '환경 변수' };
  return { hasKey: false, source: null, hint: '' };
}

const SYSTEM = `당신은 필기를 깔끔한 문서로 다듬는 편집자입니다. 결과는 Markdown으로만 쓰고, 노트에 없는 사실은 만들지 않습니다.`;

let running = null; // the active MessageStream, so it can be cancelled

/* The same request on the person's ChatGPT plan (see chatgpt.js). */
async function generateWithChatGPT(system, prompt, send) {
  const ctrl = new AbortController();
  running = { abort: () => ctrl.abort() };
  try {
    const out = await gpt.stream({
      system,
      prompt,
      signal: ctrl.signal,
      onText: (text) => send({ type: 'delta', text }),
    });
    send({ type: 'done', stopReason: out.stopReason, model: out.model });
    return true;
  } catch (err) {
    const code = err.name === 'AbortError' ? 'aborted'
      : err instanceof gpt.GptError ? ({ limit: 'gpt-limit', unavailable: 'gpt-unavailable', login: 'gpt-login', token: 'gpt-login' }[err.code] || err.code)
      : /fetch failed|ENOTFOUND|ECONN/i.test(String(err?.message || err?.cause)) ? 'network'
      : 'error';
    console.error('[ai/chatgpt]', code, err?.message);
    send({ type: 'error', code, message: String(err?.message || err) });
    return false;
  } finally {
    running = null;
  }
}

function register() {
  ipcMain.handle('ai:key-status', keyStatus);

  ipcMain.handle('ai:key-set', async (_e, key) => {
    const k = String(key || '').trim();
    if (!/^sk-ant-[\w-]{20,}$/.test(k)) throw new Error('invalid key format');
    if (!safeStorage.isEncryptionAvailable()) throw new Error('secure storage unavailable');
    await fs.writeFile(keyFile(), safeStorage.encryptString(k), { mode: 0o600 });
    return keyStatus();
  });

  ipcMain.handle('ai:key-clear', async () => {
    await fs.rm(keyFile(), { force: true });
    return keyStatus();
  });

  ipcMain.handle('ai:cancel', () => {
    running?.abort();
    return true;
  });

  // Streams a generated document back as `ai:event` messages: delta / done / error.
  // The renderer supplies the instructions (system) and the request with the note (prompt).
  ipcMain.handle('ai:generate', async (e, job) => {
    if (running) return false;
    const send = (ev) => { if (!e.sender.isDestroyed()) e.sender.send('ai:event', ev); };
    const system = String(job.system || SYSTEM);
    const prompt = String(job.prompt || '');

    if (job.provider === 'chatgpt') return generateWithChatGPT(system, prompt, send);

    const stored = await readStoredKey();
    const client = new Anthropic(stored ? { apiKey: stored } : {});
    try {
      const stream = client.beta.messages.stream({
        model: MODEL,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        // On a safety decline, rerun on Anthropic's recommended fallback model.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      running = stream;
      stream.on('error', () => {}); // surfaced through finalMessage() below
      stream.on('text', (text) => send({ type: 'delta', text }));
      const message = await stream.finalMessage();
      send({ type: 'done', stopReason: message.stop_reason, model: message.model });
      return true;
    } catch (err) {
      let code = 'error';
      if (err instanceof Anthropic.APIUserAbortError) code = 'aborted';
      else if (err instanceof Anthropic.AuthenticationError) code = 'auth';
      else if (err instanceof Anthropic.PermissionDeniedError) code = 'auth';
      else if (err instanceof Anthropic.RateLimitError) code = 'rate';
      else if (err instanceof Anthropic.APIConnectionError) code = 'network';
      else if (err instanceof Anthropic.APIError) code = err.status >= 500 ? 'server' : 'request';
      else if (/api[_ ]?key|credential|auth/i.test(String(err?.message))) code = 'auth';
      console.error('[ai]', code, err?.message);
      send({ type: 'error', code, message: String(err?.message || err) });
      return false;
    } finally {
      running = null;
    }
  });
}

module.exports = { register };
