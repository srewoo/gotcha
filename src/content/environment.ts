import type { Environment } from '@shared/types';

function parseBrowser(ua: string): string {
  // Priority-ordered: real Edge/Opera UAs also contain a "Chrome/…" token (and
  // Chrome UAs contain "Safari/…"), so a single leftmost-match alternation
  // misreports them. Most-specific brand token wins.
  const checks: ReadonlyArray<[string, RegExp]> = [
    ['Edge', /Edg\/([\d.]+)/],
    ['Opera', /OPR\/([\d.]+)/],
    ['Chrome', /Chrome\/([\d.]+)/],
    ['Firefox', /Firefox\/([\d.]+)/],
    ['Safari', /Safari\/([\d.]+)/],
  ];
  for (const [name, re] of checks) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]!.split('.')[0]}`;
  }
  return 'Unknown';
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
