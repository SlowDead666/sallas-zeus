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

  /**
   * Centro do elemento em coordenadas de viewport.
   * Retorna array [x, y] (primitivos) — objetos falham em returnByValue
   * dependendo do contexto CDP. scrollIntoView síncrono (behavior:instant)
   * garante que o elemento está visível antes de medir.
   */
  async function centroDoSeletor(seletor) {
    const coords = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(seletor)});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      if (x <= 0 && y <= 0) return null;
      if (r.width === 0 && r.height === 0) return null;
      return [x, y];
    })()`);
    if (!Array.isArray(coords)) return null;
    return { x: coords[0], y: coords[1] };
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
   * wizard pode ir ao Step 2 ou pular direto ao Step 3 quando o cartão
   * da sessão já está salvo no MP — ambos exibem #mp-card-number; o que
   * distingue é a ausência do input card_holder no Step 3.
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
   *
   * dwellMs: tempo entre keyDown e keyUp (quanto o dedo "segura" a tecla).
   * Humanos seguram ~60-100ms; dwell ~0ms é sinal clássico de bot para
   * antifraude que mede keystroke dynamics. Vem de dwell_time_tecla_ms
   * da matriz; padrão ~85ms nos campos PCI que não o definem.
   *
   * Backspace usa rawKeyDown com windowsVirtualKeyCode=8 (apaga de fato).
   */
  async function tecla(char, dwellMs = 0) {
    if (char === '\b') {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown', key: 'Backspace', code: 'Backspace',
        windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8,
      }, sessionId);
      if (dwellMs) await delay(dwellMs);
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
      if (dwellMs) await delay(dwellMs);
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
   *
   * Simulação de erro humano (quando comErro=true):
   *   1. Digita uma letra adjacente no alfabeto (nunca igual ao char correto)
   *   2. Pausa curta (hesitação humana ao perceber o erro)
   *   3. Apaga EXATAMENTE 1 caractere com Backspace
   *   4. Redigita o caractere correto
   *
   * Importante: sempre exatamente 1 backspace — nunca mais, nunca menos.
   * Mais de 1 backspace apagaria chars corretos anteriores sem redigitá-los,
   * deixando o campo com conteúdo incompleto.
   *
   * A posição do erro fica no terço médio do texto (nunca no 1º char nem
   * no último) para que a correção pareça natural.
   *
   * dwell: média do dwell_time_tecla_ms da matriz (ms que o dedo segura
   * cada tecla). Jitter ±25% por tecla — humano não segura tempo fixo.
   */
  async function digitar(texto, { media = 160, desvio = 50, comErro = false, dwell = 0 } = {}) {
    const chars = [...String(texto)];
    // Posição do erro: entre 20% e 60% do texto, nunca no primeiro char.
    const errarEm = comErro && chars.length > 3
      ? randomInt(Math.max(1, Math.floor(chars.length * 0.2)), Math.min(chars.length - 1, Math.ceil(chars.length * 0.6)))
      : -1;
    for (let i = 0; i < chars.length; i++) {
      if (i === errarEm) {
        // Letra errada: adjacente no alfabeto, garantidamente diferente do char correto.
        const code = chars[i].charCodeAt(0);
        const erradaCode = (code >= 97 && code <= 122)
          ? (code === 97 ? 98 : code - 1)   // 'a' → 'b'; qualquer outra → anterior
          : (code >= 65 && code <= 90)
            ? (code === 65 ? 66 : code - 1)  // 'A' → 'B'; qualquer outra → anterior
            : code + 1;                       // não-letra: apenas incrementa
        const errada = String.fromCharCode(erradaCode);
        await tecla(errada, dwell ? jitter(dwell, { pct: 0.25 }) : 0);
        await delay(intervaloTecla(media * 1.4, desvio)); // hesitação ao perceber o erro
        await tecla('\b', dwell ? jitter(dwell, { pct: 0.25 }) : 0); // apaga EXATAMENTE 1 char
        await delay(intervaloTecla(media * 0.9, desvio));
      }
      await tecla(chars[i], dwell ? jitter(dwell, { pct: 0.25 }) : 0);
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
/**
 * Clica num link/botão e confirma que a URL mudou após o clique.
 *
 * Estratégia em 4 camadas (diagnóstico + correção no mesmo passe):
 *   1. elementFromPoint ANTES do clique — confirma que o ponto está
 *      livre e, se não estiver, loga o outerHTML do interceptador.
 *   2. Tenta 3 pontos horizontais (20%/50%/80%) do elemento.
 *   3. Todos cobertos → scroll: overlay fixed não se move, o elemento
 *      sim — rolar tira o alvo da faixa do overlay (ex.: PainelSessao).
 *   4. Último recurso → focus() + Enter trusted: ativação real por
 *      teclado, imune a hit-test (Enter em <a> navega, em <button> age).
 *
 * Verificação de efeito: location.href muda (navegação real), nunca
 * apenas "elemento existe" — clique cego foi a causa de falhas
 * intermitentes quando o centro do botão caía sob overlay fixed.
 */
async function clicarComNav(cdp, seletor, { log, nome = 'link', esperarMs = 5000 } = {}) {
  const q = JSON.stringify(seletor);
  const hrefAntes = await cdp.evaluate('location.href').catch(() => null);

  /** Confirma a navegação por mudança real de location.href. */
  const confirmarNav = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < esperarMs) {
      await delay(250);
      const href = await cdp.evaluate('location.href').catch(() => 'nav');
      if (href !== hrefAntes) return true;
    }
    return false;
  };

  /**
   * Mede o ponto @fracX do elemento e testa com elementFromPoint.
   * Retorna [x, y, livre(0|1), interceptador(outerHTML)] ou null se o
   * elemento não existe/está fora do viewport.
   */
  const pontoLivre = async fracX => {
    const frac = JSON.stringify(fracX);
    return cdp.evaluate(`(() => {
      const el = document.querySelector(${q});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = Math.round(r.left + r.width * ${frac});
      const y = Math.round(r.top + r.height / 2);
      if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) return null;
      const hit = document.elementFromPoint(x, y);
      const livre = !!(hit && (el === hit || el.contains(hit) || hit.contains(el)));
      const tampa = hit ? hit.outerHTML.slice(0, 80) : 'nada';
      return [x, y, livre ? 1 : 0, tampa];
    })()`);
  };

  // Camadas 1+2: pontos horizontais com hit-test prévio.
  for (const fracX of [0.2, 0.5, 0.8]) {
    const info = await pontoLivre(fracX);
    if (!Array.isArray(info)) continue;
    const [x, y, livre, tampa] = info;
    if (!livre) {
      log('nav', `${nome}: ponto @${Math.round(fracX * 100)}% coberto por: ${tampa}`);
      continue;
    }
    await cdp.clickAt(x, y);
    if (await confirmarNav()) return true;
    log('nav', `${nome}: clique @${Math.round(fracX * 100)}% sem efeito — tentando outro ponto`);
  }

  // Camada 3: overlay fixed não rola — scroll desloca o ELEMENTO para
  // fora da faixa do overlay. Tenta descer e subir.
  for (const delta of [240, -240]) {
    await cdp.rolarPara(delta);
    await delay(400);
    const info = await pontoLivre(0.25);
    if (!Array.isArray(info) || !info[2]) continue;
    await cdp.clickAt(info[0], info[1]);
    if (await confirmarNav()) return true;
    log('nav', `${nome}: clique pós-scroll sem efeito`);
  }

  // Camada 4: focus() + Enter trusted — ativação real independente do
  // que estiver cobrindo o elemento visualmente.
  const focou = await cdp.evaluate(`(() => {
    const el = document.querySelector(${q});
    if (!el) return 0;
    el.focus();
    return document.activeElement === el || el.contains(document.activeElement) ? 1 : 0;
  })()`);
  if (focou) {
    log('nav', `${nome}: pontos cobertos — ativando via foco + Enter`);
    await cdp.teclaEspecial('Enter');
    if (await confirmarNav()) return true;
  }
  return false;
}

/**
 * Clica num botão de submit e confirma que o clique foi efetivo.
 *
 * Mesmo problema do clicarComNav: com telas menores o centro do botão
 * pode cair sob o PainelSessao (fixed right-0, 256px, z-40) — o clique
 * vai para o overlay e o bot loga "submit enviado" sem nada ter ocorrido.
 *
 * Estratégia em 4 camadas (igual ao clicarComNav):
 *   1. elementFromPoint ANTES do clique — verifica se o ponto está livre.
 *   2. 3 pontos horizontais (20%/50%/80%) do botão.
 *   3. Scroll: overlay fixed não rola, o botão sim.
 *   4. focus() + Enter trusted — imune a qualquer hit-test.
 *
 * Verificação de efeito: o botão fica disabled/loading ou sai do DOM
 * após submit bem-sucedido — nunca apenas "clicou".
 */
async function clicarSubmit(cdp, seletor, { log, nome = 'submit', esperarMs = 6000 } = {}) {
  const q = JSON.stringify(seletor);

  /** Aguarda o botão ficar disabled ou sair do DOM (submit processado). */
  const confirmarSubmit = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < esperarMs) {
      await delay(200);
      const desativado = await cdp.evaluate(`(() => {
        const el = document.querySelector(${q});
        // Botão saiu do DOM (re-render) ou ficou disabled/aria-busy — submit aceito.
        if (!el) return true;
        if (el.disabled) return true;
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if (el.getAttribute('aria-busy') === 'true') return true;
        return false;
      })()`).catch(() => true);
      if (desativado) return true;
    }
    return false;
  };

  /**
   * Mede o ponto @fracX do botão e testa com elementFromPoint.
   * Retorna [x, y, livre(0|1), interceptador(outerHTML)] ou null.
   */
  const pontoLivre = async fracX => {
    const frac = JSON.stringify(fracX);
    return cdp.evaluate(`(() => {
      const el = document.querySelector(${q});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = Math.round(r.left + r.width * ${frac});
      const y = Math.round(r.top + r.height / 2);
      if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) return null;
      const hit = document.elementFromPoint(x, y);
      const livre = !!(hit && (el === hit || el.contains(hit) || hit.contains(el)));
      const tampa = hit ? hit.outerHTML.slice(0, 80) : 'nada';
      return [x, y, livre ? 1 : 0, tampa];
    })()`);
  };

  // Camadas 1+2: pontos horizontais com hit-test prévio.
  for (const fracX of [0.2, 0.5, 0.8]) {
    const info = await pontoLivre(fracX);
    if (!Array.isArray(info)) continue;
    const [x, y, livre, tampa] = info;
    if (!livre) {
      log('nav', `${nome}: ponto @${Math.round(fracX * 100)}% coberto por: ${tampa}`);
      continue;
    }
    await cdp.clickAt(x, y);
    if (await confirmarSubmit()) return true;
    log('nav', `${nome}: clique @${Math.round(fracX * 100)}% sem efeito — tentando outro ponto`);
  }

  // Camada 3: scroll desloca o botão para fora da faixa do overlay fixed.
  for (const delta of [240, -240]) {
    await cdp.rolarPara(delta);
    await delay(400);
    const info = await pontoLivre(0.25);
    if (!Array.isArray(info) || !info[2]) continue;
    await cdp.clickAt(info[0], info[1]);
    if (await confirmarSubmit()) return true;
    log('nav', `${nome}: clique pós-scroll sem efeito`);
  }

  // Camada 4: focus() + Enter trusted — imune a qualquer overlay.
  const focou = await cdp.evaluate(`(() => {
    const el = document.querySelector(${q});
    if (!el) return 0;
    el.focus();
    return document.activeElement === el || el.contains(document.activeElement) ? 1 : 0;
  })()`);
  if (focou) {
    log('nav', `${nome}: pontos cobertos — ativando via foco + Enter`);
    await cdp.teclaEspecial('Enter');
    if (await confirmarSubmit()) return true;
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
  log('home', 'clique_produto → navegação confirmada');
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
 * Dispensa o popup de autofill/dados do Chrome com Escape trusted.
 * O popup é UI do browser (não aparece no DOM nem no elementFromPoint)
 * mas captura o clique seguinte e pode preencher o campo com dados
 * salvos do perfil — sobrescrevendo o que o bot digitaria.
 * Escape é o gesto humano normal para fechá-lo sem aceitar sugestão.
 */
async function dispensarAutofill(cdp) {
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }, cdp.sessionId);
  await delay(jitter(70));
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }, cdp.sessionId);
  await delay(120);
}

/**
 * Foca um campo pelo clique — simples e direto.
 * Tab só entra quando o clique realmente falha (elemento não existe
 * ou coordenadas fora do viewport). Não queremos Tab como padrão.
 */
async function focarCampo(cdp, nome, log) {
  const sel = `[name="${nome}"]`;
  const q = JSON.stringify(sel);

  // Dispensa popup de autofill antes de clicar — ele fica abaixo do
  // campo anterior e o clique iria para a sugestão, não para o input.
  await dispensarAutofill(cdp);

  // Primeira tentativa: clique normal (humano).
  const clicou = await cdp.clicarSeletor(sel);
  if (!clicou) {
    log('campo', `${nome} não encontrado no DOM`);
    return false;
  }

  // Verifica foco após uma pausa curta (React pode ter delay de setState).
  await delay(80);
  const focado = await cdp.evaluate(
    `document.activeElement === document.querySelector(${q})`
  );
  if (focado) return true;

  // Clique falhou silenciosamente (overlay, coordenada errada): focus() DOM.
  // Mais discreto que Tab — não gera sequência de keydowns visível.
  log('campo', `${nome}: clique sem foco — usando focus() DOM`);
  await cdp.evaluate(`document.querySelector(${q})?.focus()`);
  await delay(60);
  return cdp.evaluate(`document.activeElement === document.querySelector(${q})`);
}

/**
 * Digita em um input comum ([name=...]) com verificação de valor final.
 *
 * O popup de autofill do Chrome pode preencher o campo com dados salvos
 * do perfil ou capturar teclas — a digitação "bem-sucedida" do ponto de
 * vista dos eventos não garante o conteúdo do campo. Lê input.value após
 * digitar; se divergir do esperado, limpa (Ctrl+A+Backspace) e refaz.
 *
 * @param {object} cdp      - sessão CDP da página
 * @param {string} nome     - atributo name do input
 * @param {string} valor    - valor a digitar
 * @param {object} opts     - {media, desvio, soDigitos} — soDigitos compara
 *                            só dígitos (campos com máscara tipo CPF)
 * @param {Function} log    - função de log
 * @returns {Promise<boolean>} true quando o campo confirma o valor
 */
async function digitarCampoVerificado(cdp, nome, valor, { media = 160, desvio = 50, soDigitos = false } = {}, log = () => {}) {
  const sel = `[name="${nome}"]`;
  const q = JSON.stringify(sel);
  const esperado = soDigitos ? String(valor).replace(/\D/g, '') : String(valor);

  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const focado = await focarCampo(cdp, nome, log);
    if (!focado) return false;
    await delay(randomInt(200, 500));
    await cdp.digitar(valor, { media, desvio });

    const atual = await cdp.evaluate(`document.querySelector(${q})?.value ?? ''`);
    const real = soDigitos ? String(atual).replace(/\D/g, '') : String(atual);
    // Case-insensitive: o input de titular força toUpperCase() no onInput.
    if (real === esperado || real.toUpperCase() === esperado.toUpperCase()) {
      log('campo', `${nome} confirmado (${real.length} chars)`);
      return true;
    }
    log('campo', `${nome}: esperado "${esperado.slice(0, 14)}", lido "${real.slice(0, 14)}" — tentativa ${tentativa + 1}/3`);

    // Limpa via eventos trusted: foco + Ctrl+A + Backspace.
    // React controlado precisa de evento real — setar .value não dispara onChange.
    await cdp.evaluate(`document.querySelector(${q})?.focus()`);
    await delay(80);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }, cdp.sessionId);
    await delay(jitter(70));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }, cdp.sessionId);
    await delay(80);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' }, cdp.sessionId);
    await delay(jitter(90));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' }, cdp.sessionId);
    await delay(200);
  }
  log('campo', `${nome} não confirmou valor após 3 tentativas`);
  return false;
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
      // dwell_time_tecla_ms: tempo segurando cada tecla (~85ms humano).
      // Fallback 85ms quando a matriz não fornece por campo.
      dwell: jitter(stat?.dwell_time_tecla_ms ?? 85),
      // comErro: 25% de chance por campo, apenas se a matriz indica backspaces > 0.
      // Sempre exatamente 1 erro + 1 backspace — nunca mais.
      comErro: (stat?.backspaces ?? 0) > 0 && Math.random() < 0.25,
    });
    log('step1', `campo ${nome} digitado (${String(valor).length} chars)`);
    await delay(randomInt(300, 900));
  }

  await delay(jitter(step.tempo_entre_ultimo_campo_e_submit_ms ?? 2500));
  // clicarSubmit em vez de clicarSeletor: verifica hit-test antes de clicar
  // e confirma que o botão ficou disabled/saiu do DOM — evita falso "submit
  // enviado" quando o PainelSessao intercepta o clique em telas menores.
  const ok = await clicarSubmit(cdp, seletores.step1Submit, { log, nome: 'step1-submit' });
  if (!ok) throw new Error('Botão do Step 1 não respondeu ao clique.');
  log('step1', 'submit confirmado');
  // BUG1 FIX: não espera step2CardNumber aqui — o orquestrador decide
  // qual step vem a seguir via esperarQualquerSeletor([step2, step3]).
}

/**
 * Anexa uma sessão CDP direta ao iframe OOPIF dentro de #containerId.
 *
 * Os iframes PCI do Mercado Pago são cross-origin → viram targets
 * separados (type 'iframe') no browser. Anexar uma sessão a eles
 * elimina toda a dependência de roteamento de foco do browser —
 * eventos enviados na sessão do iframe chegam DIRETO ao frame, e
 * Runtime.evaluate nele permite focar o input e ler input.value
 * para verificar de fato que a digitação aconteceu.
 *
 * @param {object} cdp         - sessão CDP (conexão WebSocket da página)
 * @param {string} containerId - id do div container sem #
 * @param {Function} [log]     - função de log (opcional)
 * @returns {Promise<string|null>} sessionId do iframe, ou null se não achou
 */
async function anexarIframe(cdp, containerId, log = () => {}) {
  // src + tamanho real do elemento iframe — o OOPIF certo tem viewport
  // (innerWidth/innerHeight) igual ao tamanho do elemento na página.
  // Iframes ocultos de antifraude do MP (0x0/1x1) são eliminados pelo
  // tamanho, não por threshold arbitrário.
  const alvo = await cdp.evaluate(`(() => {
    const f = document.querySelector('#${containerId} iframe');
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return { src: f.src, w: Math.round(r.width), h: Math.round(r.height) };
  })()`).catch(() => null);
  const src = alvo?.src ?? null;
  const esperadoW = alvo?.w ?? 0, esperadoH = alvo?.h ?? 0;
  if (!src) return null;

  // ATENÇÃO: todos os iframes PCI do MP compartilham a mesma URL base —
  // match por URL sozinho anexa o frame ERRADO (bug: validade/CVV iam
  // parar dentro do campo do número). A distinção é feita pelo CONTEÚDO:
  // cada campo hospeda um input com name/autocomplete/placeholder próprios
  // e viewport igual ao elemento iframe do container.
  const baseSrc = src.split('?')[0];

  // Marcadores que identificam qual campo PCI cada frame hospeda —
  // cobrem name, autocomplete do MP e o placeholder que nós definimos.
  const marcadores = {
    'mp-card-number':     /cc-number|card.?number|0000/i,
    'mp-expiration-date': /cc-exp|expir|mm\/aa|mm\/yy/i,
    'mp-security-code':   /cc-csc|security|cvv|csc|•/i,
    'mp-cvv2':            /cc-csc|security|cvv|csc|•/i,
  };
  const re = marcadores[containerId];

  // Re-sondagem por até 12s: o target OOPIF só aparece quando o conteúdo
  // do iframe comita (async, lento com proxy), e o input interno renderiza
  // depois disso. Sem retry o PRIMEIRO campo digitado sempre caía no
  // fallback de roteamento de foco — que não funciona em frame cross-origin.
  const inicio = Date.now();
  for (let ciclo = 0; ; ciclo++) {
    const { targetInfos } = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const candidatos = targetInfos.filter(t => t.type === 'iframe' && (
      t.url === src || t.url.split('?')[0] === baseSrc || src.startsWith(t.url.split('?')[0])
    ));

    // Sem candidatos = OOPIF ainda não comitou o conteúdo do iframe —
    // trata como "carregando" para continuar re-sondando.
    let carregando = candidatos.length === 0;
    if (ciclo === 0 || ciclo % 6 === 0) {
      log('iframe', `${containerId}: sondagem ${ciclo + 1} — ${candidatos.length} candidato(s) OOPIF`);
    }
    for (const t of candidatos) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => ({}));
      if (!sessionId) continue;
      const info = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const dim = innerWidth + 'x' + innerHeight;
          const desc = [...document.querySelectorAll('input')]
            .map(i => [i.name||'', i.getAttribute('autocomplete')||'', i.placeholder||'', i.id||''].join('|'))
            .join(';');
          return desc + '|' + dim;
        })()`,
        returnByValue: true,
      }, sessionId).catch(() => null);
      const bruto = String(info?.result?.value ?? '');
      const dimMatch = bruto.match(/(\d+)x(\d+)$/);
      const largura = Number(dimMatch?.[1] ?? 0), altura = Number(dimMatch?.[2] ?? 0);
      const desc = bruto.replace(/\|\d+x\d+$/, '');

      // O frame certo tem viewport igual ao elemento iframe do container.
      // Tolerância 8px (bordas/scroll interno). Iframes ocultos de
      // antifraude (0x0/1x1) são eliminados aqui automaticamente.
      if (esperadoW > 0 && esperadoH > 0 &&
          (Math.abs(largura - esperadoW) > 8 || Math.abs(altura - esperadoH) > 8)) {
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        continue;
      }
      if (desc === '') {
        // Frame visível mas input interno ainda não renderizou — re-tenta.
        carregando = true;
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
        continue;
      }
      if (!re || re.test(desc)) return { sessionId, targetId: t.targetId }; // frame correto confirmado
      // Frame de outro campo PCI — desanexa e tenta o próximo candidato.
      await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }

    if (!carregando && ciclo > 0) {
      log('iframe', `${containerId}: ${candidatos.length} frame(s) estáveis, nenhum é o campo esperado`);
      return null;
    }
    if (Date.now() - inicio > 12000) {
      log('iframe', `${containerId}: OOPIF não identificado em 12s — fallback de foco`);
      return null;
    }
    await delay(500);
  }
}

/**
 * Digita texto dentro de um iframe PCI do Mercado Pago.
 *
 * Estratégia principal (sessão OOPIF):
 *   1. Clique no container + no iframe — eventos de mouse trusted (foco real)
 *   2. anexarIframe() → sessionId própria do frame cross-origin
 *   3. focus() no input via Runtime.evaluate na sessão do iframe
 *   4. Teclas via Input.dispatchKeyEvent na sessão do iframe — chegam
 *      direto ao frame, sem depender de roteamento de foco do browser
 *   5. Lê input.value na sessão do iframe → VERIFICA que digitou de fato
 *
 * Fallback (roteamento de foco): se a sessão OOPIF não anexar, usa o
 * caminho antigo — teclas na sessão da página confiando no foco.
 *
 * @param {object} cdp         - sessão CDP da página
 * @param {string} containerId - id do div container sem # (ex: 'mp-card-number')
 * @param {string} texto       - valor a digitar (só dígitos usados para PCI)
 * @param {object} [opts]      - media, desvio, pausasBloco
 * @param {Function} log       - função de log
 * @returns {Promise<boolean>} true SOMENTE quando o readback confirma o
 *          valor no campo — o caller deve falhar o step se vier false.
 *
 * Sempre lê o valor atual antes de digitar: os campos MP podem reter
 * valor entre remontagens (Step 3 re-tokeniza os mesmos campos do Step 2).
 * Igual ao esperado → confirma sem digitar; divergente → limpa e digita.
 */
async function digitarEmIframe(cdp, containerId, texto, { media = 180, desvio = 50, pausasBloco = false } = {}, log = () => {}) {
  const chars = [...String(texto).replace(/\D/g, '')];
  if (!chars.length) return true;

  // Clique no container → foca o iframe visualmente (evento trusted).
  const ok = await cdp.clicarSeletor(`#${containerId}`);
  if (!ok) throw new Error(`Container #${containerId} não encontrado no DOM.`);

  // Aguarda o iframe do MP montar dentro do container (proxy pode atrasar).
  // Tenta até 15s — com proxy a carga do SDK mlstatic pode demorar.
  const q = JSON.stringify(`#${containerId} iframe`);
  let iframeClicado = false;
  for (let t = 0; t < 50; t++) {
    const coords = await cdp.evaluate(`(() => {
      const f = document.querySelector(${q});
      if (!f) return null;
      const r = f.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return [Math.round(r.left + r.width * 0.3), Math.round(r.top + r.height / 2)];
    })()`);
    if (Array.isArray(coords)) {
      await cdp.clickAt(coords[0], coords[1]);
      iframeClicado = true;
      log('iframe', `${containerId}: iframe localizado e clicado (tentativa ${t + 1})`);
      break;
    }
    await delay(300);
  }
  if (!iframeClicado) {
    log('iframe', `${containerId}: iframe filho não apareceu em 15s — clique no container usado`);
  }
  // Pausa extra para o iframe processar o foco — especialmente importante com proxy.
  await delay(randomInt(400, 800));

  log('iframe', `${containerId}: digitando ${chars.length} dígitos`);
  const esperado = chars.join('');

  /**
   * Trecho JS compartilhado: escolhe o input "de verdade" dentro do frame.
   * Frames do MP podem renderizar mais de um input (honeypots/ocultos) —
   * filtra os visíveis e prefere o que tem atributos de campo de cartão.
   * Declarado como `inp` para uso dentro de IIFEs de Runtime.evaluate.
   */
  const exprInput = `const ins=[...document.querySelectorAll('input')].filter(i=>i.getClientRects().length);const inp=ins.find(x=>/cc-|number|expir|csc|cvv|security|code/i.test([x.name,x.getAttribute('autocomplete')||'',x.placeholder||'',x.id||''].join(' ')))||ins[0]||document.querySelector('input');`;

  /** Lê o valor atual do input dentro do frame anexado. */
  const lerValor = async (sessao) => {
    const l = await cdp.send('Runtime.evaluate', {
      expression: `(() => { ${exprInput} return inp?.value ?? ''; })()`,
      returnByValue: true,
    }, sessao).catch(() => null);
    return String(l?.result?.value ?? '');
  };

  // --- Caminho principal: sessão OOPIF direta no frame PCI ----------------
  // Até 3 tentativas completas: anexa → foca → digita → LÊ O VALOR.
  // O bot só avança quando o readback confirma os dígitos no campo certo.
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const anexo = await anexarIframe(cdp, containerId, log).catch(() => null);
    const sessaoIframe = anexo?.sessionId ?? null;
    if (!sessaoIframe) {
      log('iframe', `${containerId}: sessão OOPIF não anexada (tentativa ${tentativa + 1}/3)`);
      continue;
    }
    log('iframe', `${containerId}: sessão OOPIF anexada (tentativa ${tentativa + 1}/3)`);

    // Sem Target.activateTarget o Chromium pode descartar
    // Input.dispatchKeyEvent destinado a um OOPIF inativo — a sessão
    // anexa e o focus() reporta ok, mas as teclas não pousam no campo.
    await cdp.send('Target.activateTarget', { targetId: anexo.targetId }).catch(() => {});

    // Leitura prévia: campo retido de montagem anterior (Step 3 re-tokeniza
    // os mesmos campos do Step 2). Igual → pula; divergente → limpa antes.
    const valorInicial = await lerValor(sessaoIframe);
    const digitosIniciais = valorInicial.replace(/\D/g, '');
    if (digitosIniciais === esperado) {
      log('iframe', `${containerId}: já contém o valor esperado — confirmado sem digitar`);
      await cdp.send('Target.detachFromTarget', { sessionId: sessaoIframe }).catch(() => {});
      return true;
    }
    if (digitosIniciais.length) {
      log('iframe', `${containerId}: ${digitosIniciais.length} dígitos divergentes — limpando`);
      // Ctrl+A + Backspace — eventos trusted na sessão do frame (modifiers 2 = Ctrl).
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }, sessaoIframe);
      await delay(jitter(70));
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }, sessaoIframe);
      await delay(80);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace' }, sessaoIframe);
      await delay(jitter(90));
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace' }, sessaoIframe);
      await delay(150);
    }

    // Clique REAL dentro do frame, nas coordenadas do input — campos PCI
    // podem exigir pointerdown trusted para inicializar os handlers
    // internos; focus() via JS não dispara essa sequência.
    const rectInfo = await cdp.send('Runtime.evaluate', {
      expression: `(() => { ${exprInput} if(!inp) return null; const r=inp.getBoundingClientRect(); return [Math.round(r.left+r.width/2), Math.round(r.top+r.height/2)]; })()`,
      returnByValue: true,
    }, sessaoIframe);
    const rc = rectInfo?.result?.value;
    if (Array.isArray(rc)) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rc[0], y: rc[1], button: 'left', buttons: 1, clickCount: 1 }, sessaoIframe).catch(() => {});
      await delay(jitter(70));
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rc[0], y: rc[1], button: 'left', buttons: 0, clickCount: 1 }, sessaoIframe).catch(() => {});
      await delay(randomInt(150, 350));
    }

    // Foca o input dentro do iframe (DOM do frame acessível pela sessão).
    const foco = await cdp.send('Runtime.evaluate', {
      expression: `(() => { ${exprInput} if(!inp) return 'sem-input'; inp.focus(); return document.activeElement===inp?'focado':'nao-focou'; })()`,
      returnByValue: true,
    }, sessaoIframe);
    log('iframe', `${containerId}: foco interno → ${foco?.result?.value ?? '?'}`);

    for (let i = 0; i < chars.length; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: chars[i], text: chars[i] }, sessaoIframe);
      await delay(jitter(85, { pct: 0.25 }));
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: chars[i] }, sessaoIframe);
      await delay(intervaloTecla(media, desvio));
      if (pausasBloco && (i + 1) % 4 === 0 && i + 1 < chars.length) {
        await delay(randomInt(400, 1400));
      }
    }

    // VERIFICAÇÃO: lê o valor real — compara só dígitos (o MP mascara com espaços).
    const valorReal = await lerValor(sessaoIframe);
    const digitosReais = valorReal.replace(/\D/g, '');
    await cdp.send('Target.detachFromTarget', { sessionId: sessaoIframe }).catch(() => {});

    if (digitosReais === esperado) {
      log('iframe', `${containerId}: ${digitosReais.length} dígitos confirmados no campo`);
      return true;
    }
    // Nunca logar o valor lido — pode conter dígitos do cartão.
    log('iframe', `${containerId}: divergiu — ${digitosReais.length}/${chars.length} dígitos (tentativa ${tentativa + 1}/3)`);
    await delay(500);
  }

  // --- Fallback final: roteamento de foco + verificação OOPIF --------------
  // As teclas vão pela sessão da página (dependem do foco real no frame),
  // mas a CONFIRMAÇÃO também é feita lendo o valor — nada passa sem prova.
  log('iframe', `${containerId}: OOPIF esgotado — fallback de foco com verificação`);
  for (let i = 0; i < chars.length; i++) {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: chars[i], text: chars[i] }, cdp.sessionId);
    await delay(jitter(85, { pct: 0.25 }));
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp',   key: chars[i] }, cdp.sessionId);
    await delay(intervaloTecla(media, desvio));
    if (pausasBloco && (i + 1) % 4 === 0 && i + 1 < chars.length) {
      await delay(randomInt(400, 1400));
    }
  }
  const anexoFinal = await anexarIframe(cdp, containerId, log).catch(() => null);
  const sessaoFinal = anexoFinal?.sessionId ?? null;
  if (sessaoFinal) {
    const valorFinal = await lerValor(sessaoFinal);
    await cdp.send('Target.detachFromTarget', { sessionId: sessaoFinal }).catch(() => {});
    if (valorFinal.replace(/\D/g, '') === esperado) {
      log('iframe', `${containerId}: confirmado via fallback (${esperado.length} dígitos)`);
      return true;
    }
  }
  log('iframe', `${containerId}: FALHOU — campo não confirmou em nenhuma tentativa`);
  return false;
}

/**
 * Step 2 — cartão novo.
 * Ordem visual real do DOM (CheckoutWizard):
 *   1. #mp-card-number    (iframe PCI — número)
 *   2. card_holder        (input nosso — nome no cartão)
 *   3. #mp-expiration-date (iframe PCI — validade)
 *   4. #mp-security-code  (iframe PCI — CVV)
 *   5. cpf_titular        (input nosso — CPF do titular)
 *   6. botão submit       (desabilitado até SDK pronto)
 */
/**
 * Devolve o foco à página principal após sair de um iframe PCI.
 *
 * Usa Input.dispatchMouseEvent via CDP (isTrusted: true) em coordenadas
 * neutras do cabeçalho da página — fora de qualquer campo ou iframe.
 * Não usar document.body.click() via evaluate: gera isTrusted:false,
 * detectável pelo antifraude do MP e pode não remover foco cross-origin.
 *
 * Coordenadas (20, 20): canto superior esquerdo — sempre área neutra
 * no layout do checkout (fora do formulário, fora dos iframes PCI).
 */
async function devolverFocoPagina(cdp) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: 20, y: 20,
    button: 'left', buttons: 1, clickCount: 1,
  }, cdp.sessionId);
  await delay(randomInt(30, 60));
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: 20, y: 20,
    button: 'left', buttons: 0, clickCount: 1,
  }, cdp.sessionId);
  await delay(80);
}

/**
 * Step 2 — cartão novo.
 * Ordem visual real do DOM (CheckoutWizard.tsx):
 *   1. #mp-card-number     — iframe PCI (número do cartão)
 *   2. card_holder         — input nosso (nome no cartão)
 *   3. #mp-expiration-date — iframe PCI (validade MM/AA)
 *   4. #mp-security-code   — iframe PCI (CVV)
 *   5. cpf_titular         — input nosso (CPF do titular)
 *   6. botão submit        — desabilitado até sdkPronto
 *
 * Atenção: após cada iframe, devolve o foco à página antes de
 * interagir com inputs normais — sem isso o digitar() vai pro iframe.
 */
async function step2Cartao(cdp, step, seletores, comprador, cartao, log) {
  log('step2', 'cartão — aguardando SDK MP estar pronto');
  const cad = step.cadencia_numero_cartao ?? {};
  const cadCvv = step.cadencia_validade_cvv ?? {};
  const media = jitter(cad.inter_key_interval_ms_medio ?? 190);
  const desvio = jitter(cad.inter_key_interval_ms_desvio ?? 50) || 45;

  // Aguarda botão submit habilitado — indica que o SDK carregou os iframes.
  // disabled={loading || !sdkPronto} no CheckoutWizard.
  for (let i = 0; i < 60; i++) {
    const habilitado = await cdp.evaluate(
      `(() => { const b = document.querySelector('form button[type="submit"]'); return b && !b.disabled; })()`
    );
    if (habilitado) { log('step2', `SDK pronto (${i * 500}ms)`); break; }
    await delay(500);
    if (i === 59) log('step2', 'SDK não habilitou botão em 30s — tentando mesmo assim');
  }

  // 1. Número do cartão (iframe PCI — 16 dígitos).
  const okNumero = await digitarEmIframe(cdp, 'mp-card-number', cartao.numero, {
    media, desvio, pausasBloco: Boolean(cad.pausas_entre_blocos_4_digitos),
  }, log);
  if (!okNumero) throw new Error('Número do cartão não confirmado no iframe.');
  await devolverFocoPagina(cdp);
  await delay(randomInt(400, 900));

  // 2. Nome no cartão (input nosso) — digitação verificada: o popup de
  // autofill do Chrome (dados de cartão/endereço) pode preencher o campo
  // ou engolir teclas; o readback garante o conteúdo real.
  const nomeHolder = cartao.nome_titular ?? `${comprador.first_name} ${comprador.last_name}`.toUpperCase();
  const okHolder = await digitarCampoVerificado(cdp, seletores.campoHolder, nomeHolder, { media, desvio }, log);
  if (!okHolder) throw new Error('Campo nome do titular não confirmou o valor digitado.');
  log('step2', `card_holder digitado (${nomeHolder.length} chars)`);
  await delay(randomInt(400, 800));

  // 3. Validade (iframe PCI — formato MMAA, 4 dígitos).
  // O campo do MP aceita só dígitos — a barra é inserida automaticamente.
  const validadeDigitos = String(cartao.validade ?? '').replace(/\D/g, '').slice(0, 4);
  const okValidade = await digitarEmIframe(cdp, 'mp-expiration-date', validadeDigitos, { media, desvio }, log);
  if (!okValidade) throw new Error('Validade não confirmada no iframe.');
  await devolverFocoPagina(cdp);
  await delay(randomInt(400, 800));

  // 4. CVV (iframe PCI — 3 ou 4 dígitos).
  const cvvDigitos = String(cartao.cvv ?? '').replace(/\D/g, '');
  const okCvv = await digitarEmIframe(cdp, 'mp-security-code', cvvDigitos, { media: jitter(cadCvv.inter_key_interval_ms_medio ?? 180), desvio }, log);
  if (!okCvv) throw new Error('CVV não confirmado no iframe.');
  await devolverFocoPagina(cdp);
  await delay(randomInt(400, 800));

  // 5. CPF do titular (input nosso — só dígitos; o campo formata via onInput).
  // soDigitos compara ignorando a máscara 000.000.000-00 aplicada pelo input.
  const cpfDigitos = String(cartao.cpf_titular ?? comprador.cpf ?? '').replace(/\D/g, '');
  const okCpf = await digitarCampoVerificado(cdp, seletores.campoCpfTitular, cpfDigitos, { media, desvio, soDigitos: true }, log);
  if (!okCpf) throw new Error('Campo CPF do titular não confirmou o valor digitado.');
  log('step2', `cpf_titular digitado (${cpfDigitos.length} chars)`);
  await delay(randomInt(400, 800));

  // 6. Submit — pausa humana de revisão antes de clicar.
  // clicarSubmit confirma hit-test e disabled antes de prosseguir.
  await delay(jitter(step.tempo_entre_montagem_iframe_e_submit_ms ?? 3000));
  const ok = await clicarSubmit(cdp, seletores.step2Submit, { log, nome: 'step2-submit' });
  if (!ok) throw new Error('Botão do Step 2 não respondeu ao clique.');
  // Step 3 re-renderiza #mp-card-number (re-tokenização completa) — o que
  // o distingue do Step 2 é a AUSÊNCIA do input card_holder no form.
  log('step2', 'submit confirmado → aguardando Step 3');
  for (let i = 0; i < 50; i++) {
    const noStep3 = await cdp.evaluate(`(() =>
      !!document.querySelector('#mp-card-number') &&
      !document.querySelector('form input[name="card_holder"]')
    )()`);
    if (noStep3) break;
    await delay(400);
    if (i === 49) throw new Error('Checkout não avançou ao Step 3 após salvar o cartão.');
  }
}

/**
 * Step 3 — re-tokenização completa + confirmação.
 *
 * O /preapproval do MP não aceita token gerado por cardId (só /v1/payments
 * aceita) — por isso o Step 3 re-exibe os 3 iframes PCI e gera um token
 * completo, igual ao Token1. Confirmado empiricamente: token completo
 * funciona; token de cardId retorna CC_VAL_433.
 *
 * Chamado em dois fluxos:
 *   a) após step2Cartao  → wizard avançou ao Step 3 (#mp-card-number sem card_holder)
 *   b) cartão já salvo   → wizard pulou o Step 2 direto ao Step 3
 *
 * Os campos do MP retêm valor entre remontagens — limparAntes garante
 * que a digitação não duplique dígitos já presentes.
 */
async function step3Confirmacao(cdp, step, seletores, cartao, log) {
  log('step3', 're-tokenização completa — aguardando iframes PCI');
  const cad = step.cadencia_numero_cartao ?? {};
  const cadCvv = step.cadencia_validade_cvv ?? {};
  const media = jitter(cad.inter_key_interval_ms_medio ?? 190);
  const desvio = jitter(cad.inter_key_interval_ms_desvio ?? 50) || 45;

  // Aguarda o iframe do número montar dentro de #mp-card-number
  // (o SDK remonta os 3 campos ao entrar no Step 3).
  log('step3', 'aguardando iframe montar em #mp-card-number');
  let iframePronto = false;
  for (let i = 0; i < 30; i++) {
    const temIframe = await cdp.evaluate(`(() => {
      const f = document.querySelector('#mp-card-number iframe');
      if (!f) return false;
      const r = f.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    })()`);
    if (temIframe) { iframePronto = true; log('step3', `iframe pronto (${i * 400}ms)`); break; }
    await delay(400);
  }
  if (!iframePronto) log('step3', 'iframe não confirmado — tentando mesmo assim');

  // Pausa humana de quem leu a tela antes de digitar.
  await delay(jitter(step.tempo_entre_step2_e_step3_ms ?? 2000));

  // 1. Número do cartão — a leitura prévia interna já trata valor retido.
  const okNumero = await digitarEmIframe(cdp, 'mp-card-number', cartao.numero, {
    media, desvio, pausasBloco: Boolean(cad.pausas_entre_blocos_4_digitos),
  }, log);
  if (!okNumero) throw new Error('Step 3: número do cartão não confirmado.');
  await devolverFocoPagina(cdp);
  await delay(randomInt(400, 900));

  // 2. Validade (iframe PCI — formato MMAA, só dígitos).
  const validadeDigitos = String(cartao.validade ?? '').replace(/\D/g, '').slice(0, 4);
  const okValidade = await digitarEmIframe(cdp, 'mp-expiration-date', validadeDigitos, { media, desvio }, log);
  if (!okValidade) throw new Error('Step 3: validade não confirmada.');
  await devolverFocoPagina(cdp);
  await delay(randomInt(400, 800));

  // 3. CVV (iframe PCI — 3 ou 4 dígitos).
  const cvvDigitos = String(cartao.cvv ?? '').replace(/\D/g, '');
  const okCvv = await digitarEmIframe(cdp, 'mp-security-code', cvvDigitos, {
    media: jitter(cadCvv.inter_key_interval_ms_medio ?? 180), desvio,
  }, log);
  if (!okCvv) throw new Error('Step 3: CVV não confirmado.');
  await devolverFocoPagina(cdp);
  await delay(randomInt(800, 2000));

  // Submit — clicarSubmit faz hit-test (elementFromPoint), tenta pontos
  // alternativos fora do PainelSessao e confirma disabled/navegação.
  const ok = await clicarSubmit(cdp, seletores.step3Submit, { log, nome: 'step3-submit' });
  if (!ok) throw new Error('Botão do Step 3 não respondeu ao clique.');
  log('step3', 'submit confirmado — assinatura em processamento');
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
  /** @deprecated Step 3 não usa mais #mp-cvv2 — re-tokenização completa
   *  com os mesmos containers do Step 2 (#mp-card-number etc.). Mantida
   *  para compatibilidade com matrizes antigas; não é mais consultada. */
  step3Cvv:       '#mp-security-code',
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
      // Ambos os caminhos renderizam #mp-card-number — o Step 3 re-tokeniza
      // o cartão completo (token de cardId não é aceito no /preapproval).
      // O que distingue os steps é o input card_holder: existe só no Step 2.
      // O DOM decide — o bot nunca presume qual variação ocorreu.
      await cdp.esperarSeletor(sel.step2CardNumber, 15000);
      const temHolder = await cdp.evaluate(
        `!!document.querySelector('form input[name="card_holder"]')`
      );

      if (temHolder) {
        if (steps.get(2)) await step2Cartao(cdp, steps.get(2), sel, comprador, cartao, log);
        else log('fluxo', 'Step 2 no DOM mas ausente na matriz — pulando execução');
      } else {
        // Cartão da sessão já salvo no MP — wizard pulou o Step 2.
        log('fluxo', 'variação: cartão já salvo — Step 3 direto (re-tokenização completa)');
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
