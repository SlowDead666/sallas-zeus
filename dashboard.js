/**
 * dashboard.js — JS do painel local do Zeus (/dashboard).
 *
 * Servido como arquivo estático (não inline) porque o header CSP do
 * servidor exige script-src 'self' — scripts embutidos no HTML seriam
 * bloqueados pelo browser.
 *
 * Funcionamento:
 *   - Faz polling em /api/bot/status/all a cada 1,5s.
 *   - Renderiza um card por bot com estado, fase atual, barra de
 *     etapas, erro (se houver) e os últimos 80 eventos do log.
 *   - Os timers ("Xs atrás") atualizam a cada 1s sem novo fetch.
 */

const ETAPAS_ORDEM = ['home', 'item', 'step1', 'step2', 'step3', 'checkout'];

/** Mapeia a tag do log para a classe CSS de cor correspondente. */
function tagClass(tag) {
  if (tag === 'step1') return 'tag-step1';
  if (tag === 'step2') return 'tag-step2';
  if (tag === 'step3') return 'tag-step3';
  if (tag === 'iframe') return 'tag-iframe';
  if (tag === 'erro' || tag === 'pagina') return 'tag-' + tag;
  return 'tag';
}

/** Escapa HTML antes de injetar texto do log no DOM. */
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Renderiza as linhas de log (mais recente no topo). */
function formatLog(eventos) {
  if (!eventos || !eventos.length) return '<div class="log-line" style="color:#475569">Sem eventos ainda.</div>';
  return eventos.slice().reverse().map(e => {
    const m = e.match(/^(\d{2}:\d{2}:\d{2}) \[([^\]]+)\] (.+)$/);
    if (!m) return `<div class="log-line">${escHtml(e)}</div>`;
    return `<div class="log-line"><span class="ts">${m[1]}</span> <span class="tag ${tagClass(m[2])}">[<b>${escHtml(m[2])}</b>]</span> ${escHtml(m[3])}</div>`;
  }).join('');
}

/** Deduz a etapa atual pelo último evento cujo tag está na ordem da jornada. */
function etapaAtual(eventos) {
  if (!eventos) return null;
  for (let i = eventos.length - 1; i >= 0; i--) {
    const m = eventos[i].match(/\[([^\]]+)\]/);
    if (m && ETAPAS_ORDEM.includes(m[1])) return m[1];
  }
  return null;
}

/** Formata diferença desde ts ISO como "Xs atrás" / "Xm Ys atrás". */
function tempoDecorrido(ts) {
  if (!ts) return '—';
  const diff = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (diff < 60) return diff + 's atrás';
  return Math.floor(diff / 60) + 'm ' + (diff % 60) + 's atrás';
}

/** Renderiza o card completo de um bot. */
function renderCard(bot) {
  const estado = bot.estado ?? 'vazio';
  const etapa = etapaAtual(bot.eventos);
  const etapas = bot.etapas ?? [];

  const badgeClass = { executando: 'badge-executando', concluido: 'badge-concluido', erro: 'badge-erro' }[estado] ?? 'badge-vazio';
  const badgeLabel = { executando: 'Executando', concluido: 'Concluído', erro: 'Erro' }[estado] ?? estado;
  const dotClass = { executando: 'dot-executando', concluido: 'dot-concluido', erro: 'dot-erro' }[estado] ?? '';

  const etapasHtml = ETAPAS_ORDEM.map(e => {
    const ok = etapas.includes(e);
    const ativa = !ok && etapa === e;
    const cls = ok ? 'etapa-ok' : ativa ? 'etapa-ativa' : '';
    return `<span class="etapa ${cls}">${e}</span>`;
  }).join('');

  return `
  <div class="card">
    <div class="card-header">
      <div style="display:flex;align-items:center;min-width:0">
        <span class="dot ${dotClass}"></span>
        <span class="card-number" title="${escHtml(bot.number)}">${escHtml(bot.number)}</span>
      </div>
      <span class="badge ${badgeClass}">${badgeLabel}</span>
    </div>
    <div class="card-body">
      <div class="meta">
        <div class="meta-item">
          <span class="meta-label">Fase atual</span>
          <span class="meta-value">${etapa ?? '—'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Atualizado</span>
          <span class="meta-value timer" data-ts="${bot.ts ?? ''}">${tempoDecorrido(bot.ts)}</span>
        </div>
        ${estado === 'erro' ? `<div class="meta-item"><span class="meta-label">Erro</span><span class="meta-value" style="color:#f87171;font-size:12px">${escHtml(bot.erro ?? '')}</span></div>` : ''}
      </div>
      <div class="progress">${etapasHtml}</div>
      <div class="log-wrap">${formatLog(bot.eventos)}</div>
    </div>
  </div>`;
}

/** Busca o status agregado e re-renderiza a grade de cards. */
async function atualizar() {
  try {
    const r = await fetch('/api/bot/status/all');
    const data = await r.json();
    const bots = (data.bots ?? []).sort((a, b) => new Date(b.ts || 0) - new Date(a.ts || 0));
    document.getElementById('root').innerHTML = bots.length
      ? `<div class="grid">${bots.map(renderCard).join('')}</div>`
      : '<div class="vazio">Nenhum bot registrado ainda.<br>Dispare um webhook para começar.</div>';
    document.getElementById('refresh-info').textContent = 'Atualizado: ' + new Date().toLocaleTimeString('pt-BR');
  } catch (e) {
    document.getElementById('refresh-info').textContent = 'Erro ao buscar status';
  }
}

// Atualiza os textos "Xs atrás" a cada segundo sem refazer fetch.
setInterval(() => {
  document.querySelectorAll('.timer[data-ts]').forEach(el => {
    el.textContent = tempoDecorrido(el.dataset.ts);
  });
}, 1000);

atualizar();
setInterval(atualizar, 1500);
