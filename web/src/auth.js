// Autor: Mateusz Bartoszewicz
// Logowanie w dwóch trybach: Activity w Discordzie (przez Embedded App SDK) i zwykła strona (OAuth2 z ciasteczkiem sesji).
import { configureApi } from './api.js';

const SDK_READY_TIMEOUT_MS = 15000;
const AUTHENTICATE_TIMEOUT_MS = 6000;
const SCOPES = ['identify', 'guilds.members.read'];

export const isActivity = () => new URLSearchParams(window.location.search).has('frame_id');

const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
});

// SDK i serwer pośredniczący Discorda: zapytania do naszego serwera idą ścieżką /.proxy/..., sesja w nagłówku Authorization.
export async function startActivity(clientId) {
  const { DiscordSDK } = await import('@discord/embedded-app-sdk');
  const sdk = new DiscordSDK(clientId, { disableConsoleLogOverride: true });
  await withTimeout(sdk.ready(), SDK_READY_TIMEOUT_MS, 'Discord nie odpowiada. Zamknij Activity i uruchom je jeszcze raz.');

  async function login() {
    let code;
    try {
      ({ code } = await sdk.commands.authorize({
        client_id: clientId, response_type: 'code', state: '', prompt: 'none', scope: SCOPES,
      }));
    } catch (err) {
      throw new Error(err && err.message ? `Discord nie dał zgody: ${err.message}` : 'Discord nie dał zgody na logowanie.');
    }
    let res;
    try {
      res = await fetch('/.proxy/api/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
      });
    } catch {
      throw new Error('Brak połączenia z serwerem tablicy.');
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok || !data || typeof data.session !== 'string') {
      const e = new Error((data && data.error) || 'Logowanie nie powiodło się.');
      e.status = res.status;
      throw e;
    }
    configureApi({ bearer: data.session });
    // Potwierdzenie sesji po stronie klienta Discorda; nasza sesja działa także, gdyby ten krok się nie udał.
    // SDK nie kończy komendy, gdy odpowiedź nie przejdzie jego walidacji, więc bez limitu czasu start mógłby wisieć.
    try {
      await withTimeout(sdk.commands.authenticate({ access_token: data.access_token }), AUTHENTICATE_TIMEOUT_MS, 'authenticate: brak odpowiedzi');
    } catch { /* opcjonalne */ }
    return true;
  }

  configureApi({ prefix: '/.proxy', reauth: () => login().then(() => true, () => false) });
  await login();
  return {
    openLink: async (url) => { await sdk.commands.openExternalLink({ url }); },
  };
}

export function startWeb() {
  configureApi({ prefix: '', bearer: null, reauth: null });
  return {
    openLink: null, // zwykłe linki otwierają się w nowej karcie
  };
}

export const ERROR_TEXT = {
  stan: 'Logowanie wygasło albo zostało przerwane. Spróbuj jeszcze raz.',
  odmowa: 'Nie wyrażono zgody w Discordzie. Jeśli to pomyłka, zaloguj się jeszcze raz.',
  dostep: 'To konto nie ma dostępu do forum redakcji.',
  logowanie: 'Logowanie nie powiodło się. Spróbuj jeszcze raz.',
  limit: 'Za dużo prób logowania. Poczekaj minutę i spróbuj jeszcze raz.',
};
