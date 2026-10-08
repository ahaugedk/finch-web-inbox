// One public address for hosted links; local previews keep their own origin.
globalThis.FinchSite = (() => {
  const origin = 'https://mit.finch.dk';
  const previousHosts = new Set(['mcp.orderly.ai', 'finch.ahaugedk.chatgpt.site', 'orderly-agent-webmcp.ahaugedk.chatgpt.site']);
  function canonicalUrl(value) {
    const url = new URL(value);
    if (previousHosts.has(url.hostname) || url.hostname === 'mit.finch.dk') {
      url.protocol = 'https:'; url.host = 'mit.finch.dk';
    }
    return url;
  }
  function publicOrigin(requestUrl, configured) {
    const request = new URL(requestUrl);
    if (['localhost', '127.0.0.1', '[::1]'].includes(request.hostname)) return request.origin;
    if (configured) {
      const url = new URL(configured);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid PUBLIC_ORIGIN');
      return url.origin;
    }
    return canonicalUrl(request).origin;
  }
  function navigationRedirect(request, configured) {
    const url = new URL(request.url);
    if (!['GET', 'HEAD'].includes(request.method) || !['/', '/index.html'].includes(url.pathname) || !previousHosts.has(url.hostname)) return null;
    url.host = new URL(publicOrigin(request.url, configured)).host;
    url.protocol = 'https:';
    return url.href === request.url ? null : url.href;
  }
  function contactUrl(value) {
    return String(value).replace(/^mailto:hello@orderly\.ai(?=\?|$)/,'mailto:hello@finch.dk');
  }
  return Object.freeze({origin, canonicalUrl, publicOrigin, navigationRedirect, contactUrl});
})();
