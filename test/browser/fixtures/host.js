// Autor: Mateusz Bartoszewicz
// Tylko do testów. Udaje klienta Discorda po stronie RPC: odpowiada na uzgadnianie (HANDSHAKE) zdarzeniem READY i obsługuje
// komendy, z których korzysta tablica (AUTHORIZE, AUTHENTICATE, OPEN_EXTERNAL_LINK). Kształty odpowiedzi odpowiadają
// schematom z Embedded App SDK 2.3.1, więc prawdziwe SDK przechodzi tu pełną ścieżkę uruchomienia.
(function () {
  var params = new URLSearchParams(window.location.search);
  var frame = document.getElementById('f');
  var calls = [];
  window.__calls = calls;
  window.__failAuthenticate = params.get('noauth') === '1'; // odpowiedź nie przechodzi walidacji SDK: komenda "wisi"
  var qs = new URLSearchParams({
    frame_id: 'frame-1', instance_id: 'instance-1', platform: params.get('platform') || 'desktop',
    guild_id: '111', channel_id: '222',
  });
  frame.src = '/?' + qs.toString();

  function reply(payload) { frame.contentWindow.postMessage([1, payload], '*'); }

  window.addEventListener('message', function (ev) {
    if (ev.source !== frame.contentWindow) return;
    var msg = ev.data;
    if (!Array.isArray(msg)) return;
    var op = msg[0];
    var data = msg[1];
    if (op === 0) {
      calls.push({ cmd: 'HANDSHAKE', args: data });
      reply({ cmd: 'DISPATCH', evt: 'READY', nonce: null, data: { v: 1, config: { api_endpoint: '//discord.test/api', environment: 'production', cdn_host: 'cdn.discordapp.com' } } });
      return;
    }
    if (op !== 1) return;
    calls.push({ cmd: data.cmd, args: data.args });
    var nonce = data.nonce;
    if (data.cmd === 'AUTHORIZE') {
      reply({ cmd: 'AUTHORIZE', evt: null, nonce: nonce, data: { code: params.get('code') || 'zly-kod' } });
    } else if (data.cmd === 'AUTHENTICATE') {
      if (window.__failAuthenticate) return;
      reply({
        cmd: 'AUTHENTICATE', evt: null, nonce: nonce,
        data: {
          access_token: data.args.access_token,
          user: { username: 'tester', discriminator: '0', id: '1', avatar: null, public_flags: 0 },
          scopes: ['identify', 'guilds.members.read'], expires: '2030-01-01T00:00:00.000000+00:00',
          application: { description: '', id: '1', name: 'Tablica' },
        },
      });
    } else if (data.cmd === 'OPEN_EXTERNAL_LINK') {
      reply({ cmd: 'OPEN_EXTERNAL_LINK', evt: null, nonce: nonce, data: { opened: true } });
    } else {
      reply({ cmd: data.cmd, evt: 'ERROR', nonce: nonce, data: { code: 4000, message: 'Nieobsługiwane w teście' } });
    }
  });
})();
