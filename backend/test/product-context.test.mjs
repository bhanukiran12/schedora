// Route/context matrix of docs/PRODUCT_SHELL.md (frontend/js/context.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalRedirect, contextFor, hostInfo, isAppRoute, isPublicRoute, landingUrl, productUrl, safeReturnPath } from '../../frontend/js/context.mjs';

const D = 'schedora.in';
const ID = '0b7d3c1e-2f4a-4b5c-8d9e-0f1a2b3c4d5e';
const loc = (hostname, port = '') => ({ hostname, protocol: hostname.endsWith('localhost') ? 'http:' : 'https:', port });

test('the host fixes the product for workspace, account and demo pages', () => {
  for (const [host, product] of [['meet.schedora.in', 'meet'], ['book.schedora.in', 'meet'], ['forms.schedora.in', 'forms'], ['flow.schedora.in', 'flow'], ['meet.localhost', 'meet']]) {
    for (const path of ['/', '/account', '/login', '/signup', '/billing', '/enquiries', '/start', '/start/products', '/demo', '/privacy']) assert.equal(contextFor(host, path, D), product, `${host}${path}`);
  }
  assert.equal(contextFor('schedora.in', '/account', D), 'suite', 'the apex domain is Suite');
  assert.equal(contextFor('localhost', '/account', D), 'suite');
  assert.equal(contextFor('schedora.in', '/meet', D), 'meet', 'routes still name a product on the apex domain');
  assert.equal(contextFor('localhost', '/demo/forms', D), 'forms');
  assert.equal(contextFor('localhost', '/setup', D), 'suite');
  assert.equal(contextFor('localhost', '/setup/forms', D), 'forms');
  assert.equal(contextFor('meet.schedora.in', '/setup', D), 'meet');
  assert.ok(isAppRoute('/setup') && isAppRoute('/setup/meet') && isAppRoute('/setup/forms') && isAppRoute('/setup/flow'));
  assert.equal(contextFor('www.schedora.in', '/account', D), 'suite', 'unknown subdomains are not product hosts');
  assert.equal(contextFor('meet.localhost', '/flow/runs', D), 'flow', 'another product workspace page keeps its own product where hosts do not redirect');
  assert.deepEqual(hostInfo('evil-meet.schedora.in.example', D), { base: null, product: null, production: false });
});

test('public pages keep their own identity on any host and are never redirected', () => {
  const publics = ['/meet/acme/intro-call', '/embed/meet/acme/intro-call', '/meet/manage/abcdefghijklmnopqrstuvwx', '/meet/room/abcdefghijklmnopqrstu', '/meet/join/' + 'a'.repeat(45), '/meet/poll/team-sync', '/meet/acme', '/recap/abcdefghijklmnopqrstuvwx', '/f/client-intake'];
  for (const path of publics) {
    assert.ok(isPublicRoute(path), path);
    for (const host of ['schedora.in', 'meet.schedora.in', 'forms.schedora.in', 'flow.schedora.in']) assert.equal(canonicalRedirect({ hostname: host, pathname: path, search: '?x=1' }, D), null, `${host}${path}`);
  }
  assert.equal(contextFor('flow.schedora.in', '/f/client-intake', D), 'forms', 'a public form on another host still shows Forms');
  assert.equal(contextFor('forms.schedora.in', '/meet/acme/intro-call', D), 'meet');
});

test('app routes move to their product host with path, query and hash; nothing else moves', () => {
  const at = (hostname, pathname, search = '', hash = '') => canonicalRedirect({ hostname, pathname, search, hash }, D);
  assert.equal(at('schedora.in', '/meet', '?tab=meetings', '#x'), 'https://meet.schedora.in/meet?tab=meetings#x');
  assert.equal(at('schedora.in', `/forms/${ID}/responses`, '?show=all'), `https://forms.schedora.in/forms/${ID}/responses?show=all`);
  assert.equal(at('meet.schedora.in', '/flow/runs'), 'https://flow.schedora.in/flow/runs', 'another product\'s app route');
  assert.equal(at('schedora.in', '/products/forms', '?source=old', '#features'), 'https://forms.schedora.in/?source=old#features');
  assert.equal(at('schedora.in', '/products/forms'), 'https://forms.schedora.in/');
  assert.equal(at('meet.schedora.in', '/products/meet'), 'https://meet.schedora.in/');
  for (const [host, path] of [['meet.schedora.in', '/meet'], ['meet.schedora.in', `/meet/event-types/${ID}`], ['forms.schedora.in', '/forms'], ['flow.schedora.in', '/flow/tasks'],
    ['schedora.in', '/'], ['schedora.in', '/account'], ['meet.schedora.in', '/account'], ['schedora.in', '/enquiries'], ['schedora.in', '/demo/meet'], ['schedora.in', '/start']]) {
    assert.equal(at(host, path), null, `${host}${path}`);
  }
  for (const host of ['localhost', 'meet.localhost', 'schedora-git-x.vercel.app', '127.0.0.1']) {
    assert.equal(at(host, '/forms'), null, `${host} never redirects across hosts`);
    assert.equal(at(host, '/products/meet'), null);
  }
  assert.ok(isAppRoute('/meet') && isAppRoute(`/meet/contacts/${ID}`) && isAppRoute('/flow/new') && isAppRoute('/account'));
  assert.ok(!isAppRoute('/meet/acme/intro-call') && !isAppRoute('/f/x'));
});

test('product links use subdomains on real hosts and path prefixes on plain local hosts', () => {
  assert.equal(productUrl('forms', '/forms', loc('meet.schedora.in'), D), 'https://forms.schedora.in/forms');
  assert.equal(productUrl('suite', '/account', loc('flow.schedora.in'), D), 'https://schedora.in/account');
  assert.equal(productUrl('flow', '/flow', loc('meet.localhost', '3000'), D), 'http://flow.localhost:3000/flow');
  assert.equal(productUrl('flow', '/flow', loc('127.0.0.1', '3000'), D), '/flow');
  assert.equal(landingUrl('meet', loc('schedora.in'), D), 'https://meet.schedora.in/');
  assert.equal(landingUrl('meet', loc('127.0.0.1', '3000'), D), '/products/meet');
});

test('password sign-in returns only to same-host paths', () => {
  for (const value of ['/meet?tab=meetings', '/account', '/flow/runs']) assert.equal(safeReturnPath(value, '/meet'), value);
  for (const value of ['//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/meet x', null]) assert.equal(safeReturnPath(value, '/meet'), '/meet', String(value));
});


test('all ten Meet sections remain discoverable and editor routes retain the correct active section', async () => {
  const { NAVIGATION, currentSection } = await import('../../frontend/js/products.mjs');
  const entries = NAVIGATION.meet.flatMap(([,items]) => items);
  assert.equal(entries.length, 10);
  assert.equal(new Set(entries.map(([key]) => key)).size, 10);
  for (const [key,,href] of entries) assert.equal(currentSection('meet', '/meet', new URL(href, 'https://meet.schedora.in').searchParams), key);
  assert.equal(currentSection('meet', '/meet/event-types/new', new URLSearchParams()), 'types');
  assert.equal(currentSection('flow', '/flow/tasks', new URLSearchParams()), 'tasks');
});
