// This server is a shell, so nothing is reachable without the token.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function createAuth(port) {
  const token = randomBytes(32).toString('hex');
  // Cookies ignore the port, so two servers on 127.0.0.1 need different names.
  const cookieName = `accrete_ui_${port}`;
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const origins = hosts.map((host) => `http://${host}`);

  const isToken = (value) => {
    const a = Buffer.from(String(value));
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  return {
    token,
    setCookie: `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
    isToken,
    hostOk: (req) => hosts.includes(req.headers.host),
    originOk: (req) => origins.includes(req.headers.origin),
    hasCookie: (req) =>
      (req.headers.cookie ?? '').split(/;\s*/).some((pair) => {
        const eq = pair.indexOf('=');
        return pair.slice(0, eq) === cookieName && isToken(pair.slice(eq + 1));
      }),
  };
}
