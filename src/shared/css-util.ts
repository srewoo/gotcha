// Rewrite relative url(...) refs in a CSS string to absolute, resolved against
// the stylesheet's own location. WHY: a captured/fetched sheet is replayed from
// the extension origin (or inlined into a snapshot whose <base> is the page
// URL), so relative font/image URLs would otherwise resolve against the wrong
// origin and 404. Absolute/data/hash URLs are left untouched.
export function absolutizeCss(css: string, baseHref: string): string {
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (m: string, quote: string, url: string): string => {
      if (/^(?:data:|https?:|\/\/|#)/i.test(url)) return m;
      try {
        return `url(${quote}${new URL(url, baseHref).href}${quote})`;
      } catch {
        return m;
      }
    },
  );
}

// File extensions we treat as web fonts for data-URI inlining.
const FONT_EXT_RE = /\.(woff2|woff|ttf|otf|eot)(?:[?#]|$)/i;

// Absolute http(s) font URLs referenced by url(...) in a CSS string.
// WHY inline fonts (but not images): browsers enforce CORS on font fetches, so
// an absolutized cross-origin @font-face src still fails to load in the
// extension-origin replay iframe — leaving the replay with fallback fonts. A
// data: URI carries no origin and sidesteps CORS entirely. Background images
// don't need CORS, so absolutizeCss alone is enough for them.
export function findFontUrls(css: string): string[] {
  const urls = new Set<string>();
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const url = m[2]!;
    if (/^https?:\/\//i.test(url) && FONT_EXT_RE.test(url)) urls.add(url);
  }
  return [...urls];
}

export function fontMimeFor(url: string): string {
  const ext = (FONT_EXT_RE.exec(url)?.[1] ?? '').toLowerCase();
  switch (ext) {
    case 'woff2':
      return 'font/woff2';
    case 'woff':
      return 'font/woff';
    case 'ttf':
      return 'font/ttf';
    case 'otf':
      return 'font/otf';
    case 'eot':
      return 'application/vnd.ms-fontobject';
    default:
      return 'application/octet-stream';
  }
}

// Replace url(<font>) refs that have a data URI in the map; leave the rest as-is.
export function inlineFontUrls(css: string, dataByUrl: ReadonlyMap<string, string>): string {
  if (dataByUrl.size === 0) return css;
  return css.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/g,
    (m: string, quote: string, url: string): string => {
      const data = dataByUrl.get(url);
      return data ? `url(${quote}${data}${quote})` : m;
    },
  );
}
