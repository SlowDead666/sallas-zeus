import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { createStore } from './storage.mjs';
import { AppError, createProcessor, createNstClient, validateUrl, botStatus } from './core.mjs';

/** Responde JSON sem cache; o conteúdo da configuração nunca deve ser armazenado pelo browser. */
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

/** Limita o corpo a 32 KiB antes de interpretar JSON. */
async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError(415, 'Use Content-Type: application/json.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new AppError(413, 'Corpo excede 32 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'JSON inválido.'); }
}

/** Compara tokens sem depender da posição do primeiro caractere diferente. */
function validToken(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(received), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Valida somente os campos configuráveis; token vazio mantém a credencial já cadastrada. */
export function validateSettings(body, current) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Configuração inválida.');
  const next = { ...current };
  for (const field of ['proxyFromWebhook', 'userAgentFromWebhook', 'urlFromWebhook', 'tipoFromWebhook']) {
    if (typeof body[field] !== 'boolean') throw new AppError(400, `${field} deve ser booleano.`);
    next[field] = body[field];
  }
  validateUrl(body.baseUrl);
  const base = new URL(body.baseUrl);
  if (base.search || base.hash) throw new AppError(400, 'Endereço NST não pode conter query ou fragmento.');
  next.baseUrl = body.baseUrl.replace(/\/$/, '');
  if (typeof body.apiKey !== 'string' || body.apiKey.length > 4096 || /[\r\n]/.test(body.apiKey)) throw new AppError(400, 'Token NST inválido.');
  if (body.apiKey.trim()) next.apiKey = body.apiKey.trim();
  if (typeof body.defaultUrl !== 'string') throw new AppError(400, 'URL fixa inválida.');
  if (body.defaultUrl) validateUrl(body.defaultUrl);
  if (!next.urlFromWebhook && !body.defaultUrl) throw new AppError(400, 'Informe a URL fixa.');
  next.defaultUrl = body.defaultUrl;
  if (!['normal', 'retentativa'].includes(body.defaultTipo)) throw new AppError(400, 'Tipo padrão inválido.');
  next.defaultTipo = body.defaultTipo;
  if (typeof body.country !== 'string' || !/^(?:[A-Z]{2}|ANY)$/.test(body.country)) throw new AppError(400, 'País deve ser BR, US ou outro código de duas letras; ANY aceita qualquer país.');
  next.country = body.country;
  if (!Number.isInteger(body.sessionDuration) || body.sessionDuration < 1 || body.sessionDuration > 1440) throw new AppError(400, 'Duração da sessão deve ser de 1 a 1440 minutos.');
  next.sessionDuration = body.sessionDuration;
  return next;
}

/**
 * Gera o HTML do dashboard local de monitoramento do bot.
 *
 * Funcionalidades:
 *   - Lista todos os bots ativos/concluídos/com erro em tempo real
 *   - Exibe fase atual, cronômetro desde início, estado e log de eventos
 *   - Polling automático a cada 1,5s via fetch para /api/bot/status/all
 *   - Cores por estado: executando (azul), concluído (verde), erro (vermelho)
 *   - Acessível somente em localhost — nunca exposto pelo ngrok
 *
 * @param {number} port - Porta do servidor Zeus
 * @returns {string} HTML completo da página
 */
function dashboardHtml(port) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Zeus — Monitor</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;font-size:14px;padding:20px}
  h1{font-size:20px;font-weight:700;color:#a78bfa;margin-bottom:4px;letter-spacing:.5px}
  .sub{color:#64748b;font-size:12px;margin-bottom:20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(480px,1fr));gap:16px}
  .card{background:#1e2130;border:1px solid #2d3148;border-radius:12px;overflow:hidden}
  .card-header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid #2d3148}
  .card-number{font-weight:600;font-size:13px;color:#c4b5fd;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
  .badge{font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;white-space:nowrap}
  .badge-executando{background:#1e3a5f;color:#60a5fa}
  .badge-concluido{background:#14532d;color:#4ade80}
  .badge-erro{background:#450a0a;color:#f87171}
  .badge-vazio{background:#1e293b;color:#94a3b8}
  .card-body{padding:14px 16px}
  .meta{display:flex;gap:16px;margin-bottom:12px;flex-wrap:wrap}
  .meta-item{display:flex;flex-direction:column;gap:2px}
  .meta-label{font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:.5px}
  .meta-value{font-size:13px;color:#e2e8f0;font-weight:500}
  .progress{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}
  .etapa{font-size:11px;padding:2px 8px;border-radius:6px;background:#2d3148;color:#94a3b8;font-weight:500}
  .etapa-ok{background:#14532d;color:#4ade80}
  .etapa-ativa{background:#1e3a5f;color:#60a5fa;animation:pulsar 1.2s ease-in-out infinite}
  @keyframes pulsar{0%,100%{opacity:1}50%{opacity:.5}}
  .log-wrap{background:#0f1117;border-radius:8px;padding:10px;max-height:200px;overflow-y:auto;border:1px solid #2d3148}
  .log-line{font-family:monospace;font-size:11px;line-height:1.7;color:#94a3b8;white-space:pre-wrap;word-break:break-all}
  .log-line .ts{color:#475569}
  .log-line .tag{color:#a78bfa;font-weight:600}
  .log-line .tag-step1{color:#34d399}
  .log-line .tag-step2{color:#60a5fa}
  .log-line .tag-step3{color:#f59e0b}
  .log-line .tag-iframe{color:#c084fc}
  .log-line .tag-erro{color:#f87171}
  .log-line .tag-pagina{color:#fb923c}
  .vazio{text-align:center;padding:40px;color:#475569;font-size:13px}
  .timer{font-size:12px;color:#64748b;font-family:monospace}
  .dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}
  .dot-executando{background:#60a5fa;animation:pulsar 1s ease-in-out infinite}
  .dot-concluido{background:#4ade80}
  .dot-erro{background:#f87171}
  .topbar{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
  .refresh-info{font-size:11px;color:#475569}
</style>
</head>
<body>
<div class="topbar">
  <div>
    <h1>⚡ Zeus Monitor</h1>
    <div class="sub">Dashboard local — http://localhost:${port}/dashboard</div>
  </div>
  <div class="refresh-info" id="refresh-info">Aguardando...</div>
</div>
<div id="root"><div class="vazio">Nenhum bot registrado ainda.<br>Dispare um webhook para começar.</div></div>

<script src="/dashboard.js"></script>
</body>
</html>`;
}

/** Inicializa servidor exclusivo em loopback. Configuração exige mesma origem para impedir CSRF/DNS rebinding. */
export async function startServer({ port = 3187, publicWebhookHost = (globalThis.process.env.NGROK_HOST || 'pineal-transplanetary-lorretta.ngrok-free.dev'), store, process = createProcessor() } = {}) {
  store ??= await createStore(fileURLToPath(new URL('./.local/', import.meta.url)));
  const html = await readFile(new URL('./config.html', import.meta.url));
  let saving = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host || '';
      const allowedHosts = [`localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`];
      const url = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
      const forwarded = Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-'));
      const local = allowedHosts.includes(host) && !forwarded;
      // Normaliza o host removendo porta (ngrok HTTPS não envia porta mas pode variar).
      const hostSemPorta = host.replace(/:\d+$/, '');
      const publicWebhook = (hostSemPorta === publicWebhookHost || allowedHosts.includes(host)) && url.pathname === '/webhook';
      if (!local && !publicWebhook) {
        globalThis.process.stderr.write(`[zeus] 403 host="${host}" hostSemPorta="${hostSemPorta}" publicWebhookHost="${publicWebhookHost}" path="${url.pathname}" forwarded=${forwarded}\n`);
        throw new AppError(403, 'Host não autorizado. Apenas /webhook pode ser acessado pelo túnel.');
      }
      const isConfig = url.pathname === '/config' || url.pathname.startsWith('/api/config') || url.pathname === '/config.js';
      if (isConfig && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== `http://${host}`))) throw new AppError(403, 'Configuração acessível somente pela mesma origem local.');
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(302, { location: '/config' }); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/config') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html);
      }
      if (req.method === 'GET' && url.pathname === '/config.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' }); return res.end(await readFile(new URL('./config.js', import.meta.url)));
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        const { apiKey, ...publicSettings } = store.get();
        return json(res, 200, { ...publicSettings, apiKeyConfigured: Boolean(apiKey), webhookUrl: `http://${host}/webhook` });
      }
      if (req.method === 'PUT' && url.pathname === '/api/config') {
        if (saving) throw new AppError(409, 'Já existe uma configuração sendo salva.');
        saving = true;
        try {
          const next = validateSettings(await readJson(req), store.get());
          await store.set(next);
          return json(res, 200, { ok: true, apiKeyConfigured: Boolean(next.apiKey) });
        } finally { saving = false; }
      }
      if (req.method === 'GET' && url.pathname === '/api/bot/status') {
        // Status do bot por perfil — somente leitura local, sem dados sensíveis.
        const number = url.searchParams.get('number') ?? '';
        return json(res, 200, { number, status: botStatus.get(number) ?? null });
      }
      if (req.method === 'GET' && url.pathname === '/api/bot/status/all') {
        // Retorna todos os bots em memória — usado pelo dashboard local.
        const todos = [];
        for (const [number, status] of botStatus.entries()) todos.push({ number, ...status });
        return json(res, 200, { bots: todos });
      }
      if (req.method === 'GET' && url.pathname === '/dashboard') {
        // Dashboard local — apenas loopback, nunca exposto pelo ngrok.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(dashboardHtml(server.address().port));
      }
      if (req.method === 'GET' && url.pathname === '/dashboard.js') {
        // JS do dashboard servido separado — o CSP (script-src 'self')
        // bloqueia scripts inline, então o arquivo externo é obrigatório.
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(await readFile(new URL('./dashboard.js', import.meta.url)));
      }
      if (req.method === 'POST' && url.pathname === '/api/config/test') {
        await readJson(req);
        const settings = store.get();
        if (!settings.apiKey) throw new AppError(400, 'Salve o token NST primeiro.');
        await createNstClient(settings)('/profiles/cursor?pageSize=1');
        return json(res, 200, { ok: true, message: 'Conexão NST e autenticação confirmadas.' });
      }
      if (url.pathname === '/webhook' && req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        throw new AppError(405, 'Use POST com JSON e Authorization: Bearer <token do webhook>.');
      }
      if (req.method === 'POST' && url.pathname === '/webhook') {
        const settings = store.get();
        if (!validToken(req.headers.authorization, `Bearer ${settings.webhookToken}`)) throw new AppError(401, 'Token do webhook ausente ou inválido.');
        return json(res, 200, await process(await readJson(req), settings));
      }
      throw new AppError(404, 'Rota não encontrada.');
    } catch (error) {
      json(res, error instanceof AppError ? error.status : 500, { ok: false, error: error instanceof AppError ? error.message : 'Erro interno. Nenhuma credencial foi incluída nesta resposta.' });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return server;
}

/** Entrada CLI; importar o módulo nos testes não inicia servidor nem cria credenciais. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer({ port: Number(process.env.PORT || 3187) }).then(server => {
    console.log(`Configuração: http://localhost:${server.address().port}/config`);
    console.log(`Webhook: POST http://localhost:${server.address().port}/webhook`);
  }).catch(() => { console.error('Falha ao iniciar. Verifique a porta e as permissões da pasta .local.'); process.exitCode = 1; });
}
