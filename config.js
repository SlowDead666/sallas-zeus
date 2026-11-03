/** Controlador do painel: sem dependências, sem armazenamento de tokens no localStorage. */
const fields = ['baseUrl', 'proxyFromWebhook', 'userAgentFromWebhook', 'urlFromWebhook', 'tipoFromWebhook', 'defaultUrl', 'defaultTipo', 'country', 'sessionDuration'];
const form = document.getElementById('settings');
const status = document.getElementById('status');

/** Atualiza feedback acessível sem inserir HTML recebido do servidor. */
function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }

/** Requisições de mesma origem com tratamento uniforme de erros públicos. */
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json' } });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Falha ao acessar o servidor.');
  return result;
}

/** Indica se já há credencial sem recuperar o segredo NST. */
function keyState(configured) {
  document.getElementById('keyState').textContent = configured ? 'Token cadastrado. Deixe vazio para manter o atual.' : 'Nenhum token cadastrado. Cole seu token NST.';
}

/** Ajusta os controles fixos conforme o booleano de origem. */
function syncControls() {
  const urlFromWebhook = document.getElementById('urlFromWebhook').checked;
  document.getElementById('defaultUrl').required = !urlFromWebhook;
  document.getElementById('defaultTipo').disabled = document.getElementById('tipoFromWebhook').checked;
}

/** Carrega os valores persistidos e o token exclusivo do webhook no painel local. */
async function load() {
  try {
    const data = await api('/api/config');
    for (const field of fields) {
      const input = document.getElementById(field);
      if (input.type === 'checkbox') input.checked = data[field];
      else input.value = data[field];
    }
    keyState(data.apiKeyConfigured);
    document.getElementById('webhookUrl').textContent = data.webhookUrl;
    document.getElementById('webhookToken').value = data.webhookToken;
    syncControls();
  } catch (error) { message(error.message, true); }
}

/** Impede cliques duplicados enquanto uma operação de configuração estiver em andamento. */
async function busy(action) {
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try { await action(); } catch (error) { message(error.message, true); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
}

/** Serializa os seletores como booleanos reais, e não como strings on/off. */
form.addEventListener('submit', event => {
  event.preventDefault();
  busy(async () => {
    const body = {};
    for (const field of fields) {
      const input = document.getElementById(field);
      body[field] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    }
    body.country = body.country.toUpperCase();
    body.apiKey = document.getElementById('apiKey').value;
    const result = await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
    document.getElementById('apiKey').value = '';
    keyState(result.apiKeyConfigured);
    message('Configurações salvas.');
  });
});

/** Testa somente a configuração salva; não cria nem exclui perfis. */
document.getElementById('testConnection').addEventListener('click', () => busy(async () => {
  message('Conectando ao NST…');
  const result = await api('/api/config/test', { method: 'POST', body: '{}' });
  message(result.message);
}));

/** Copia apenas mediante ação explícita do usuário. */
document.getElementById('copyToken').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(document.getElementById('webhookToken').value); message('Token do webhook copiado.'); }
  catch { message('Não foi possível copiar. Use Mostrar e copie o token manualmente.', true); }
});

/** Alterna visibilidade temporária sem persistir o segredo no browser. */
document.getElementById('showToken').addEventListener('click', () => {
  const input = document.getElementById('webhookToken');
  input.type = input.type === 'password' ? 'text' : 'password';
});
form.addEventListener('change', syncControls);
load();
