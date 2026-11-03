import { setTimeout as delay } from 'node:timers/promises';

/** Erro público deliberado; detalhes internos e credenciais não são devolvidos ao cliente. */
export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Aceita somente URLs HTTP(S), sem credenciais embutidas. Preserva a string de navegação. */
export function validateUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new AppError(400, 'URL inválida.');
  let url;
  try { url = new URL(value); } catch { throw new AppError(400, 'URL inválida.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new AppError(400, 'Use URL HTTP(S) sem credenciais.');
  return value;
}

/** Extrai UA de texto, objeto ou JSON com o prefixo !; não modifica o UA extraído. */
export function parseUserAgent(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/^!\s*/, '');
    if (trimmed.startsWith('{')) {
      try { value = JSON.parse(trimmed); } catch { throw new AppError(400, 'JSON do user_agent inválido.'); }
    }
  }
  if (value && typeof value === 'object') value = value.user_agent;
  if (typeof value !== 'string' || !value.trim() || value.length > 8192 || /[\r\n\x00]/.test(value)) throw new AppError(400, 'user_agent obrigatório e inválido/vazio.');
  return value;
}

/** Chaves aceitas no fingerprint, conforme schema agent.LaunchFingerprint da API v2. */
const FP_KEYS = new Set(['userAgent', 'deviceMemory', 'hardwareConcurrency', 'disableImageLoading', 'doNotTrack', 'restoreLastSession', 'flags', 'fonts', 'localization', 'screen', 'geolocation', 'webrtc']);
/** Valores permitidos por flag, conforme common.FpStrFlags da documentação. */
const FLAG_ENUMS = {
  audio: ['Real', 'Noise'], battery: ['Real', 'Masked'], canvas: ['Real', 'Noise'],
  clientRect: ['Real', 'Noise'], fonts: ['Real', 'Masked', 'Custom'],
  geolocation: ['Custom', 'BasedOnIp'], geolocationPopup: ['Disabled', 'Prompt', 'Allow'],
  gpu: ['Disabled', 'Allow'], localization: ['Real', 'Custom', 'BasedOnIp'],
  mediaDevices: ['Real'], screen: ['Real', 'Custom'], speech: ['Real', 'Masked'],
  timezone: ['Real', 'Custom', 'BasedOnIp'], webgl: ['Real', 'Noise'],
  webrtc: ['Real', 'Masked', 'Custom', 'Disabled'],
};
const SUB_KEYS = {
  localization: new Set(['basedOnProxy', 'languages', 'locale', 'timezone']),
  screen: new Set(['width', 'height']),
  geolocation: new Set(['accuracy', 'altitude', 'altitudeAccuracy', 'heading', 'latitude', 'longitude', 'speed']),
  webrtc: new Set(['publicIp', 'localIps', 'devicesLabels']),
};

/** Rejeita chaves não documentadas citando a culpada — facilita corrigir o sistema de origem. */
function checkKeys(obj, allowed, path) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new AppError(400, `${path} deve ser um objeto.`);
  for (const key of Object.keys(obj)) if (!allowed.has(key)) throw new AppError(400, `Chave desconhecida em ${path}: "${key}".`);
}

/** Garante array de strings curtas. */
function stringArray(value, path, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems || !value.every(v => typeof v === 'string' && v.length <= 500)) throw new AppError(400, `${path} deve ser um array de strings.`);
}

/** Valida cada sub-campo documentado do fingerprint e retorna cópia limpa. */
export function validateFingerprint(fp) {
  checkKeys(fp, FP_KEYS, 'fingerprint');
  const out = {};
  if (fp.userAgent !== undefined) out.userAgent = parseUserAgent(fp.userAgent);
  if (fp.deviceMemory !== undefined) {
    if (![2, 4, 8].includes(fp.deviceMemory)) throw new AppError(400, 'fingerprint.deviceMemory deve ser 2, 4 ou 8.');
    out.deviceMemory = fp.deviceMemory;
  }
  if (fp.hardwareConcurrency !== undefined) {
    if (![2, 4, 8, 10, 12, 14, 16].includes(fp.hardwareConcurrency)) throw new AppError(400, 'fingerprint.hardwareConcurrency deve ser 2, 4, 8, 10, 12, 14 ou 16.');
    out.hardwareConcurrency = fp.hardwareConcurrency;
  }
  for (const key of ['disableImageLoading', 'doNotTrack', 'restoreLastSession']) {
    if (fp[key] !== undefined) {
      if (typeof fp[key] !== 'boolean') throw new AppError(400, `fingerprint.${key} deve ser booleano.`);
      out[key] = fp[key];
    }
  }
  if (fp.flags !== undefined) {
    checkKeys(fp.flags, new Set(Object.keys(FLAG_ENUMS)), 'fingerprint.flags');
    out.flags = {};
    for (const [key, allowed] of Object.entries(FLAG_ENUMS)) {
      if (fp.flags[key] === undefined) continue;
      if (!allowed.includes(fp.flags[key])) throw new AppError(400, `fingerprint.flags.${key} inválido: "${fp.flags[key]}". Aceitos: ${allowed.join(', ')}.`);
      out.flags[key] = fp.flags[key];
    }
  }
  if (fp.fonts !== undefined) { stringArray(fp.fonts, 'fingerprint.fonts'); out.fonts = fp.fonts; }
  if (fp.localization !== undefined) {
    const loc = fp.localization;
    checkKeys(loc, SUB_KEYS.localization, 'fingerprint.localization');
    out.localization = {};
    if (loc.basedOnProxy !== undefined) {
      if (typeof loc.basedOnProxy !== 'boolean') throw new AppError(400, 'fingerprint.localization.basedOnProxy deve ser booleano.');
      out.localization.basedOnProxy = loc.basedOnProxy;
    }
    if (loc.languages !== undefined) { stringArray(loc.languages, 'fingerprint.localization.languages', 20); out.localization.languages = loc.languages; }
    for (const key of ['locale', 'timezone']) {
      if (loc[key] !== undefined) {
        if (typeof loc[key] !== 'string' || !loc[key] || loc[key].length > 100) throw new AppError(400, `fingerprint.localization.${key} inválido.`);
        out.localization[key] = loc[key];
      }
    }
  }
  if (fp.screen !== undefined) {
    checkKeys(fp.screen, SUB_KEYS.screen, 'fingerprint.screen');
    out.screen = {};
    for (const key of ['width', 'height']) {
      if (fp.screen[key] === undefined) continue;
      if (!Number.isInteger(fp.screen[key]) || fp.screen[key] < 1 || fp.screen[key] > 16384) throw new AppError(400, `fingerprint.screen.${key} deve ser inteiro entre 1 e 16384.`);
      out.screen[key] = fp.screen[key];
    }
    if (fp.screen.width !== undefined && fp.screen.height === undefined || fp.screen.height !== undefined && fp.screen.width === undefined) throw new AppError(400, 'fingerprint.screen exige width e height juntos.');
  }
  if (fp.geolocation !== undefined) {
    const geo = fp.geolocation;
    checkKeys(geo, SUB_KEYS.geolocation, 'fingerprint.geolocation');
    out.geolocation = {};
    for (const key of SUB_KEYS.geolocation) {
      if (geo[key] === undefined) continue;
      if (typeof geo[key] !== 'string' && typeof geo[key] !== 'number') throw new AppError(400, `fingerprint.geolocation.${key} deve ser string/número.`);
      out.geolocation[key] = String(geo[key]);
    }
    const lat = Number(out.geolocation.latitude), lon = Number(out.geolocation.longitude);
    if (out.geolocation.latitude !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) throw new AppError(400, 'fingerprint.geolocation.latitude fora de -90..90.');
    if (out.geolocation.longitude !== undefined && (!Number.isFinite(lon) || lon < -180 || lon > 180)) throw new AppError(400, 'fingerprint.geolocation.longitude fora de -180..180.');
  }
  if (fp.webrtc !== undefined) {
    checkKeys(fp.webrtc, SUB_KEYS.webrtc, 'fingerprint.webrtc');
    out.webrtc = {};
    if (fp.webrtc.publicIp !== undefined) {
      if (typeof fp.webrtc.publicIp !== 'string' || fp.webrtc.publicIp.length > 64) throw new AppError(400, 'fingerprint.webrtc.publicIp inválido.');
      out.webrtc.publicIp = fp.webrtc.publicIp;
    }
    for (const key of ['localIps', 'devicesLabels']) if (fp.webrtc[key] !== undefined) { stringArray(fp.webrtc[key], `fingerprint.webrtc.${key}`); out.webrtc[key] = fp.webrtc[key]; }
  }
  return out;
}

/** Valida o contrato antes de qualquer exclusão; número é string para preservar zeros iniciais. */
export function normalizePayload(body, settings) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'Envie um objeto JSON.');
  if (typeof body.number !== 'string' || !body.number.trim() || body.number.length > 150 || /[\x00-\x1f]/.test(body.number)) throw new AppError(400, 'number deve ser texto não vazio, com até 150 caracteres.');
  const tipo = settings.tipoFromWebhook ? body.tipo : settings.defaultTipo;
  if (!['normal', 'retentativa', 'fechar'].includes(tipo)) throw new AppError(400, 'tipo deve ser normal, retentativa ou fechar.');
  const result = { number: body.number, tipo };
  // 'fechar' não navega nem cria: só precisa do number para localizar o perfil.
  if (tipo === 'fechar') return result;
  result.url = validateUrl(settings.urlFromWebhook ? body.url : settings.defaultUrl);
  // Extensão bot comportamental (zeus): a matriz de sinais é o template
  // da jornada; comprador/cartao completam dados que ela não contém.
  if (body.bot !== undefined) {
    if (typeof body.bot !== 'boolean') throw new AppError(400, 'bot deve ser booleano.');
    result.bot = body.bot;
  }
  if (body.matriz !== undefined) {
    if (typeof body.matriz !== 'object' || body.matriz === null || Array.isArray(body.matriz)) throw new AppError(400, 'matriz deve ser um objeto JSON.');
    result.matriz = body.matriz;
  }
  if (result.bot === true && !result.matriz) throw new AppError(400, 'matriz é obrigatória quando bot=true.');
  for (const key of ['comprador', 'cartao']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'object' || body[key] === null || Array.isArray(body[key])) throw new AppError(400, `${key} deve ser um objeto.`);
      result[key] = body[key];
    }
  }
  if (tipo === 'retentativa') return result;
  if (body.platform !== undefined) {
    if (!['Windows', 'macOS', 'Linux'].includes(body.platform)) throw new AppError(400, "platform deve ser Windows, macOS ou Linux.");
    if (body.platform === 'Linux') throw new AppError(400, "platform 'Linux' é recusado pelo cliente NST em Windows (1.23.2). Use Windows/macOS ou omita.");
    if (typeof body.platformVersion !== 'string' || !body.platformVersion || body.platformVersion.length > 50) throw new AppError(400, 'platformVersion é obrigatório quando platform é enviado (regra do NST 1.19+/1.23.2).');
    result.platform = body.platform;
    result.platformVersion = body.platformVersion;
  } else if (body.platformVersion !== undefined) {
    throw new AppError(400, 'platformVersion sem platform não é aceito.');
  }
  if (body.kernelMilestone !== undefined) {
    // A doc limita a 132-140, mas o cliente aceita todos os kernels instalados (ex: 153). Valida-se o formato; o NST rejeita milestone inexistente.
    if (!/^\d{3}$/.test(String(body.kernelMilestone))) throw new AppError(400, "kernelMilestone deve ser o número do Chrome com 3 dígitos (ex: '140', '153').");
    result.kernelMilestone = String(body.kernelMilestone);
  }
  for (const key of ['groupName', 'note']) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== 'string' || body[key].length > 500) throw new AppError(400, `${key} deve ser string com até 500 caracteres.`);
      result[key] = body[key];
    }
  }
  if (settings.userAgentFromWebhook) {
    if (body.fingerprint !== undefined) result.fingerprint = validateFingerprint(body.fingerprint);
    const looseUa = body.user_agent === undefined || body.user_agent === null || body.user_agent === '' ? undefined : parseUserAgent(body.user_agent);
    // Retrocompatibilidade: sem fingerprint enviado, user_agent solto continua obrigatório.
    if (!result.fingerprint && looseUa === undefined) throw new AppError(400, 'user_agent obrigatório quando userAgentFromWebhook está ligado (ou envie fingerprint completo).');
    if (looseUa !== undefined && result.fingerprint?.userAgent === undefined) result.fingerprint = { ...(result.fingerprint || {}), userAgent: looseUa };
  }
  if (settings.proxyFromWebhook && body.proxy != null && body.proxy !== '') {
    if (typeof body.proxy !== 'string') throw new AppError(400, 'proxy deve ser uma URL ou vazio.');
    let proxy;
    try { proxy = new URL(body.proxy); } catch { throw new AppError(400, 'URL do proxy inválida.'); }
    if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol) || !proxy.hostname || (proxy.protocol === 'socks5:' && !proxy.port)) throw new AppError(400, 'Proxy exige protocolo http/https/socks5 e host; SOCKS5 exige porta explícita.');
    result.proxy = body.proxy;
  }
  return result;
}

/** Cliente HTTP v2: timeout e mensagens sanitizadas, inclusive quando a API responde HTTP 200 com err=true. */
export function createNstClient(settings) {
  return async function request(path, method = 'GET', body) {
    let response;
    try {
      response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}${path}`, {
        method, headers: { 'x-api-key': settings.apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60000), redirect: 'error',
      });
    } catch { throw new AppError(502, 'Não foi possível acessar a API NST. Verifique endereço, cliente aberto e conectividade.'); }
    let result;
    try { result = await response.json(); } catch { throw new AppError(502, 'NST respondeu em formato inválido.'); }
    if (!response.ok || result.err === true) throw new AppError(502, `NST recusou ${method} ${path.split('?')[0]} (HTTP ${response.status}). Verifique token, créditos e versão.`);
    return result.data;
  };
}

/** Percorre todas as páginas e compara nomes literalmente; busca parcial nunca autoriza exclusão. */
export async function findProfile(request, name) {
  let cursor;
  const matches = [];
  const visited = new Set();
  do {
    const query = new URLSearchParams({ s: name, pageSize: '100' });
    if (cursor) { query.set('cursor', cursor); query.set('direction', 'next'); }
    const page = await request(`/profiles/cursor?${query}`);
    if (!page || !Array.isArray(page.docs)) throw new AppError(502, 'Resposta de perfis NST inválida.');
    matches.push(...page.docs.filter(profile => profile.name === name));
    cursor = page.hasMore === false ? undefined : page.nextCursor;
    if (page.hasMore === true && !cursor) throw new AppError(502, 'NST indicou mais perfis sem retornar cursor.');
    if (cursor && visited.has(cursor)) throw new AppError(502, 'Paginação NST repetiu o cursor.');
    if (cursor) visited.add(cursor);
  } while (cursor);
  if (matches.length > 1) throw new AppError(409, 'Há vários perfis com esse nome. Resolva a duplicidade no NST antes de continuar.');
  return matches[0];
}

/** Cria uma aba via CDP sem fechar o navegador nem alterar cookies/fingerprint do perfil. */
export async function navigateCdp(endpoint, url) {
  if (!endpoint || !/^wss?:\/\//.test(endpoint)) throw new AppError(502, 'NST não retornou o endereço CDP.');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint);
    let settled = false;
    const timeout = setTimeout(() => finish(new AppError(504, 'Tempo esgotado ao abrir a URL via CDP.')), 20000);
    /** Encerra somente a conexão de automação, mantendo o navegador aberto. */
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ws.close();
      error ? reject(error) : resolve();
    }
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url } })));
    ws.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.id === 1) finish(data.error ? new AppError(502, 'CDP recusou a abertura da URL.') : undefined);
    });
    ws.addEventListener('error', () => finish(new AppError(502, 'Falha na conexão CDP do navegador.')), { once: true });
    ws.addEventListener('close', () => finish(new AppError(502, 'CDP desconectou antes da confirmação.')), { once: true });
  });
}

/** Runner padrão do bot: importa bot.mjs sob demanda — testes nunca tocam o driver real. */
async function runBotPadrao(args) {
  const { executeBot } = await import('./bot.mjs');
  return executeBot(args);
}

/** Status em memória do bot por perfil (number). Somente consulta local; nada é persistido. */
export const botStatus = new Map();

/** Dispara o bot em background sem bloquear a resposta do webhook; status fica em botStatus. */
function agendarBot(number, args, runner) {
  botStatus.set(number, { estado: 'executando', ts: new Date().toISOString() });
  Promise.resolve()
    .then(() => runner(args))
    .then(r => botStatus.set(number, { estado: 'concluido', ts: new Date().toISOString(), etapas: r?.etapas ?? [] }))
    .catch(err => botStatus.set(number, { estado: 'erro', ts: new Date().toISOString(), erro: String(err?.message ?? err) }));
}

/** Serializa todo o ciclo por nome e rejeita sobrecarga; não repete automaticamente operações destrutivas. */
export function createProcessor({ clientFactory = createNstClient, navigate = navigateCdp, wait = delay, runBot = runBotPadrao } = {}) {
  const locks = new Set();
  return async function process(body, settings) {
    if (!settings.apiKey) throw new AppError(503, 'Configure o token NST em /config.');
    const input = normalizePayload(body, settings);
    if (locks.has(input.number)) throw new AppError(409, 'Já existe uma operação em andamento para esse number.');
    if (locks.size >= 10) throw new AppError(429, 'Limite de operações simultâneas atingido.');
    locks.add(input.number);
    let stage = 'buscar perfil';
    try {
      const request = clientFactory(settings);
      const existing = await findProfile(request, input.number);
      const id = existing?.profileId;
      if (existing && !id) throw new AppError(502, 'Perfil NST sem profileId.');
      if (input.tipo === 'fechar') {
        if (!existing) throw new AppError(404, 'Perfil não encontrado; nada para fechar.');
        stage = 'fechar navegador';
        const running = await request('/browsers');
        if (!Array.isArray(running)) throw new AppError(502, 'Lista de navegadores NST inválida.');
        if (!running.some(item => item.profileId === id)) return { ok: true, number: input.number, profileId: id, action: 'already_stopped' };
        await request(`/browsers/${encodeURIComponent(id)}`, 'DELETE');
        return { ok: true, number: input.number, profileId: id, action: 'stopped' };
      }
      if (input.tipo === 'retentativa') {
        if (!existing) throw new AppError(404, 'Perfil de retentativa não encontrado; nenhum perfil foi criado.');
        stage = 'abrir perfil existente';
        const running = await request('/browsers');
        if (!Array.isArray(running)) throw new AppError(502, 'Lista de navegadores NST inválida.');
        let runtime = running.find(item => item.profileId === id && item.running);
        if (!runtime) runtime = await request(`/browsers/${encodeURIComponent(id)}`, 'POST');
        if (!runtime?.webSocketDebuggerUrl) runtime = await request(`/browsers/${encodeURIComponent(id)}/debugger`);
        stage = 'abrir URL no perfil existente';
        const endpointRet = typeof runtime === 'string' ? runtime : runtime?.webSocketDebuggerUrl;
        await navigate(endpointRet, input.url);
        if (input.bot) {
          // Bot usa o mesmo endpoint CDP da navegação; o perfil retentativa
          // preserva fingerprint — a sessão do bot herda tudo.
          agendarBot(input.number, { endpoint: endpointRet, matriz: input.matriz, comprador: input.comprador ?? {}, cartao: input.cartao ?? {} }, runBot);
        }
        return { ok: true, number: input.number, profileId: id, action: 'reused', url: input.url, bot: input.bot ? 'executando' : undefined };
      }
      const profile = { name: input.number, startupUrls: [input.url] };
      if (input.proxy) profile.proxy = input.proxy;
      else profile.builtinProxy = { type: 'residential', country: settings.country, sessionDuration: settings.sessionDuration, protocol: 'http' };
      for (const key of ['platform', 'platformVersion', 'kernelMilestone', 'groupName', 'note']) {
        if (input[key] !== undefined) profile[key] = input[key];
      }
      const warnings = [];
      const ua = input.fingerprint?.userAgent;
      if (input.fingerprint) profile.fingerprint = input.fingerprint;
      if (ua && /Android|iPhone|iPad/i.test(ua)) warnings.push('UA móvel preservado; o NST utiliza motor desktop e não reproduz Android/iOS real. Coerência coberta por authentication_type no pagamento.');
      if (existing) {
        stage = 'fechar perfil antigo';
        const running = await request('/browsers');
        if (!Array.isArray(running)) throw new AppError(502, 'Lista de navegadores NST inválida.');
        if (running.some(item => item.profileId === id)) {
          await request(`/browsers/${encodeURIComponent(id)}`, 'DELETE');
          let stopped = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            const browsers = await request('/browsers');
            if (!Array.isArray(browsers)) throw new AppError(502, 'Lista de navegadores NST inválida.');
            if (!browsers.some(item => item.profileId === id)) { stopped = true; break; }
            await wait(500);
          }
          if (!stopped) throw new AppError(504, 'O navegador não fechou. O perfil não foi excluído.');
        }
        stage = 'excluir perfil antigo';
        await request(`/profiles/${encodeURIComponent(id)}`, 'DELETE');
      }
      stage = 'criar novo perfil';
      const created = await request('/profiles', 'POST', profile);
      if (!created?.profileId) throw new AppError(502, 'NST não retornou profileId após criar.');
      stage = `abrir novo perfil ${created.profileId}`;
      let runtime = await request(`/browsers/${encodeURIComponent(created.profileId)}`, 'POST');
      if (input.bot) {
        // O bot precisa do webSocketDebuggerUrl para anexar a sessão CDP.
        let endpoint = typeof runtime === 'string' ? runtime : runtime?.webSocketDebuggerUrl;
        if (!endpoint) {
          runtime = await request(`/browsers/${encodeURIComponent(created.profileId)}/debugger`);
          endpoint = typeof runtime === 'string' ? runtime : runtime?.webSocketDebuggerUrl;
        }
        if (!endpoint) throw new AppError(502, 'NST não retornou o endereço CDP para o bot.');
        // A startupUrl já abriu /loja — o driver assume a partir daí.
        agendarBot(input.number, { endpoint, matriz: input.matriz, comprador: input.comprador ?? {}, cartao: input.cartao ?? {} }, runBot);
      }
      return { ok: true, number: input.number, profileId: created.profileId, action: existing ? 'recreated' : 'created', url: input.url, warnings, bot: input.bot ? 'executando' : undefined };
    } catch (error) {
      if (error instanceof AppError) throw new AppError(error.status, `${error.message} Etapa: ${stage}.`);
      throw new AppError(502, `Falha na etapa: ${stage}. Confira o NST antes de reenviar como normal.`);
    } finally { locks.delete(input.number); }
  };
}
