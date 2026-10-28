// Product context from the trusted host and the route (docs/PRODUCT_SHELL.md). Plain functions
// with no browser dependencies, so the route matrix is unit-tested. Context only selects what is
// shown; it never grants access to a product.

export const PRODUCT_KEYS = ['meet', 'forms', 'flow'];
const SUBDOMAINS = { meet: 'meet', book: 'meet', forms: 'forms', flow: 'flow' };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

// Signed-in workspace pages that belong to one product.
const APP_ROUTES = {
  meet: new RegExp(`^/meet(?:/event-types/(?:new|${UUID})|/contacts/${UUID})?$`),
  forms: new RegExp(`^/forms(?:/${UUID}(?:/responses)?)?$`),
  flow: new RegExp(`^/flow(?:/(?:runs|tasks|new|${UUID}))?$`)
};
// Shared signed-in pages: they take the context of the host (Suite on the apex domain).
const SHARED_APP = /^\/(account|billing|enquiries|setup(?:\/(meet|forms|flow))?)$/;
// Pages anyone may open from a link. They keep their own identity and are never redirected.
const PUBLIC = [/^\/meet\/(manage|pay|room|join|poll)\//, /^\/(?:embed\/)?meet\/[a-z0-9-]{2,60}\/[a-z0-9-]{2,60}$/, /^\/meet\/[a-z0-9-]{2,60}$/, /^\/recap\//, /^\/f\//];

export const DASHBOARDS = { suite: '/', meet: '/meet', forms: '/forms', flow: '/flow' };

export function appOwner(path) {
  return PRODUCT_KEYS.find(key => APP_ROUTES[key].test(path)) || null;
}
export const isAppRoute = path => Boolean(appOwner(path)) || SHARED_APP.test(path);
export const isPublicRoute = path => !appOwner(path) && PUBLIC.some(pattern => pattern.test(path));

// The product a path names on its own (apex and local hosts).
export function routeProduct(path) {
  const landing = /^\/products\/(meet|forms|flow)$/.exec(path)?.[1];
  if (landing) return landing;
  if (path.startsWith('/meet') || path.startsWith('/embed/meet') || path.startsWith('/recap')) return 'meet';
  if (path.startsWith('/forms') || path.startsWith('/f/')) return 'forms';
  if (path.startsWith('/flow')) return 'flow';
  const demo = /^\/(?:demo|start|setup)\/(meet|forms|flow)(?:\/|$)/.exec(path)?.[1];
  return demo || 'suite';
}

/** host: { base, product, production } — base is the product domain, 'localhost' or null. */
export function hostInfo(hostname, productDomain) {
  const host = String(hostname).toLowerCase();
  for (const base of [productDomain, 'localhost'].filter(Boolean)) {
    const production = base === productDomain;
    if (host === base) return { base, product: null, production };
    if (host.endsWith('.' + base)) {
      const product = SUBDOMAINS[host.slice(0, -(base.length + 1))];
      if (product) return { base, product, production };
    }
  }
  return { base: null, product: null, production: false };
}

// The product whose identity the page shows.
export function contextFor(hostname, path, productDomain) {
  const { product } = hostInfo(hostname, productDomain);
  // Public pages and another product's workspace pages show the product they belong to.
  if (isPublicRoute(path)) return routeProduct(path);
  return appOwner(path) || product || routeProduct(path);
}

// Where a product lives: its subdomain on real hosts, its path prefix on plain local/preview hosts.
export function productOrigin(product, { hostname, protocol = 'https:', port = '' }, productDomain) {
  const info = hostInfo(hostname, productDomain);
  if (!info.base) return '';
  const suffix = info.production || !port ? '' : ':' + port;
  return `${info.production ? 'https:' : protocol}//${product === 'suite' ? '' : product + '.'}${info.base}${suffix}`;
}
export function productUrl(product, path, location, productDomain) {
  const origin = productOrigin(product, location, productDomain);
  return origin ? origin + path : path;
}
export function landingUrl(product, location, productDomain) {
  if (product === 'suite') return productUrl('suite', '/', location, productDomain);
  return hostInfo(location.hostname, productDomain).base ? productUrl(product, '/', location, productDomain) : `/products/${product}`;
}

/**
 * A full-page redirect that makes the address canonical, or null. Only between production hosts:
 * product landings and product app routes move to the product's subdomain with the same path,
 * query and hash. Public pages, shared pages and local hosts never move.
 */
export function canonicalRedirect({ hostname, pathname, search = '', hash = '' }, productDomain) {
  const info = hostInfo(hostname, productDomain);
  if (!info.production) return null;
  const landing = /^\/products\/(meet|forms|flow)$/.exec(pathname)?.[1];
  if (landing) return `https://${landing}.${productDomain}/${search}${hash}`;
  const owner = appOwner(pathname);
  if (owner && owner !== info.product) return `https://${owner}.${productDomain}${pathname}${search}${hash}`;
  return null;
}

// Same-host return path after password sign-in: an absolute path on this host, never "//host".
export const safeReturnPath = (value, fallback) => typeof value === 'string' && /^\/(?!\/)[^\s\\]*$/.test(value) ? value : fallback;
