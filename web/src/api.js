// Autor: Mateusz Bartoszewicz
// Klient API. W Activity zapytania idą przez /.proxy i z nagłówkiem Authorization; w przeglądarce sesję niesie ciasteczko.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TIMEOUT_MS = 15000;
const ctx = { prefix: '', bearer: null, reauth: null };
let reauthRun = null;

export function configureApi(options) {
  Object.assign(ctx, options);
}

// Jedno ponowne logowanie naraz, nawet gdy kilka zapytań dostanie 401 jednocześnie.
function reauthOnce() {
  if (!ctx.reauth) return Promise.resolve(false);
  if (!reauthRun) reauthRun = Promise.resolve().then(ctx.reauth).catch(() => false).finally(() => { reauthRun = null; });
  return reauthRun;
}

export async function api(method, path, body, { etag = null } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const headers = {};
    if (ctx.bearer) headers.Authorization = `Bearer ${ctx.bearer}`;
    if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
    if (etag) headers['If-None-Match'] = etag;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    let text;
    try {
      res = await fetch(`${ctx.prefix}${path}`, {
        method, headers, signal: controller.signal, credentials: 'same-origin',
        body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
      });
      text = res.status === 304 ? '' : await res.text();
    } catch {
      throw new ApiError(0, 'Brak połączenia z serwerem.');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 && attempt === 0 && (await reauthOnce())) continue;
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    if (res.status === 304) return { status: 304, data: null, etag };
    if (!res.ok) throw new ApiError(res.status, (data && data.error) || 'Coś poszło nie tak. Spróbuj za chwilę.');
    return { status: res.status, data, etag: res.headers.get('ETag') };
  }
  throw new ApiError(401, 'Zaloguj się ponownie.');
}
