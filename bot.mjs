/**
 * bot.mjs — Driver comportamental CDP (sem dependências externas).
 *
 * Executa o replay da jornada /loja → /produto → /checkout usando a
 * matriz de sinais (customers.matriz_sinais) como template. Cada valor
 * numérico sofre oscilação ±JITTER para evitar vetores idênticos entre
 * sessões — o antifraude trata timing idêntico como replay/bot.
 *
 * Por que CDP e não JS na página:
 *   - Input.dispatch* via CDP gera eventos TRUSTED (isTrusted: true),
 *     iguais a input físico — distinto de dispatchEvent() do DOM.
 *   - Funciona dentro dos iframes cross-origin do Mercado Pago: input
 *     no nível do browser ignora isolamento de origem. Basta focar o
 *     campo via clique nas coordenadas do iframe.
 *
 * Contrato de entrada (executeBot):
 *   endpoint   - webSocketDebuggerUrl do navegador NST
 *   matriz     - objeto da matriz de sinais (já parseado)
 *   comprador  - TODOS os campos do Step 1 do checkout:
 *     { first_name, last_name, email, cpf, telefone, cep,
 *       rua, numero, bairro, cidade, estado }
 *   cartao     - { numero, validade: 'MMAA', cvv, nome_titular, cpf_titular }
 *   seletores  - overrides de seletores CSS (opcional)
 *   log        - fn de log (default console.error, stderr)
 *
 * Variações de fluxo suportadas automaticamente (o DOM decide):
 *   - Cliente novo:              Step1 → Step2 → Step3
 *   - Cliente recorrente:        Step1 → Step3 (cartão salvo pulado)
 *   - Múltiplos cartões salvos:  Step1 → Step3 com "em uso" pré-marcado
 *
 * @module bot
 */
import { setTimeout as delay } from 'node:timers/promises';
import { randomInt } from 'node:crypto';

/** Oscilação padrão ±5% aplicada a todos os valores do template. */
export const JITTER = 0.05;

/** Timeout máximo da sessão do bot — protege contra página travada. */
const TIMEOUT_SESSAO_MS = 8 * 60 * 1000;

// ---------------------------------------------------------------------------
// Aleatoriedade e jitter
// ---------------------------------------------------------------------------

/**
 * Oscila um número em ±pct (default ±5% da constante JITTER).
 * Valores inteiros continuam inteiros quando inteiro=true.
 */
export function jitter(valor, { pct = JITTER, inteiro = true } = {}) {
  const v = Number(valor) || 0;
  const fator = 1 + (Math.random() * 2 - 1) * pct;
  return inteiro ? Math.max(0, Math.round(v * fator)) : v * fator;
}

/**
 * Sorteia um intervalo de tecla ~N(media, desvio) e aplica jitter.
 * Clamp inferior: 45ms — abaixo disso nenhum humano digita e é flag certa.
 */
export function intervaloTecla(media, desvio) {
  const m = Number(media) || 150;
  const d = Number(desvio) || m * 0.3;
  // Box-Muller para distribuição ~normal centrada na média.
  const u = Math.max(Math.random(), 1e-9), v = Math.random();
  const gauss = m + d * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(45, Math.round(jitter(gauss)));
}

/** Escolhe um item aleatório de um array; fallback vazio. */
function pick(arr, fallback) {
  return Array.isArray(arr) && arr.length ? arr[randomInt(arr.length)] : fallback;
}

// ---------------------------------------------------------------------------
// Cliente CDP persistente sobre WebSocket nativo
// ---------------------------------------------------------------------------

/**
 * Conecta ao navegador pelo webSocketDebuggerUrl e anexa uma sessão à
 * aba alvo. Retorna helpers: send, evaluate, clickAt, type, scroll, ws.
 *
 * Uso de Target.attachToTarget(flatten) → comandos com sessionId
 * chegam no frame da página, não no browser.
 */
export async function createCdpSession(endpoint, { timeoutMs = TIMEOUT_SESSAO_MS, onEvent = null } = {}) {
  if (!endpoint || !/^wss?:\/\//.test(endpoint)) {
    throw new Error('Endpoint CDP inválido (webSocketDebuggerUrl esperado).');
  }

  const ws = new WebSocket(endpoint);
  let nextId = 1;
  const pendentes = new Map();
  const fim = { erro: null };

  ws.addEventListener('message', event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.id && pendentes.has(data.id)) {
      const { resolve, reject } = pendentes.get(data.id);
      pendentes.delete(data.id);
      data.error ? reject(new Error(`CDP ${data.error.message || 'erro'}`)) : resolve(data.result);
    } else if (data.method && typeof onEvent === 'function') {
      // Eventos CDP (exceções JS, console.error da página, erros de rede).
      try { onEvent(data.method, data.params); } catch { /* log nunca derruba o bot */ }
    }
  });
  ws.addEventListener('close', () => {
    fim.erro = new Error('CDP desconectou.');
    for (const { reject } of pendentes.values()) reject(fim.erro);
    pendentes.clear();
  });
  ws.addEventListener('error', () => { fim.erro = new Error('Falha na conexão CDP.'); });

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Timeout ao conectar CDP.')), 15000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WebSocket CDP falhou.')); }, { once: true });
  });

  /** Envia comando CDP; sessionId opcional roteia para a aba.
   *  Timeout de 30s evita travamento eterno se a resposta não chegar. */
  function send(method, params = {}, sessionId) {
    const id = nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        if (pendentes.delete(id)) reject(new Error(`Timeout CDP em ${method}.`));
      }, 30000);
      pendentes.set(id, {
        resolve: r => { clearTimeout(t); resolve(r); },
        reject: e => { clearTimeout(t); reject(e); },
      });
      ws.send(JSON.stringify(msg));
    });
  }

  /** Localiza a aba alvo: primeiro target tipo "page" com URL http(s). */
  async function anexar() {
    const { targetInfos } = await send('Target.getTargets');
    const alvo = targetInfos.find(t => t.type === 'page' && /^https?:/.test(t.url))
      ?? targetInfos.find(t => t.type === 'page');
    if (!alvo) throw new Error('Nenhuma aba de página encontrada no navegador.');
    const { sessionId } = await send('Target.attachToTarget', { targetId: alvo.targetId, flatten: true });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    return { sessionId, targetId: alvo.targetId };
  }

  const { sessionId } = await anexar();

  /**
   * Executa JS na página (Runtime.evaluate) e retorna result.value.
   * Toda interação com DOM passa por aqui — medida de elementos.
   */
  async function evaluate(expression) {
    if (fim.erro) throw fim.erro;
    const res = await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, timeout: 8000,
    }, sessionId);
    if (res?.exceptionDetails) throw new Error('JS na página falhou.');
    return res?.result?.value;
  }

  /** Centro do elemento via getBoundingClientRect; null se inexistente.
   *  scrollIntoView antes de medir — campos abaixo do fold gerariam
   *  cliques fora do viewport (erro CDP / foco perdido). */
  async function centroDoSeletor(seletor) {
    return evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(seletor)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
  }

  /** Aguarda elemento existir no DOM com polling leve. */
  async function esperarSeletor(seletor, ms = 10000) {
    const inicio = Date.now();
    while (Date.now() - inicio < ms) {
      const ok = await evaluate(`!!document.querySelector(${JSON.stringify(seletor)})`);
      if (ok) return true;
      await delay(150);
    }
    return false;
  }

  /**
   * Aguarda o PRIMEIRO seletor da lista aparecer e retorna qual foi.
   * Essencial para variações de fluxo do checkout: após o Step 1 o
   * wizard pode ir ao Step 2 (#mp-card-number) OU pular direto ao
   * Step 3 (#mp-cvv2) quando o cartão da sessão já está salvo no MP.
   */
  async function esperarQualquerSeletor(lista, ms = 10000) {
    const inicio = Date.now();
    while (Date.now() - inicio < ms) {
      for (const seletor of lista) {
        const ok = await evaluate(`!!document.querySelector(${JSON.stringify(seletor)})`);
        if (ok) return seletor;
      }
      await delay(150);
    }
    return null;
  }

  /**
   * Movimento de mouse com curva pseudo-humana (deslocamento intermediário).
   * Bots não têm trajetória; humanos arqueiam.
   */
  async function mouseMoverAte(x, y, passos) {
    const n = Math.max(2, passos ?? randomInt(6, 14));
    const cx = x + randomInt(-80, 80), cy = y + randomInt(-60, 60);
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      // Interpolação com desvio senoidal — trajetória levemente curva.
      const px = Math.round(x * t + cx * Math.sin(t * Math.PI) * 0.35 + randomInt(-3, 3));
      const py = Math.round(y * t + cy * Math.sin(t * Math.PI) * 0.35 + randomInt(-3, 3));
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py }, sessionId);
      await delay(randomInt(8, 28));
    }
  }

  /** Clique esquerdo trusted em coordenadas absolutas. */
  async function clickAt(x, y) {
    await mouseMoverAte(x, y);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type, x: Math.round(x), y: Math.round(y),
        button: 'left', buttons: 1, clickCount: 1,
      }, sessionId);
      if (type === 'mousePressed') await delay(randomInt(40, 110));
    }
  }

  /** Clica no centro de um seletor; retorna false se não existe. */
  async function clicarSeletor(seletor) {
    const c = await centroDoSeletor(seletor);
    if (!c) return false;
    await clickAt(c.x, c.y);
    return true;
  }

  /**
   * Digita uma tecla via Input.dispatchKeyEvent — evento trusted.
   * caracteres comuns usam rawKeyDown/char; Backspace usa rawKeyDown
   * com windowsVirtualKeyCode=8 (apaga de fato).
   */
  async function tecla(char) {
    if (char === '\b') {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      }, sessionId);
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      }, sessionId);
      return;
    }
    /**
     * keyDown com text — insere o caractere E gera o keydown real
     * (cadência de tecla medida pelo fingerprint). rawKeyDown foi
     * descartado: Chromium rejeita chars que não mapeiam tecla física
     * (' ', '@', acentos) com Invalid parameters, matando o bot.
     * Fallback Input.insertText garante inserção se algo ainda falhar.
     */
    try {
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: char, text: char,
      }, sessionId);
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: char,
      }, sessionId);
    } catch {
      await send('Input.insertText', { text: char }, sessionId);
    }
  }

  /** Tecla especial trusted (Tab, Enter) — usada pra navegar entre campos
   *  quando um overlay intercepta o clique (ex: painel lateral fixed). */
  async function teclaEspecial(nome) {
    const mapa = {
      Tab:   { key: 'Tab',   code: 'Tab',   vk: 9  },
      Enter: { key: 'Enter', code: 'Enter', vk: 13 },
    };
    const t = mapa[nome] ?? { key: nome, code: nome, vk: 0 };
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: t.key, code: t.code, windowsVirtualKeyCode: t.vk,
    }, sessionId);
    await delay(randomInt(30, 80));
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: t.key, code: t.code, windowsVirtualKeyCode: t.vk,
    }, sessionId);
  }

  /**
   * Digita texto com cadência ~N(media, desvio) por tecla + jitter.
   * backspaces>0 insere um erro de digitação seguido de correção
   * em posição aleatória — padrão humano que humaniza o vetor.
   */
  async function digitar(texto, { media = 160, desvio = 50, backspaces = 0 } = {}) {
    const chars = [...String(texto)];
    // Posição do erro: terço médio do texto, nunca no primeiro char.
    const errarEm = backspaces > 0 && chars.length > 3
      ? randomInt(2, Math.min(chars.length - 1, Math.ceil(chars.length * 0.6)))
      : -1;
    for (let i = 0; i < chars.length; i++) {
      if (i === errarEm) {
        const errada = String.fromCharCode(chars[i].charCodeAt(0) === 97 ? 98 : 97 + randomInt(0, 25));
        await tecla(errada);
        await delay(intervaloTecla(media, desvio));
        for (let b = 0; b < backspaces; b++) {
          await tecla('\b');
          await delay(intervaloTecla(media * 0.8, desvio));
        }
      }
      await tecla(chars[i]);
      await delay(intervaloTecla(media, desvio));
    }
  }

  /** Scroll vertical com delta fracionado — imita roda/trackpad. */
  async function rolarPara(deltaY) {
    const passos = randomInt(4, 9);
    let restante = deltaY;
    for (let i = 0; i < passos; i++) {
      const passo = Math.round(restante / (passos - i));
      restante -= passo;
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: randomInt(300, 900), y: randomInt(300, 600),
        deltaX: 0, deltaY: passo,
      }, sessionId);
      await delay(randomInt(60, 220));
    }
  }

  /** Altura rolável da página (documentElement.scrollHeight - viewport). */
  async function alturaRolavel() {
    return evaluate(`Math.max(0, document.documentElement.scrollHeight - innerHeight)`);
  }

  /** Posição atual de scroll. */
  async function scrollAtual() {
    return evaluate(`Math.round(scrollY)`);
  }

  const vencimento = Date.now() + timeoutMs;
  return {
    sessionId, ws, evaluate, esperarSeletor, esperarQualquerSeletor,
    centroDoSeletor,
    clickAt, clicarSeletor, mouseMoverAte, digitar, tecla, teclaEspecial, send,
    rolarPara, alturaRolavel, scrollAtual,
    get expirado() { return Date.now() > vencimento || fim.erro; },
    get erroConexao() { return fim.erro; },
    fechar() { try { ws.close(); } catch { /* noop */ } },
  };
}

// ---------------------------------------------------------------------------
// Replay da jornada — template = matriz.jornada.etapas
// ---------------------------------------------------------------------------

/** Executa micro-pausas de leitura conforme o template hesitacoes. */
async function pausasLeitura(cdp, hesitacoes) {
  for (const ms of hesitacoes?.pausas_leitura_ms ?? []) await delay(jitter(ms));
}

/**
 * Simula scroll humano até profundidade alvo (%), alternando direções
 * do template (ex: ["down","up","down"] → sobe um trecho no meio).
 */
async function executarScroll(cdp, scroll) {
  const alvo = await cdp.alturaRolavel();
  if (!alvo) return;
  const profundidade = Math.min(100, Math.max(0, Number(scroll?.profundidade_pct) || 60)) / 100;
  const destino = Math.round(alvo * jitter(profundidade, { pct: 0.08, inteiro: false }));
  const direcoes = Array.isArray(scroll?.direcoes) && scroll.direcoes.length ? scroll.direcoes : ['down'];
  let pos = 0;
  for (const dir of direcoes) {
    if (dir === 'up') {
      // Recuo de leitura: sobe 10-25% do destino e volta a descer depois.
      const recuo = Math.round(destino * (0.10 + Math.random() * 0.15));
      await cdp.rolarPara(-recuo);
      pos = Math.max(0, pos - recuo);
    } else {
      const avanco = Math.round((destino - pos) / Math.max(1, direcoes.filter(d => d !== 'up').indexOf(dir) + 1 || 1));
      const passo = Math.max(80, jitter(avanco));
      await cdp.rolarPara(passo);
      pos = Math.min(destino, pos + passo);
    }
    await delay(randomInt(300, 1400));
  }
  // Garante destino final se a divisão deixou resto.
  const falta = destino - (await cdp.scrollAtual());
  if (falta > 60) await cdp.rolarPara(falta);
}

/** Passeia o mouse N vezes por pontos pseudo-aleatórios da tela. */
async function passearMouse(cdp, eventos, { x0 = 200, x1 = 1000, y0 = 150, y1 = 650 } = {}) {
  for (let i = 0; i < Math.min(eventos, 40); i++) {
    await cdp.mouseMoverAte(randomInt(x0, x1), randomInt(y0, y1), randomInt(4, 10));
    await delay(randomInt(120, 800));
  }
}

/**
 * Clica num link e CONFIRMA a navegação pela mudança de location.href.
 * Tenta 3 pontos horizontais do elemento pra escapar de overlays.
 * BUG6 FIX: fracX passado via JSON.stringify — nunca interpolado direto
 * no template literal (closure de for-of não preservava o valor certo).
 */
async function clicarComNav(cdp, seletor, { log, nome = 'link', esperarMs = 5000 } = {}) {
  const q = JSON.stringify(seletor);
  const hrefAntes = await cdp.evaluate('location.href').catch(() => null);

  for (const fracX of [0.2, 0.5, 0.8]) {
    // BUG6 FIX: fracX como argumento JSON — não interpolado no eval.
    const frac = JSON.stringify(fracX);
    const p = await cdp.evaluate(`(() => {
      const el = document.querySelector(${q});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) return null;
      const frac = ${frac};
      return { x: Math.round(r.left + r.width * frac), y: Math.round(r.top + r.height / 2) };
    })()`);
    if (!p) return false;

    await cdp.clickAt(p.x, p.y);
    const t0 = Date.now();
    while (Date.now() - t0 < esperarMs) {
      await delay(250);
      const href = await cdp.evaluate('location.href').catch(() => 'nav');
      if (href !== hrefAntes) return true;
    }
    log('nav', `${nome}: clique @${Math.round(fracX * 100)}% sem efeito — tentando outro ponto`);
  }
  return false;
}

/**
 * ETAPA home (/loja): dwell de navegação — scroll, mouse, hesitações,
 * hovers em cards de produto e clique no produto de saída.
 */
async function etapaHome(cdp, etapa, seletores, log, planoId = null) {
  log('home', 'início');
  await delay(jitter(etapa.tempo_ate_primeira_interacao_ms ?? 1500));
  await executarScroll(cdp, etapa.scroll);
  const moves = Math.round((etapa.ponteiro?.mousemove_eventos ?? 400) / 40);
  await passearMouse(cdp, Math.max(2, jitter(moves)));
  await pausasLeitura(cdp, etapa.hesitacoes);

  // Hovers em produtos: passa o mouse sobre cards sem clicar.
  // BUG3 FIX: getBoundingClientRect retorna objeto DOM não serializável
  // via returnByValue — extraímos só x/y como primitivos simples.
  const cards = await cdp.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(seletores.cardProduto)})].slice(0,4).map(el => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)];
    })`
  );
  const cardsPontos = (Array.isArray(cards) ? cards : []).map(c => ({ x: c[0], y: c[1] }));
  for (const c of cardsPontos.slice(0, etapa.ponteiro?.hovers_em_produtos ?? 3)) {
    await cdp.mouseMoverAte(c.x + randomInt(-30, 30), c.y + randomInt(-20, 20));
    await delay(randomInt(400, 1500));
  }

  // Espera de decisão até o tempo-alvo de clique (jitter aplicado).
  const alvo = jitter(etapa.tempo_ate_clique_produto_ms ?? 30000);
  log('home', `dwell alvo ~${alvo}ms; aguardando restante`);
  // O tempo já consumido é natural (ações acima); só ajusta o restante.
  await delay(randomInt(1500, 4000));

  // Se plano_id veio no webhook (id_assinatura da session_config), o clique
  // mira o card daquele plano; senão, clica no primeiro produto da vitrine.
  const alvoPlano = planoId
    ? `a[href*="plano=${String(planoId).replace(/[^a-zA-Z0-9_-]/g, '')}"]`
    : null;
  let clicado = alvoPlano
    ? await clicarComNav(cdp, alvoPlano, { log, nome: `plano ${planoId}` })
    : false;
  if (!clicado) {
    if (alvoPlano) log('home', `plano ${planoId} não navegou; fallback para primeiro produto`);
    clicado = await clicarComNav(cdp, seletores.linkProduto, { log, nome: 'produto' });
  }
  if (!clicado) throw new Error('Link de produto não encontrado na loja.');
  log('home', 'clique_produto → aguardando /produto');
  await cdp.esperarSeletor(seletores.paginaProduto, 10000);
}

/** ETAPA item (/produto): leitura de detalhes + clique em continuar. */
async function etapaItem(cdp, etapa, seletores, log) {
  log('item', 'início');
  await delay(jitter(etapa.tempo_ate_primeira_interacao_ms ?? 1500));
  await executarScroll(cdp, etapa.scroll);
  const leitura = jitter(etapa.leitura_produto?.tempo_lendo_descricao_ms ?? 12000);
  log('item', `leitura ~${leitura}ms`);
  await delay(Math.round(leitura / 2));
  await passearMouse(cdp, Math.max(2, jitter(Math.round((etapa.ponteiro?.mousemove_eventos ?? 200) / 60))));
  await delay(Math.round(leitura / 2));
  await pausasLeitura(cdp, etapa.hesitacoes);

  // BUG2 FIX: botaoContinuar é Link > Button — clicarComNav detecta
  // mudança de href; não esperar seletor de checkout na página atual.
  const clicado = await clicarComNav(cdp, seletores.botaoContinuar, { log, nome: 'continuar', esperarMs: 6000 });
  if (!clicado) throw new Error('Botão continuar não encontrado no produto.');
  log('item', 'clique_comprar → navegação iniciada');
  // Aguarda o formulário do Step 1 aparecer na nova página.
  const chegou = await cdp.esperarSeletor(seletores.step1Form, 15000);
  if (!chegou) throw new Error('Checkout não carregou após clicar em continuar.');
  log('item', 'checkout carregado');
}

/**
 * Garante foco num campo por nome: tenta clique (humano), verifica o
 * activeElement e, se um overlay interceptou o clique, navega por Tab
 * (comportamento real de formulário). Último recurso: focus() via DOM.
 */
async function focarCampo(cdp, nome, log) {
  const sel = `[name="${nome}"]`;
  const q = JSON.stringify(sel);
  const ativo = () => cdp.evaluate(
    `document.activeElement === document.querySelector(${q})`
  );

  const clicou = await cdp.clicarSeletor(sel);
  if (await ativo()) return true;
  if (!clicou) { log('campo', `${nome} não achado`); return false; }
  log('campo', `clique em ${nome} interceptado por overlay — navegando por Tab`);

  for (let i = 0; i < 15; i++) {
    await cdp.teclaEspecial('Tab');
    await delay(randomInt(120, 350));
    if (await ativo()) return true;
  }
  // Último recurso: focus() direto — garante preenchimento do campo.
  await cdp.evaluate(`document.querySelector(${q})?.focus()`);
  return ativo();
}

/**
 * Step 1 — dados pessoais: foca cada campo por clique e digita com
 * cadência da matriz (média/desvio por campo + jitter), backspaces
 * ocasionais e pausa final antes do submit.
 */
async function step1Dados(cdp, step, seletores, comprador, log) {
  log('step1', 'dados pessoais');
  const porCampo = new Map((step.campos ?? []).map(c => [c.campo, c]));

  for (const campo of seletores.step1Campos) {
    const nome = campo.name;
    const valor = comprador[nome];
    if (valor === undefined || valor === null || valor === '') continue;
    const stat = porCampo.get(nome) ?? porCampo.values().next().value;
    const focado = await focarCampo(cdp, nome, log);
    if (!focado) { log('step1', `campo ${nome} sem foco — pulando`); continue; }
    await delay(randomInt(200, 700));
    await cdp.digitar(valor, {
      media: jitter(stat?.inter_key_interval_ms_medio ?? 160),
      desvio: jitter(stat?.inter_key_interval_ms_desvio ?? 50),
      backspaces: Math.random() < 0.35 ? jitter(stat?.backspaces ?? 0, { pct: 1 }) : 0,
    });
    log('step1', `campo ${nome} digitado (${String(valor).length} chars)`);
    await delay(randomInt(300, 900));
  }

  await delay(jitter(step.tempo_entre_ultimo_campo_e_submit_ms ?? 2500));
  const ok = await cdp.clicarSeletor(seletores.step1Submit);
  if (!ok) throw new Error('Botão do Step 1 não encontrado.');
  log('step1', 'submit enviado');
  // BUG1 FIX: não espera step2CardNumber aqui — o orquestrador decide
  // qual step vem a seguir via esperarQualquerSeletor([step2, step3]).
}

/** Digita dentro de um iframe PCI focando via clique nas coordenadas. */
async function digitarEmIframe(cdp, containerId, texto, { media, desvio, pausasBloco } = {}) {
  const ok = await cdp.clicarSeletor(`#${containerId}`);
  if (!ok) throw new Error(`Container ${containerId} não encontrado.`);
  await delay(randomInt(250, 700));
  const chars = [...String(texto).replace(/\D/g, '')];
  for (let i = 0; i < chars.length; i++) {
    await cdp.tecla(chars[i]);
    await delay(intervaloTecla(media, desvio));
    // Pausa humana entre blocos de 4 dígitos (olhar o cartão físico).
    if (pausasBloco && (i + 1) % 4 === 0 && i + 1 < chars.length) {
      await delay(randomInt(400, 1400));
    }
  }
}

/** Step 2 — cartão: nome do titular (input nosso) + 3 iframes PCI. */
async function step2Cartao(cdp, step, seletores, comprador, cartao, log) {
  log('step2', 'cartão');
  const cad = step.cadencia_numero_cartao ?? {};
  const cadCvv = step.cadencia_validade_cvv ?? {};
  const media = jitter(cad.inter_key_interval_ms_medio ?? 190);
  const desvio = jitter(cad.inter_key_interval_ms_desvio ?? 50) || 45;

  // BUG4 FIX: campos não-PCI usam focarCampo (verifica activeElement +
  // fallback Tab) — mesmo padrão dos campos do Step 1.
  const focadoHolder = await focarCampo(cdp, seletores.campoHolder, log);
  if (!focadoHolder) throw new Error('Campo nome do titular não focou.');
  await delay(randomInt(200, 600));
  await cdp.digitar(cartao.nome_titular ?? `${comprador.first_name} ${comprador.last_name}`.toUpperCase(), { media, desvio });
  await delay(randomInt(300, 800));

  const focadoCpf = await focarCampo(cdp, seletores.campoCpfTitular, log);
  if (!focadoCpf) throw new Error('Campo CPF do titular não focou.');
  await delay(randomInt(200, 600));
  await cdp.digitar(cartao.cpf_titular ?? comprador.cpf, { media, desvio });
  await delay(randomInt(300, 800));

  // Iframes PCI na ordem visual: número → validade → CVV.
  await digitarEmIframe(cdp, 'mp-card-number', cartao.numero, {
    media, desvio, pausasBloco: Boolean(cad.pausas_entre_blocos_4_digitos),
  });
  await delay(randomInt(400, 1200));
  await digitarEmIframe(cdp, 'mp-expiration-date', cartao.validade, { media, desvio });
  await delay(randomInt(400, 1200));
  await digitarEmIframe(cdp, 'mp-security-code', cartao.cvv, {
    media: jitter(cadCvv.inter_key_interval_ms_medio ?? 180), desvio,
  });

  await delay(jitter(step.tempo_entre_montagem_iframe_e_submit_ms ?? 5000));
  const ok = await cdp.clicarSeletor(seletores.step2Submit);
  if (!ok) throw new Error('Botão do Step 2 não encontrado.');
  log('step2', 'submit → aguardando Step 3 (CVV confirmação)');
  await cdp.esperarSeletor('#mp-cvv2', 15000);
}

/** Step 3 — confirmação: só o CVV no iframe remontado + autorizar. */
async function step3Confirmacao(cdp, step, seletores, cartao, log) {
  log('step3', 'confirmação CVV');
  // Pausa humana entre receber o step3 e começar a digitar.
  await delay(jitter(step.tempo_entre_step2_e_step3_ms ?? 3000));
  // Aguarda iframe do CVV estar presente antes de tentar digitar.
  const iframeOk = await cdp.esperarSeletor('#mp-cvv2', 10000);
  if (!iframeOk) throw new Error('Iframe CVV (mp-cvv2) não apareceu no Step 3.');
  // BUG5 FIX: tempo_para_digitar_cvv_ms é o tempo DE digitação do CVV
  // (usado como cadência), não um delay pós-digitação. Removido o delay
  // errado — o intervalo pós-digitação/pré-submit já está em tempo_entre_step2_e_step3.
  await digitarEmIframe(cdp, 'mp-cvv2', cartao.cvv, { media: 190, desvio: 55 });
  await delay(randomInt(800, 2000));
  const ok = await cdp.clicarSeletor(seletores.step3Submit);
  if (!ok) throw new Error('Botão de autorização não encontrado.');
  log('step3', 'submit — aguardando resposta do checkout');
}

// ---------------------------------------------------------------------------
// Seletores padrão — casam com o CheckoutWizard do sallas-checkout
// ---------------------------------------------------------------------------

export const SELETORES_PADRAO = {
  cardProduto:    'a[href*="/produto/"]',
  linkProduto:    'a[href*="/produto/"]',
  paginaProduto:  'a[href*="/checkout/"]',
  botaoContinuar: 'a[href*="/checkout/"] button, a[href*="/checkout/"]',
  step1Form:      'form input[name="first_name"]',
  step1Campos:    ['first_name', 'last_name', 'email', 'cpf', 'telefone', 'cep', 'rua', 'numero', 'bairro', 'cidade', 'estado'].map(name => ({ name })),
  step1Submit:    'form button[type="submit"]',
  step2CardNumber:'#mp-card-number',
  campoHolder:    'card_holder',
  campoCpfTitular:'cpf_titular',
  step2Submit:    'form button[type="submit"]',
  step3Submit:    'form button[type="submit"]',
  step3Cvv:       '#mp-cvv2',
  /** Lista de cartões salvos exibida no Step 3 (cliente recorrente). */
  step3Cartoes:   'p.font-mono',
};

// ---------------------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------------------

/**
 * Executa a jornada completa no navegador já aberto.
 *
 * @param {object} args
 * @param {string} args.endpoint   - webSocketDebuggerUrl do NST
 * @param {object} args.matriz     - matriz de sinais parseada
 * @param {object} args.comprador  - dados do comprador (Step 1)
 * @param {object} args.cartao     - dados do cartão de teste
 * @param {object} [args.seletores]- overrides de seletores
 * @param {(etapa:string,msg:string)=>void} [args.log]
 * @returns {Promise<{ok:true, etapas:string[]}>}
 */
export async function executeBot({ endpoint, matriz, comprador = {}, cartao = {}, seletores = {}, planoId = null, log = () => {} }) {
  if (!matriz?.jornada?.etapas?.length) throw new Error('matriz sem jornada.etapas — template ausente.');
  const sel = { ...SELETORES_PADRAO, ...seletores };
  const etapas = matriz.jornada.etapas;
  const porView = new Map(etapas.map(e => [e.view, e]));
  const concluidas = [];

  // Eventos CDP → log: exceções JS da página, console.error e erros de
  // rede (inclui os iframes PCI do MP) chegam ao console/status do Zeus.
  const onEvent = (method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = params?.exceptionDetails ?? {};
      const desc = d.exception?.description ?? d.text ?? 'exceção';
      log('pagina', `JS: ${String(desc).slice(0, 220)}`);
    } else if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
      const txt = (params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ');
      log('pagina', `console.error: ${String(txt).slice(0, 220)}`);
    } else if (method === 'Log.entryAdded' && params?.entry?.level === 'error') {
      const e = params.entry;
      log('pagina', `rede: ${e.source} ${String(e.text ?? '').slice(0, 200)}`);
    }
  };

  const cdp = await createCdpSession(endpoint, { onEvent });
  try {
    // Liga captura de logs da página na sessão da aba.
    try { await cdp.send('Log.enable', {}, cdp.sessionId); } catch { /* tolerante */ }
    const home = porView.get('home');
    const item = porView.get('item');
    const checkout = porView.get('checkout');

    if (home) { await etapaHome(cdp, home, sel, log, planoId); concluidas.push('home'); }
    if (item) { await etapaItem(cdp, item, sel, log); concluidas.push('item'); }

    const steps = new Map((checkout?.steps ?? []).map(s => [s.step, s]));
    if (steps.size) {
      if (steps.get(1)) await step1Dados(cdp, steps.get(1), sel, comprador, log);

      // Variações de fluxo: após o Step 1 o wizard decide sozinho.
      //   #mp-card-number → Step 2 normal (cliente novo / sem match)
      //   #mp-cvv2        → cartão da sessão já salvo no MP; Step 2 pulado
      // O DOM decide — o bot nunca presume qual variação ocorreu.
      const proximo = await cdp.esperarQualquerSeletor(
        [sel.step2CardNumber, sel.step3Cvv], 15000
      );

      if (proximo === sel.step3Cvv) {
        log('fluxo', 'variação: cartão já salvo — Step 2 pulado pelo wizard');
      } else if (proximo === sel.step2CardNumber) {
        if (steps.get(2)) await step2Cartao(cdp, steps.get(2), sel, comprador, cartao, log);
        else log('fluxo', 'Step 2 no DOM mas ausente na matriz — pulando execução');
      } else {
        throw new Error('Checkout não avançou após Step 1 — nem Step 2 nem Step 3.');
      }

      if (steps.get(3)) await step3Confirmacao(cdp, steps.get(3), sel, cartao, log);
      concluidas.push('checkout');
    }
    if (cdp.expirado) throw cdp.erroConexao ?? new Error('Sessão excedeu o tempo máximo.');
    return { ok: true, etapas: concluidas };
  } finally {
    // Mantém o navegador aberto — só a sessão de automação morre.
    cdp.fechar();
  }
}
