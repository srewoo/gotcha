import type { Environment } from '@shared/types';

function parseBrowser(ua: string): string {
  const m =
    /(Edg|OPR|Chrome|Firefox|Safari)\/([\d.]+)/.exec(ua) ?? null;
  if (!m) return 'Unknown';
  const name = { Edg: 'Edge', OPR: 'Opera', Chrome: 'Chrome', Firefox: 'Firefox', Safari: 'Safari' }[m[1]] ?? m[1];
  return `${name} ${m[2].split('.')[0]}`;
}

function parseOs(ua: string): string {
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
  if (/Mac OS X ([\d_]+)/.test(ua)) {
    const v = /Mac OS X ([\d_]+)/.exec(ua)?.[1]?.replace(/_/g, '.') ?? '';
    return `macOS ${v}`;
  }
  if (/Android/.test(ua)) return 'Android';
  if (/(iPhone|iPad)/.test(ua)) return 'iOS';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Unknown';
}

export function captureEnvironment(): Environment {
  const ua = navigator.userAgent;
  return {
    url: location.href,
    userAgent: ua,
    browser: parseBrowser(ua),
    os: parseOs(ua),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    dpr: window.devicePixelRatio,
    locale: navigator.language,
    capturedAt: Date.now(),
  };
}
