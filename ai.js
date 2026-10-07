/* Meeting summaries with Claude.
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

const SYSTEM = `당신은 회의록 정리 도우미입니다. 사용자가 회의 제목, 참석자, 그리고 회의 중 직접 쓴 메모와 음성 받아쓰기 내용을 줍니다.
받아쓰기 줄은 [mm:ss] 타임스탬프로 시작하며 인식 오류가 섞여 있을 수 있습니다.

결과는 타자기로 종이에 찍히는 일반 텍스트입니다. 마크다운 기호(#, **, 표)는 쓰지 말고 아래 형식을 그대로 따르세요.

요약
- 회의의 핵심을 3~5개 항목으로

결정 사항
1. 회의에서 확정된 것만

할 일
- [ ] 담당자: 할 일 (기한이 언급됐다면 함께)

규칙:
- 한국어로, 짧고 분명하게 씁니다.
- 회의 내용에 없는 사실은 만들지 않습니다. 결정 사항이나 할 일이 없으면 그 아래에 "없음"이라고 씁니다.
- 담당자를 알 수 없으면 "담당 미정"이라고 씁니다.
- 특정 발언에서 나온 항목이면 끝에 해당 타임스탬프를 [mm:ss] 형식으로 붙입니다.
- 형식 외의 인사말이나 설명은 쓰지 않습니다.`;

let running = null; // the active MessageStream, so it can be cancelled

/* The same summary on the person's ChatGPT plan (see chatgpt.js). */
async function summarizeWithChatGPT(prompt, send) {
  const ctrl = new AbortController();
  running = { abort: () => ctrl.abort() };
  try {
    const out = await gpt.stream({
      system: SYSTEM,
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

  // Streams the summary back as `ai:event` messages: delta / done / error.
  ipcMain.handle('ai:summarize', async (e, note) => {
    if (running) return false;
    const send = (ev) => { if (!e.sender.isDestroyed()) e.sender.send('ai:event', ev); };
    const prompt = [
      `회의 제목: ${note.title || '(제목 없음)'}`,
      `일시: ${note.date || ''}`,
      `참석자: ${note.attendees || '(기록 없음)'}`,
      '',
      '회의 내용:',
      note.body,
    ].join('\n');

    if (note.provider === 'chatgpt') return summarizeWithChatGPT(prompt, send);

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
        system: SYSTEM,
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
