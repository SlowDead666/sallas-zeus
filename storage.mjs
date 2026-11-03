import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { join } from 'node:path';

/** Valores iniciais: true seleciona o webhook; false seleciona o valor local/NST. */
export const defaults = {
  baseUrl: 'http://localhost:8848/api/v2', apiKey: '',
  proxyFromWebhook: true, userAgentFromWebhook: true,
  urlFromWebhook: true, tipoFromWebhook: true,
  defaultUrl: '', defaultTipo: 'normal', country: 'BR', sessionDuration: 10,
};

/** Persiste configurações cifradas; a chave fica na pasta local, protegida também pelo usuário do SO. */
export async function createStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'key');
  let key;
  try { key = await readFile(keyPath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = randomBytes(32);
    await writeFile(keyPath, key, { mode: 0o600, flag: 'wx' });
  }
  const path = join(directory, 'settings.enc');
  /** Gravação atômica evita configurações parcialmente escritas. */
  async function save(settings) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(settings)), cipher.final()]);
    await writeFile(`${path}.tmp`, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
  }
  let settings;
  try {
    const data = await readFile(path);
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    settings = { ...defaults, ...JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()])) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    settings = { ...defaults, webhookToken: randomBytes(32).toString('hex') };
    await save(settings);
  }
  return {
    get: () => ({ ...settings }),
    /** Atualiza a memória somente após a persistência concluir. */
    async set(next) { await save(next); settings = { ...next }; },
  };
}
