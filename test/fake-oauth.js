'use strict';
// Autor: Mateusz Bartoszewicz
// Fałszywe punkty OAuth2 Discorda używane przy logowaniu na stronie z tablicą:
//   POST /oauth2/token         kod "code-<numer osoby>" daje token "tok-<numer osoby>"
//   GET  /users/@me/guilds/<serwer>/member   token daje członka serwera (albo 404, gdy osoby nie ma na serwerze)
//   POST /oauth2/token/revoke  zapisuje odwołany token
//   GET  /oauth2/authorize     strona zgody: wraca na redirect_uri z kodem dla osoby loginAs (albo błędem consent_required)
const http = require('node:http');

class FakeOAuth {
  constructor({ clientId, clientSecret, guildId, members }) {
    Object.assign(this, { clientId, clientSecret, guildId, members });
    this.requests = [];
    this.revoked = [];
    this.authorizeRequests = [];
    this.loginAs = null;
    this.consentGiven = true;
    this.tamperState = false;
  }

  async start() {
    this.server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise((r) => this.server.listen(0, '127.0.0.1', r));
    this.port = this.server.address().port;
    return this;
  }

  get base() { return `http://127.0.0.1:${this.port}`; }

  async close() {
    this.server.closeAllConnections?.();
    await new Promise((r) => this.server.close(r));
  }

  handle(req, res, raw) {
    const url = new URL(req.url, 'http://x');
    const form = new URLSearchParams(raw);
    this.requests.push({ method: req.method, path: url.pathname, form: Object.fromEntries(form), auth: req.headers.authorization });
    const out = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'POST' && url.pathname === '/oauth2/token') {
      const code = form.get('code') || '';
      if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret || form.get('grant_type') !== 'authorization_code') {
        return out(401, { error: 'invalid_client' });
      }
      const m = /^code-(\d+)$/.exec(code);
      if (!m) return out(400, { error: 'invalid_grant' });
      return out(200, { access_token: `tok-${m[1]}`, token_type: 'Bearer', expires_in: 604800, scope: 'identify guilds.members.read' });
    }
    if (req.method === 'POST' && url.pathname === '/oauth2/token/revoke') {
      this.revoked.push(form.get('token'));
      return out(200, {});
    }
    // Strona zgody: osoba "zalogowana w Discordzie" to loginAs. Dopóki nie wyraziła zgody (consentGiven), prompt=none kończy się
    // błędem consent_required, jak przy pierwszym logowaniu. tamperState podmienia stan, żeby sprawdzić ochronę przed CSRF.
    if (req.method === 'GET' && url.pathname === '/oauth2/authorize') {
      const redirect = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      this.authorizeRequests.push(Object.fromEntries(url.searchParams));
      let target;
      if (url.searchParams.get('prompt') === 'none' && !this.consentGiven) {
        target = `${redirect}?error=consent_required&state=${encodeURIComponent(state)}`;
      } else {
        this.consentGiven = true;
        target = `${redirect}?code=code-${this.loginAs}&state=${encodeURIComponent(this.tamperState ? 'podmieniony' : state)}`;
      }
      res.writeHead(302, { location: target });
      res.end();
      return;
    }
    const m = /^\/users\/@me\/guilds\/(\d+)\/member$/.exec(url.pathname);
    if (req.method === 'GET' && m) {
      const t = /^Bearer tok-(\d+)$/.exec(req.headers.authorization || '');
      if (!t) return out(401, { message: '401: Unauthorized' });
      if (m[1] !== this.guildId || !this.members.includes(t[1])) return out(404, { message: 'Unknown Guild', code: 10004 });
      return out(200, { user: { id: t[1], username: `u${t[1].slice(-4)}` }, roles: [], joined_at: new Date().toISOString() });
    }
    return out(404, { message: 'nie ma' });
  }
}

module.exports = { FakeOAuth };
