/**
 * Where the browser keeps a participant's session token.
 *
 * sessionStorage (per tab) wins over localStorage (per browser), so several
 * tabs of one browser can be different participants of the same session —
 * that is what makes the multi-window demo work — while a normal participant
 * still gets back in after closing the tab.
 */
const key = (code: string) => `vqa:token:${code.toUpperCase()}`;

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback; // storage can be unavailable (private mode, blocked cookies)
  }
};

export function getToken(code: string): string | null {
  return safe(() => sessionStorage.getItem(key(code)) ?? localStorage.getItem(key(code)), null);
}

export function saveToken(code: string, token: string, opts: { tabOnly?: boolean } = {}) {
  safe(() => sessionStorage.setItem(key(code), token), undefined);
  if (!opts.tabOnly) safe(() => localStorage.setItem(key(code), token), undefined);
}

export function clearToken(code: string) {
  safe(() => sessionStorage.removeItem(key(code)), undefined);
  safe(() => localStorage.removeItem(key(code)), undefined);
}

/** Demo links carry the identity as `#token=…`; adopt it for this tab only and
 *  remove it from the address bar. */
export function adoptTokenFromHash(code: string): void {
  const match = /[#&]token=([^&]+)/.exec(window.location.hash);
  if (!match) return;
  saveToken(code, decodeURIComponent(match[1]), { tabOnly: true });
  history.replaceState(null, '', window.location.pathname + window.location.search);
}

/** A request to join a listed session that is still waiting for the host. */
export interface PendingJoinRequest {
  token: string;
  sessionId: string;
  sessionName: string;
  displayName: string;
}
const REQUEST_KEY = 'vqa:joinRequest';
export const getPendingRequest = () => safe(() => JSON.parse(sessionStorage.getItem(REQUEST_KEY) ?? 'null') as PendingJoinRequest | null, null);
export const storePendingRequest = (r: PendingJoinRequest | null) =>
  safe(() => (r ? sessionStorage.setItem(REQUEST_KEY, JSON.stringify(r)) : sessionStorage.removeItem(REQUEST_KEY)), undefined);

const NAME_KEY = 'vqa:name';
export const getLastName = () => safe(() => localStorage.getItem(NAME_KEY) ?? '', '');
export const rememberName = (name: string) => safe(() => localStorage.setItem(NAME_KEY, name), undefined);

const DEMO_KEY = 'vqa:demo';
export interface StoredDemo {
  code: string;
  identities: { name: string; role: string; token: string }[];
}
export const getStoredDemo = () => safe(() => JSON.parse(localStorage.getItem(DEMO_KEY) ?? 'null') as StoredDemo | null, null);
export const storeDemo = (demo: StoredDemo) => safe(() => localStorage.setItem(DEMO_KEY, JSON.stringify(demo)), undefined);
