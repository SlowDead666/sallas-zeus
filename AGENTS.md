# Projeto Sallas Zeus

- Aplicação Node.js ESM, sem dependências externas. Requer Node.js 22.11 ou superior (fetch e WebSocket nativos).
- Iniciar: `npm start`. Porta padrão 3187; variável `PORT` permite escolher outra. Servidor escuta somente 127.0.0.1.
- Verificação: `npm test`, `npm run check` e `node --check config.js`.
- `/config`: painel local NST. `/webhook`: POST autenticado por `Authorization: Bearer <token do webhook>`.
- O token NST é distinto do token do webhook. Nunca registrar, retornar ou versionar o token NST.
- Configurações cifradas e chave local ficam em `.local/`, ignorada pelo Git. A chave permanece no mesmo computador; a cifragem não substitui permissões do sistema operacional.
- API NST v2: endereço padrão `http://localhost:8848/api/v2`, cabeçalho `x-api-key`. Proxy integrado exige NST 1.19.0+ e créditos.
- `number` deve ser string e é o nome literal do perfil. Busca parcial não autoriza exclusão. Duplicidades são erro explícito.
- `normal` exclui o perfil existente antes de recriar; `retentativa` nunca cria/exclui e preserva fingerprint/proxy, abrindo a URL por CDP em nova aba; `fechar` apenas fecha o navegador do perfil (perfil e dados preservados, url/UA não exigidos).
- Seletores booleanos terminados em `FromWebhook`: true usa webhook; false usa configuração local ou geração NST. Proxy ausente/vazio usa residencial integrado.
- Contrato estendido do webhook (opcionais): `fingerprint` (schema LaunchFingerprint do NST, repassado com whitelist), `platform`+`platformVersion` (obrigatório juntos; Linux recusado), `kernelMilestone` (3 dígitos; doc diz 132-140 mas cliente aceita todos instalados, ex: 153 — verificado na 1.23.2), `groupName`, `note`. `fingerprint.userAgent` tem prioridade sobre `user_agent` solto; sem fingerprint, `user_agent` segue obrigatório quando `userAgentFromWebhook=true`. A montagem do fingerprint é responsabilidade do sistema de origem (n8n+IA) — aqui só validamos formato e repassamos.
- Documentar funções e arquivos novos em português. Testes devem utilizar mocks e credenciais sintéticas; nunca operar perfis reais automaticamente.
- O usuário utiliza ngrok na porta 3187. Somente `/webhook` aceita o Host público configurado; `/config`, `/config.js` e `/api/config` permanecem locais. Cabeçalhos Forwarded/X-Forwarded-* também impedem acesso às configurações por proxy com Host reescrito. POST exige Bearer; GET do webhook retorna 405.
- O host público do ngrok é lido da variável de ambiente `NGROK_HOST`. Fallback: `pineal-transplanetary-lorretta.ngrok-free.dev`. Para trocar o túnel sem mudar código: `NGROK_HOST=novo-host.ngrok-free.app npm start`.
