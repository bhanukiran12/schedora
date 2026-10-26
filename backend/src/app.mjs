import http from 'node:http';
import { openDatabase } from './db.mjs';
import { openPostgres } from './postgres.mjs';
import { loadConfig, releaseWarnings } from './config.mjs';
import { createRateLimiter, send, clientAddress } from './http.mjs';
import { createApi } from './api.mjs';
import { createWeb, isSecure, securityHeaders } from './web.mjs';
import { createEmailProvider, createSmsProvider } from './platform/email.mjs';
import { createPayments } from './meet/payments.mjs';
import { oauthBusy } from './platform/oauth.mjs';
import { createAnthropic } from './ai/service.mjs';
import { assertPublicHost, fetchFeed } from './meet/calendar.mjs';
import { createWorker } from './worker.mjs';
import { createProviders } from './video/provider.mjs';
import { meetingCsp } from './video/config.mjs';

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

// Builds the application. Tests pass an in-memory database, fixed clock and fake providers.
export function createApp(options = {}) {
  const config = options.config || loadConfig(process.env, options.configOverrides);
  const db = options.db || (config.databaseUrl && !options.databasePath ? openPostgres(config.databaseUrl, { ca: config.databaseCa }) : openDatabase(options.databasePath ?? config.databasePath));
  const app = {
    config,
    db,
    csp: CSP,
    meetingCsp: null,
    now: options.now || (() => Date.now()),
    emailProvider: options.emailProvider || createEmailProvider(config),
    smsProvider: options.smsProvider || createSmsProvider(config),
    fetchWebhook: options.fetchWebhook || ((url, init) => fetch(url, init)),
    assertPublicHost: options.assertPublicHost || (url => assertPublicHost(url)),
    fetchProvider: options.fetchProvider || ((url, init) => fetch(url, init)),
    fetchCalendar: options.fetchCalendar || (url => fetchFeed(url)),
    rateLimit: createRateLimiter(),
    analytics: new Map(),
    log: options.log || ((level, message, fields = {}) => {
      if (level === 'info' && process.env.LOG_LEVEL === 'warn') return;
      process.stdout.write(JSON.stringify({ time: new Date().toISOString(), level, message, ...fields }) + '\n');
    })
  };
  app.meetingCsp = meetingCsp(config, CSP);
  // Video providers by deployment id; tests inject fakes with options.videoProviders.
  app.video = { providers: createProviders(config, options.videoProviders) };
  app.payments = createPayments(app, (url, init) => app.fetchProvider(url, init));
  app.oauthBusy = (connection, range) => oauthBusy(app, connection, range);
  app.anthropic = options.anthropic !== undefined ? options.anthropic : createAnthropic(config);
  app.worker = createWorker(app, { intervalMs: config.workerIntervalMs });
  app.nudge = () => app.worker.nudge();
  const api = createApi(app);
  const web = createWeb(app);

  app.server = http.createServer(async (request, response) => {
    const host = String(request.headers.host || '').split(':')[0].toLowerCase();
    let url;
    try { url = new URL(request.url, 'http://localhost'); } catch { return send(request, response, 400, 'text/plain', 'Bad request'); }
    const path = url.pathname;
    try {
      if (config.production && !isSecure(app, request) && !['localhost', '127.0.0.1'].includes(host) && path !== '/api/health') {
        const target = host && (host === config.productDomain || host.endsWith('.' + config.productDomain)) ? host : config.productDomain;
        response.writeHead(308, { Location: `https://${target}${request.url}` });
        return response.end();
      }
      securityHeaders(app, request, response);
      const retry = app.rateLimit('global:' + clientAddress(request, config.trustProxy, config.trustProxyHops), config.rateLimitPerMinute, 60000);
      if (retry) return send(request, response, 429, 'text/plain; charset=utf-8', 'Too many requests', { 'Retry-After': String(retry) });
      if (path.startsWith('/api/')) return await api(request, response, path, url);
      if (!config.serveFrontend) return send(request, response, 404, 'text/plain; charset=utf-8', 'Schedora API. The web app is served separately.');
      return await web(request, response, path, url);
    } catch (error) {
      app.log('error', 'unhandled', { error: error.message });
      if (!response.headersSent) send(request, response, 500, 'text/plain; charset=utf-8', 'Unable to load Schedora');
      else response.destroy();
    }
  });
  app.server.requestTimeout = 30000;
  app.server.headersTimeout = 20000;
  app.server.keepAliveTimeout = 65000;

  app.start = () => new Promise(resolve => {
    for (const warning of releaseWarnings(config)) app.log('warn', 'release_warning', { warning });
    app.worker.start();
    app.server.listen(options.port ?? config.port, options.host ?? config.host, resolve);
  });
  app.stop = async () => {
    app.worker.stop();
    await new Promise(resolve => app.server.close(resolve));
    if (!options.db) db.close();
  };
  return app;
}
