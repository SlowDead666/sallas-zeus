import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, createStore } from './storage.mjs';
import { createProcessor, parseUserAgent, normalizePayload, findProfile, createNstClient, navigateCdp, AppError } from './core.mjs';
import { startServer, validateSettings } from './server.mjs';

/** Fixtures exclusivamente sintéticas; nenhum teste usa o cliente NST real. */
const settings = { ...defaults, apiKey: 'fake-nst-key', webhookToken: 'fake-webhook-key' };
const payload = { number: '00123', tipo: 'normal', proxy: '', user_agent: '!{"user_agent":"Mozilla/5.0 (Linux; Android 13) Chrome/140.0 Mobile"}', url: 'https://example.com/' };

/** Simula operações NST com histórico para verificar ordem e ausência de efeitos proibidos. */
function fixture({ profiles = [], running = false, failCreate = false } = {}) {
  const calls = [], navigations = [];
  const client = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path.startsWith('/profiles/cursor?')) return { docs: profiles };
    if (path === '/browsers') return running ? [{ profileId: 'old', running: true, webSocketDebuggerUrl: 'ws://mock/browser' }] : [];
    if (path === '/browsers/old' && method === 'DELETE') { running = false; return {}; }
    if (path === '/profiles/old' && method === 'DELETE') return {};
    if (path === '/profiles' && method === 'POST') {
      if (failCreate) throw new AppError(502, 'Falha simulada');
      return { profileId: 'new' };
    }
    if (path.startsWith('/browsers/') && method === 'POST') return { webSocketDebuggerUrl: 'ws://mock/browser' };
    throw new Error(`Chamada inesperada: ${method} ${path}`);
  };
  return { calls, navigations, process: createProcessor({ clientFactory: () => client, navigate: async (...args) => { navigations.push(args); }, wait: async () => {} }) };
}

test('UA aceita objeto, texto e JSON com !, preservando o conteúdo', () => {
  const ua = 'Mozilla/5.0 (iPhone) Safari/604.1';
  for (const value of [ua, { user_agent: ua }, JSON.stringify({ user_agent: ua }), `!${JSON.stringify({ user_agent: ua })}`]) assert.equal(parseUserAgent(value), ua);
  for (const value of ['', '!{bad}', {}, null, 'ua\r\nInjected']) assert.throws(() => parseUserAgent(value), AppError);
});

test('validação rejeita number numérico, tipo e URL inválidos antes de mutações', async () => {
  const mock = fixture();
  for (const body of [{ ...payload, number: 123 }, { ...payload, tipo: 'outro' }, { ...payload, url: 'javascript:alert(1)' }, { ...payload, proxy: 'bad' }, { ...payload, user_agent: '' }]) await assert.rejects(mock.process(body, settings), AppError);
  assert.equal(mock.calls.length, 0);
});

test('normal novo: nome literal, residencial NST, UA exato e URL inicial', async () => {
  const mock = fixture();
  const result = await mock.process(payload, settings);
  const created = mock.calls.find(call => call.path === '/profiles').body;
  assert.equal(result.action, 'created');
  assert.equal(created.name, '00123');
  assert.equal(created.fingerprint.userAgent, parseUserAgent(payload.user_agent));
  assert.equal(created.platform, undefined);
  assert.equal(created.platformVersion, undefined);
  assert.deepEqual(created.startupUrls, [payload.url]);
  assert.deepEqual(created.builtinProxy, { type: 'residential', country: 'BR', sessionDuration: 10, protocol: 'http' });
  assert.equal(mock.calls.at(-1).path, '/browsers/new');
});

test('fingerprint completo é repassado íntegro; userAgent do fingerprint tem prioridade', async () => {
  const mock = fixture();
  const fingerprint = {
    userAgent: 'Mozilla/5.0 (iPhone) Safari/604.1', deviceMemory: 8, hardwareConcurrency: 8,
    disableImageLoading: false, doNotTrack: true, restoreLastSession: true,
    flags: { canvas: 'Noise', webgl: 'Noise', localization: 'Custom', timezone: 'BasedOnIp', webrtc: 'Masked', geolocation: 'Custom' },
    fonts: ['Arial', 'Helvetica'], localization: { locale: 'pt-BR', languages: ['pt-BR', 'pt'], basedOnProxy: true },
    screen: { width: 430, height: 932 }, geolocation: { latitude: '-22.80', longitude: '-43.37', accuracy: '100' },
    webrtc: { publicIp: '177.1.2.3', localIps: ['192.168.1.2'], devicesLabels: ['Mic'] },
  };
  await mock.process({ ...payload, user_agent: 'UA-IGNORADO', fingerprint, platform: 'macOS', platformVersion: '15.0.0', kernelMilestone: '140', groupName: 'Default', note: 'nota' }, settings);
  const created = mock.calls.find(call => call.path === '/profiles').body;
  assert.deepEqual(created.fingerprint, fingerprint);
  assert.equal(created.platform, 'macOS');
  assert.equal(created.platformVersion, '15.0.0');
  assert.equal(created.kernelMilestone, '140');
  assert.equal(created.groupName, 'Default');
  assert.equal(created.note, 'nota');
});

test('user_agent solto vira fingerprint.userAgent quando fingerprint não vem', async () => {
  const mock = fixture();
  await mock.process({ ...payload, fingerprint: { screen: { width: 393, height: 873 } } }, settings);
  const created = mock.calls.find(call => call.path === '/profiles').body;
  assert.equal(created.fingerprint.userAgent, parseUserAgent(payload.user_agent));
  assert.deepEqual(created.fingerprint.screen, { width: 393, height: 873 });
});

test('webhook sem fingerprint nem user_agent é rejeitado (retrocompatibilidade)', async () => {
  const mock = fixture();
  await assert.rejects(mock.process({ number: 'x', tipo: 'normal', url: payload.url, proxy: '' }, settings), error => error.status === 400);
});

test('chaves desconhecidas e valores inválidos no fingerprint são rejeitados com a chave culpada', async () => {
  const cases = [
    [{ fingerprint: { hacker: 1 } }, 'hacker'],
    [{ fingerprint: { flags: { teleport: 'Real' } } }, 'teleport'],
    [{ fingerprint: { flags: { canvas: 'On' } } }, 'canvas'],
    [{ fingerprint: { deviceMemory: 16 } }, 'deviceMemory'],
    [{ fingerprint: { hardwareConcurrency: 3 } }, 'hardwareConcurrency'],
    [{ fingerprint: { screen: { width: 100 } } }, 'width e height'],
    [{ fingerprint: { screen: { width: '100', height: 100 } } }, 'screen'],
    [{ fingerprint: { geolocation: { latitude: '99' } } }, 'latitude'],
    [{ fingerprint: { geolocation: { deep: {} } } }, 'deep'],
    [{ fingerprint: { localization: { charset: 'utf8' } } }, 'charset'],
    [{ fingerprint: { webrtc: { nat: true } } }, 'nat'],
    [{ platform: 'Linux' }, 'Linux'],
    [{ platform: 'macOS' }, 'platformVersion'],
    [{ platformVersion: '15.0.0' }, 'sem platform'],
    [{ platform: 'BeOS', platformVersion: '5' }, 'platform'],
    [{ kernelMilestone: 'abc' }, 'kernelMilestone'],
    [{ kernelMilestone: '15' }, 'kernelMilestone'],
  ];
  for (const [patch, expected] of cases) {
    const mock = fixture();
    await assert.rejects(mock.process({ ...payload, ...patch }, settings), error => error.status === 400 && error.message.includes(expected), `caso ${expected}`);
  }
});

test('userAgentFromWebhook desligado ignora fingerprint do webhook', async () => {
  const mock = fixture();
  await mock.process({ ...payload, fingerprint: { userAgent: 'X' } }, { ...settings, userAgentFromWebhook: false });
  const created = mock.calls.find(call => call.path === '/profiles').body;
  assert.equal(created.fingerprint, undefined);
});

test('fechar para navegador sem excluir perfil e dispensa url/UA', async () => {
  const mock = fixture({ profiles: [{ name: '00123', profileId: 'old' }], running: true });
  const result = await mock.process({ number: '00123', tipo: 'fechar' }, settings);
  assert.equal(result.action, 'stopped');
  assert.deepEqual(mock.calls.map(c => `${c.method} ${c.path}`), ['GET /profiles/cursor?s=00123&pageSize=100', 'GET /browsers', 'DELETE /browsers/old']);
});

test('fechar perfil parado informa already_stopped e inexistente dá 404', async () => {
  const stopped = fixture({ profiles: [{ name: '00123', profileId: 'old' }], running: false });
  assert.equal((await stopped.process({ number: '00123', tipo: 'fechar' }, settings)).action, 'already_stopped');
  const missing = fixture();
  await assert.rejects(missing.process({ number: '00123', tipo: 'fechar' }, settings), error => error.status === 404);
});

test('retentativa ignora fingerprint/platform no payload', async () => {
  const mock = fixture({ profiles: [{ name: '00123', profileId: 'old' }], running: true });
  await mock.process({ number: payload.number, tipo: 'retentativa', url: payload.url, fingerprint: { userAgent: 'X' }, platform: 'macOS' }, settings);
  assert.equal(mock.calls.some(call => call.path === '/profiles' && call.method === 'POST'), false);
});

test('proxy explícito do webhook não inclui builtinProxy', async () => {
  const mock = fixture();
  await mock.process({ ...payload, proxy: 'http://user:pass@127.0.0.1:8080' }, settings);
  const created = mock.calls.find(call => call.path === '/profiles').body;
  assert.equal(created.proxy, 'http://user:pass@127.0.0.1:8080');
  assert.equal(created.builtinProxy, undefined);
});

test('seletores desligados ignoram webhook e deixam NST gerar UA/fingerprint', async () => {
  const mock = fixture();
  await mock.process({ number: payload.number, tipo: 'bad', proxy: 'bad', user_agent: 'bad', url: 'bad' }, { ...settings, proxyFromWebhook: false, userAgentFromWebhook: false, urlFromWebhook: false, tipoFromWebhook: false, defaultUrl: payload.url });
  const created = mock.calls.find(call => call.path === '/profiles').body;
  assert.equal(created.proxy, undefined);
  assert.equal(created.builtinProxy.type, 'residential');
  assert.equal(created.fingerprint, undefined);
  assert.deepEqual(created.startupUrls, [payload.url]);
});

test('normal existente: fecha, confirma parada, exclui, cria e abre nessa ordem', async () => {
  const mock = fixture({ profiles: [{ name: '00123', profileId: 'old' }], running: true });
  assert.equal((await mock.process(payload, settings)).action, 'recreated');
  assert.deepEqual(mock.calls.slice(1).map(call => `${call.method} ${call.path}`), ['GET /browsers', 'DELETE /browsers/old', 'GET /browsers', 'DELETE /profiles/old', 'POST /profiles', 'POST /browsers/new']);
});

test('busca parcial nunca exclui outro perfil', async () => {
  const mock = fixture({ profiles: [{ name: '001234', profileId: 'old' }] });
  await mock.process(payload, settings);
  assert.equal(mock.calls.some(call => call.method === 'DELETE'), false);
});

test('retentativa preserva perfil, proxy e UA e navega sem recriar', async () => {
  for (const running of [true, false]) {
    const mock = fixture({ profiles: [{ name: '00123', profileId: 'old' }], running });
    const result = await mock.process({ number: payload.number, tipo: 'retentativa', url: payload.url, proxy: 'ignorado', user_agent: null }, settings);
    assert.equal(result.profileId, 'old');
    assert.equal(result.action, 'reused');
    assert.equal(mock.calls.some(call => call.method === 'DELETE' || call.path === '/profiles'), false);
    assert.deepEqual(mock.navigations, [['ws://mock/browser', payload.url]]);
  }
});

test('retentativa inexistente e duplicidade não criam/excluem perfis', async () => {
  const missing = fixture();
  await assert.rejects(missing.process({ ...payload, tipo: 'retentativa' }, settings), error => error.status === 404);
  const duplicate = fixture({ profiles: [{ name: '00123', profileId: 'a' }, { name: '00123', profileId: 'b' }] });
  await assert.rejects(duplicate.process(payload, settings), error => error.status === 409);
  assert.equal(duplicate.calls.length, 1);
});

test('paginação encontra correspondência exata em página posterior e detecta cursor repetido', async () => {
  let count = 0;
  const profile = await findProfile(async path => {
    count++;
    if (count === 1) return { docs: [], nextCursor: 'next' };
    assert.match(path, /cursor=next/);
    return { docs: [{ name: '00123', profileId: 'old' }] };
  }, '00123');
  assert.equal(profile.profileId, 'old');
  await assert.rejects(findProfile(async () => ({ docs: [], nextCursor: 'loop' }), '00123'), AppError);
});

test('requisições simultâneas do mesmo number são rejeitadas e lock é liberado', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const process = createProcessor({ clientFactory: () => async () => { await gate; throw new AppError(502, 'falha'); } });
  const first = process(payload, settings);
  await assert.rejects(process(payload, settings), error => error.status === 409);
  release();
  await assert.rejects(first, error => error.status === 502);
  await assert.rejects(process(payload, settings), error => error.status === 502);
});

test('falha após exclusão identifica etapa e não repete automaticamente a criação', async () => {
  const mock = fixture({ profiles: [{ name: '00123', profileId: 'old' }], failCreate: true });
  await assert.rejects(mock.process(payload, settings), error => /criar novo perfil/.test(error.message));
  assert.equal(mock.calls.filter(call => call.path === '/profiles').length, 1);
});

test('configuração valida booleanos, URL e mantém token quando campo vazio', () => {
  assert.equal(validateSettings({ ...settings, apiKey: '' }, settings).apiKey, settings.apiKey);
  for (const patch of [{ proxyFromWebhook: 'true' }, { country: 'Brasil' }, { sessionDuration: 0 }, { urlFromWebhook: false, defaultUrl: '' }, { baseUrl: 'file:///tmp' }]) assert.throws(() => validateSettings({ ...settings, ...patch }, settings), AppError);
  assert.equal(normalizePayload({ number: '01', tipo: 'retentativa', url: payload.url }, settings).number, '01');
  assert.equal(normalizePayload({ ...payload, proxy: 'http://proxy.example:80' }, settings).proxy, 'http://proxy.example:80');
  assert.equal(normalizePayload({ ...payload, proxy: 'https://proxy.example:443' }, settings).proxy, 'https://proxy.example:443');
  assert.throws(() => normalizePayload({ ...payload, proxy: 'socks5://proxy.example' }, settings), AppError);
});

test('configuração cifrada persiste sem escrever token em texto puro', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sallas-test-'));
  try {
    const store = await createStore(directory);
    const token = store.get().webhookToken;
    await store.set({ ...store.get(), apiKey: 'synthetic-secret' });
    assert.equal((await readFile(join(directory, 'settings.enc'))).includes(Buffer.from('synthetic-secret')), false);
    const reopened = await createStore(directory);
    assert.equal(reopened.get().apiKey, 'synthetic-secret');
    assert.equal(reopened.get().webhookToken, token);
  } finally { await rm(directory, { recursive: true }); }
});

test('HTTP real: config, credencial oculta, CSRF, webhook autenticado e contrato completo', async () => {
  let saved = { ...settings };
  const mock = fixture();
  const server = await startServer({ port: 0, store: { get: () => ({ ...saved }), set: async next => { saved = next; } }, process: mock.process });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/config`)).status, 200);
    assert.equal((await fetch(`${base}/config.js`)).status, 200);
    const config = await (await fetch(`${base}/api/config`)).json();
    assert.equal(config.apiKey, undefined);
    assert.equal(config.apiKeyConfigured, true);
    assert.equal((await fetch(`${base}/api/config`, { headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })).status, 401);
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${settings.webhookToken}` };
    const result = await fetch(`${base}/webhook`, { method: 'POST', headers, body: JSON.stringify(payload) });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).action, 'created');
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', headers, body: '{bad' })).status, 400);
    assert.equal((await fetch(`${base}/api/config`, { method: 'PUT', headers, body: JSON.stringify({ ...settings, apiKey: '' }) })).status, 200);
    assert.equal(saved.apiKey, settings.apiKey);
    const rejectedHost = await new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/config`, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject);
    });
    assert.equal(rejectedHost, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('túnel público libera apenas webhook POST autenticado e bloqueia configuração mesmo com Host reescrito', async () => {
  let calls = 0;
  const server = await startServer({ port: 0, store: { get: () => ({ ...settings }) }, process: async () => { calls++; return { ok: true }; } });
  /** Envia Host real via HTTP nativo; fetch substitui esse cabeçalho em algumas versões. */
  async function request(path, { host = 'pineal-transplanetary-lorretta.ngrok-free.dev', method = 'GET', headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: { host, ...headers } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject);
      req.end(method === 'POST' ? '{}' : undefined);
    });
  }
  try {
    for (const path of ['/config', '/config.js', '/api/config', '/api/config/test', '/']) assert.equal(await request(path), 403);
    assert.equal(await request('/webhook'), 405);
    assert.equal(await request('/webhook', { method: 'POST' }), 401);
    assert.equal(await request('/webhook', { method: 'POST', headers: { authorization: 'Bearer wrong' } }), 401);
    assert.equal(await request('/webhook', { host: 'evil.example', method: 'POST' }), 403);
    assert.equal(await request('/api/config', { host: `localhost:${server.address().port}`, headers: { 'x-forwarded-for': '203.0.113.1' } }), 403);
    assert.equal(await request('/api/config', { host: `localhost:${server.address().port}`, headers: { forwarded: 'for=203.0.113.1' } }), 403);
    assert.equal(await request('/webhook', { method: 'POST', headers: { authorization: `Bearer ${settings.webhookToken}`, 'content-type': 'application/json', 'x-forwarded-proto': 'https' } }), 200);
    assert.equal(calls, 1);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('cliente NST envia x-api-key e sanitiza mensagens de erro do upstream', async () => {
  let fail = false;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-api-key'], settings.apiKey);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fail ? { err: true, msg: 'sensitive proxy password' } : { err: false, data: { docs: [] } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const client = createNstClient({ ...settings, baseUrl: `http://127.0.0.1:${server.address().port}` });
    assert.deepEqual(await client('/profiles/cursor'), { docs: [] });
    fail = true;
    await assert.rejects(client('/profiles'), error => error.status === 502 && !error.message.includes('sensitive'));
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('CDP abre aba e desconecta sem comando Browser.close', async () => {
  const original = globalThis.WebSocket;
  const sent = [];
  /** WebSocket sintético reproduz somente a confirmação CDP da aba criada. */
  class FakeSocket extends EventTarget {
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(data) { sent.push(JSON.parse(data)); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: '{"id":1,"result":{"targetId":"page"}}' }))); }
    close() { queueMicrotask(() => this.dispatchEvent(new Event('close'))); }
  }
  globalThis.WebSocket = FakeSocket;
  try { await navigateCdp('ws://mock/browser', payload.url); }
  finally { globalThis.WebSocket = original; }
  assert.deepEqual(sent, [{ id: 1, method: 'Target.createTarget', params: { url: payload.url } }]);
});

// ---------------------------------------------------------------------------
// bot.mjs — funções puras de jitter/cadência (driver CDP não é testado aqui;
// exigiria navegador real, o que é proibido para testes automatizados).
// ---------------------------------------------------------------------------

import { jitter, intervaloTecla, JITTER, SELETORES_PADRAO } from './bot.mjs';

test('jitter mantém valores dentro da margem ±5%', () => {
  for (let i = 0; i < 200; i++) {
    const v = jitter(1000);
    assert.ok(v >= 950 && v <= 1050, `fora da margem: ${v}`);
  }
});

test('jitter nunca retorna negativo e preserva zero', () => {
  assert.equal(jitter(0), 0);
  for (let i = 0; i < 50; i++) assert.ok(jitter(1) >= 0);
});

test('intervaloTecla respeita piso de 45ms e varia', () => {
  const amostras = new Set();
  for (let i = 0; i < 50; i++) {
    const v = intervaloTecla(160, 50);
    assert.ok(v >= 45, `abaixo do piso: ${v}`);
    amostras.add(v);
  }
  assert.ok(amostras.size > 10, 'cadência quase constante — uniformidade suspeita');
});

test('intervaloTecla com média alta produz valores maiores', () => {
  let soma = 0;
  for (let i = 0; i < 60; i++) soma += intervaloTecla(300, 60);
  assert.ok(soma / 60 > 200);
});

test('SELETORES_PADRAO cobre os três steps do checkout', () => {
  assert.equal(SELETORES_PADRAO.step2CardNumber, '#mp-card-number');
  assert.ok(SELETORES_PADRAO.step1Campos.some(c => c.name === 'cpf'));
  assert.equal(JITTER, 0.05);
});
