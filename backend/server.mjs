import { createApp } from './src/app.mjs';

const app = createApp();
await app.start();
app.log('info', 'started', { url: app.config.baseUrl, listen: `${app.config.host}:${app.config.port}`, billing: app.config.billingMode, email: app.config.emailProvider });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.log('info', 'stopping', { signal });
    await app.stop();
    process.exit(0);
  });
}
