import crypto from 'node:crypto';

export class TuyaClient {
  constructor({ clientId, clientSecret, baseUrl }) {
    if (!clientId) throw new Error('Falta TUYA_CLIENT_ID');
    if (!clientSecret) throw new Error('Falta TUYA_CLIENT_SECRET');

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.baseUrl = (baseUrl || 'https://openapi.tuyaeu.com').replace(/\/+$/, '');

    this.accessToken = null;
    this.tokenExpiresAt = 0;
    this.uid = null;
  }

  sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  sign({ method, pathAndQuery, bodyText = '', accessToken = '' }) {
    const t = Date.now().toString();
    const nonce = crypto.randomUUID();
    const contentHash = this.sha256(bodyText);

    const stringToSign =
      method + '\n' +
      contentHash + '\n\n' +
      pathAndQuery;

    const signInput =
      this.clientId +
      accessToken +
      t +
      nonce +
      stringToSign;

    const sign = crypto
      .createHmac('sha256', this.clientSecret)
      .update(signInput)
      .digest('hex')
      .toUpperCase();

    return { t, nonce, sign };
  }

  async request(method, path, body, accessToken = '') {
    const url = new URL(path, this.baseUrl);

    const bodyText =
      body === undefined ? '' : JSON.stringify(body);

    const { t, nonce, sign } = this.sign({
      method,
      pathAndQuery: url.pathname + url.search,
      bodyText,
      accessToken,
    });

    const headers = {
      client_id: this.clientId,
      t,
      nonce,
      sign_method: 'HMAC-SHA256',
      sign,
      'Content-Type': 'application/json',
    };

    if (accessToken) {
      headers.access_token = accessToken;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : bodyText,
    });

    const text = await response.text();

    let data;

    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        `Resposta Tuya no JSON (${response.status}): ${text.slice(0, 500)}`
      );
    }

    if (!response.ok || data.success === false) {
      const code = data.code ? ` [${data.code}]` : '';

      throw new Error(
        `Tuya API${code}: ${data.msg || data.message || response.statusText}`
      );
    }

    return data;
  }

  async getToken() {
    const data = await this.request(
      'GET',
      '/v1.0/token?grant_type=1',
      undefined,
      ''
    );

    const result = data.result || {};

    if (!result.access_token) {
      throw new Error('Tuya no ha retornat access_token');
    }

    this.accessToken = result.access_token;
    this.uid = result.uid || null;

    this.tokenExpiresAt =
      Date.now() +
      Number(result.expire_time || 7200) * 1000 -
      60000;

    return this.accessToken;
  }

  async ensureToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this.getToken();
    }

    return this.accessToken;
  }

  async getUid() {
    await this.ensureToken();

    if (!this.uid) {
      throw new Error('Tuya no ha retornat el UID de l’usuari');
    }

    return this.uid;
  }

  async get(path) {
    await this.ensureToken();

    try {
      const data = await this.request(
        'GET',
        path,
        undefined,
        this.accessToken
      );

      return data.result;
    } catch (error) {
      if (/token|access.?token|1010|1011|1012/i.test(error.message)) {
        await this.getToken();

        const data = await this.request(
          'GET',
          path,
          undefined,
          this.accessToken
        );

        return data.result;
      }

      throw error;
    }
  }

  async post(path, body = {}) {
    await this.ensureToken();

    const data = await this.request(
      'POST',
      path,
      body,
      this.accessToken
    );

    return data.result;
  }
}