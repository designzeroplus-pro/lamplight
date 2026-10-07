/* Sign in with ChatGPT — use the person's ChatGPT Plus/Pro plan for summaries.
 *
 * Follows OpenAI's flow for open-source / locally run apps:
 *   1. Open the browser at the authorize endpoint (PKCE, state, nonce). The
 *      first sign-in uses client_id=dynamic_agent_client; OpenAI registers
 *      the app and returns the issued client_id to our loopback callback.
 *   2. Exchange the code at the token endpoint (no client secret).
 *   3. Call the Responses API with the access token (store:false, stream:true).
 * Access tokens last an hour and are refreshed with the 30-day refresh token.
 * Tokens are encrypted with safeStorage (macOS Keychain) in chatgpt.bin.
 *
 * Docs: https://developers.openai.com/siwc/token-sharing-open-source */
const { app, ipcMain, safeStorage, shell } = require('electron');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');

const AUTH = 'https://auth.openai.com';
const API = 'https://api.openai.com/v1';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PREFERRED_PORT = 1456;
const SIGN_IN_TIMEOUT = 5 * 60 * 1000;

const credFile = () => path.join(app.getPath('userData'), 'chatgpt.bin');
const hostFile = () => path.join(app.getPath('userData'), 'chatgpt-host.json');

class GptError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const decodeJwt = (t) => JSON.parse(Buffer.from(String(t).split('.')[1] || '', 'base64url').toString('utf8'));

async function loadCreds() {
  try {
    return JSON.parse(safeStorage.decryptString(await fs.readFile(credFile())));
  } catch {
    return null;
  }
}

async function saveCreds(creds) {
  const file = credFile();
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, safeStorage.encryptString(JSON.stringify(creds)), { mode: 0o600 });
  await fs.rename(tmp, file);
}

// A stable identifier for this Mac's installation (ext_agent_host_id).
async function hostId() {
  try {
    const { id } = JSON.parse(await fs.readFile(hostFile(), 'utf8'));
    if (id) return id;
  } catch {}
  const id = `urn:uuid:${crypto.randomUUID()}`;
  await fs.writeFile(hostFile(), JSON.stringify({ id }), { mode: 0o600 });
  return id;
}

async function tokenRequest(form) {
  const res = await globalThis.fetch(`${AUTH}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GptError(body.error === 'invalid_grant' ? 'login' : 'token', body.error_description || body.error || `HTTP ${res.status}`);
  return body;
}

function withTokens(creds, tok) {
  const now = Date.now();
  return {
    ...creds,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token || creds.refreshToken,
    expiresAt: now + (Number(tok.expires_in) || 3600) * 1000,
    earliestRefreshAt: tok.earliest_refresh_at ? Number(tok.earliest_refresh_at) * 1000 : 0,
    scope: tok.scope || creds.scope,
    idToken: tok.id_token || creds.idToken,
  };
}

/* ───────── sign in ───────── */

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && port !== 0) resolve(listen(0));
      else reject(err);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const PAGE = (title, text) => `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Lamplight</title>
<style>body{margin:0;height:100vh;display:grid;place-items:center;background:#0e0d0c;color:#e9e3d8;font:15px -apple-system,'Apple SD Gothic Neo',sans-serif}
div{text-align:center}h1{font-size:19px;font-weight:600;margin:0 0 8px}p{margin:0;color:#9a9286}i{display:block;width:10px;height:10px;margin:0 auto 18px;border-radius:50%;background:#e3a566;box-shadow:0 0 18px 4px rgba(227,165,102,.55)}</style>
<div><i></i><h1>${title}</h1><p>${text}</p></div></html>`;

let signingIn = null;

async function signIn() {
  if (signingIn) return signingIn;
  signingIn = (async () => {
    const prev = await loadCreds();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));
    const nonce = b64url(crypto.randomBytes(16));

    // Reuse the issued client (and its redirect URI) when we can; otherwise register anew.
    const { server, port } = await listen(prev?.port || PREFERRED_PORT);
    const reuse = !!(prev?.clientId && prev.port === port);
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const params = new URLSearchParams({
      client_id: reuse ? prev.clientId : 'dynamic_agent_client',
      agent_name_hint: 'Lamplight',
      ext_agent_host_id: await hostId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    if (reuse && prev.idToken) params.set('id_token_hint', prev.idToken);

    const callback = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new GptError('timeout', 'sign-in timed out')), SIGN_IN_TIMEOUT);
      server.on('request', (req, res) => {
        const url = new URL(req.url, redirectUri);
        if (url.pathname !== '/auth/callback') { res.writeHead(404).end(); return; }
        const q = Object.fromEntries(url.searchParams);
        const ok = !q.error && q.state === state && q.code;
        res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(ok
          ? PAGE('ChatGPT에 연결했어요', 'Lamplight로 돌아가셔도 돼요. 이 창은 닫아도 됩니다.')
          : PAGE('연결하지 못했어요', 'Lamplight에서 다시 시도해 주세요.'));
        clearTimeout(timer);
        if (q.error) reject(new GptError(q.error === 'access_denied' ? 'denied' : 'auth', q.error_description || q.error));
        else if (q.state !== state) reject(new GptError('state', 'state mismatch'));
        else if (!q.code) reject(new GptError('auth', 'no authorization code'));
        else resolve(q);
      });
    });

    try {
      await shell.openExternal(`${AUTH}/api/accounts/authorize?${params}`);
      const q = await callback;
      const clientId = q.client_id || (reuse ? prev.clientId : null);
      if (!clientId) throw new GptError('auth', 'no client_id returned');
      const tok = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: q.code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      });

      // The ID token came straight from the token endpoint over TLS, so its
      // claims are checked rather than its signature (OIDC Core 3.1.3.7).
      const claims = decodeJwt(tok.id_token);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.nonce !== nonce) throw new GptError('auth', 'nonce mismatch');
      if (claims.iss !== AUTH) throw new GptError('auth', 'unexpected issuer');
      if (!aud.includes(clientId)) throw new GptError('auth', 'unexpected audience');
      if (claims.exp && claims.exp * 1000 < Date.now() - 300000) throw new GptError('auth', 'id token expired');

      const scopes = String(tok.scope || '').split(/\s+/);
      if (!scopes.includes('chatgpt.tokens.use.direct')) throw new GptError('unavailable', 'plan usage was not granted');

      const creds = withTokens({
        clientId,
        port,
        sub: claims.sub,
        email: claims.email || '',
        name: claims.name || '',
        model: prev?.sub === claims.sub ? prev.model : null,
      }, tok);
      await saveCreds(creds);
      return status(creds);
    } finally {
      server.close();
    }
  })();
  try {
    return await signingIn;
  } finally {
    signingIn = null;
  }
}

async function signOut() {
  const creds = await loadCreds();
  // Keep the registered client so the next sign-in can reuse it; drop the tokens.
  if (creds) await saveCreds({ clientId: creds.clientId, port: creds.port });
  return { signedIn: false };
}

function status(creds) {
  if (!creds?.refreshToken) return { signedIn: false };
  return { signedIn: true, email: creds.email, name: creds.name, model: creds.model || null };
}

// A valid access token, refreshing it when it's about to expire.
async function ensureAccess(force = false) {
  const creds = await loadCreds();
  if (!creds?.refreshToken) throw new GptError('login', 'not signed in');
  const now = Date.now();
  if (!force && creds.expiresAt - 60000 > now) return creds;
  if (!force && creds.earliestRefreshAt && now < creds.earliestRefreshAt && creds.expiresAt > now) return creds;
  try {
    const tok = await tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
      resource: RESOURCE,
    });
    const next = withTokens(creds, tok);
    await saveCreds(next);
    return next;
  } catch (err) {
    if (err.code === 'login') await signOut();
    throw err;
  }
}

async function api(pathname, init = {}, retried = false) {
  const creds = await ensureAccess();
  const res = await globalThis.fetch(`${API}${pathname}`, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${creds.accessToken}` },
  });
  if (res.status === 401 && !retried) {
    await ensureAccess(true);
    return api(pathname, init, true);
  }
  return res;
}

async function apiError(res) {
  const body = await res.json().catch(() => ({}));
  const code = body?.error?.code || body?.code || '';
  if (code === 'subscription_sharing_usage_limit_exceeded') return new GptError('limit', body.error.message);
  if (code === 'subscription_sharing_usage_unavailable') return new GptError('unavailable', body.error.message);
  if (res.status === 401 || res.status === 403) return new GptError('login', body?.error?.message);
  if (res.status === 429) return new GptError('rate', body?.error?.message);
  return new GptError(res.status >= 500 ? 'server' : 'request', body?.error?.message || `HTTP ${res.status}`);
}

/* The account's model catalog: only models marked visibility "list" are offered. */
async function listModels() {
  const res = await api('/models');
  if (!res.ok) throw await apiError(res);
  const body = await res.json();
  const items = body.data || body.models || [];
  return items
    .filter((m) => (m.visibility ?? 'list') === 'list')
    .map((m) => ({ slug: m.slug || m.id, name: m.display_name || m.slug || m.id }));
}

async function setModel(slug) {
  const creds = await loadCreds();
  if (creds) await saveCreds({ ...creds, model: slug });
  return status({ ...creds, model: slug });
}

/* Streams a response: onText(delta) per chunk. Resolves with { stopReason, model }. */
async function stream({ system, prompt, onText, signal }) {
  const creds = await ensureAccess();
  let model = creds.model;
  if (!model) {
    model = (await listModels())[0]?.slug;
    if (!model) throw new GptError('unavailable', 'no models available for this account');
    await setModel(model);
  }
  const res = await api('/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model,
      store: false,
      stream: true,
      input: [
        { role: 'developer', content: system },
        { role: 'user', content: prompt },
      ],
    }),
    signal,
  });
  if (!res.ok) throw await apiError(res);

  // Server-sent events: blank-line separated blocks of "event:" / "data:" lines.
  const decoder = new TextDecoder();
  let buf = '';
  let outcome = null;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      if (ev.type === 'response.output_text.delta' && ev.delta) onText(ev.delta);
      else if (ev.type === 'response.completed') outcome = { stopReason: 'end_turn', model };
      else if (ev.type === 'response.incomplete') outcome = { stopReason: 'max_tokens', model };
      else if (ev.type === 'response.failed' || ev.type === 'error') {
        const code = ev.response?.error?.code || ev.error?.code || ev.code || '';
        if (code === 'subscription_sharing_usage_limit_exceeded') throw new GptError('limit');
        if (code === 'subscription_sharing_usage_unavailable') throw new GptError('unavailable');
        throw new GptError('server', ev.response?.error?.message || ev.message || 'response failed');
      }
    }
  }
  // Only a response.completed (or incomplete) counts; a cut-off stream is an error.
  if (!outcome) throw new GptError('server', 'stream ended before the response completed');
  return outcome;
}

function register() {
  ipcMain.handle('gpt:status', async () => status(await loadCreds()));
  ipcMain.handle('gpt:signin', async () => {
    try {
      return await signIn();
    } catch (err) {
      return { signedIn: false, error: err.code || 'auth', message: err.message };
    }
  });
  ipcMain.handle('gpt:signout', signOut);
  ipcMain.handle('gpt:models', async () => {
    try {
      return { models: await listModels() };
    } catch (err) {
      return { models: [], error: err.code || 'request' };
    }
  });
  ipcMain.handle('gpt:set-model', (_e, slug) => setModel(String(slug || '')));
}

module.exports = { register, stream, GptError };
