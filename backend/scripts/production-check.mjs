import { loadConfig } from '../src/config.mjs';
import { meetReadiness } from '../src/production.mjs';

try {
  const result = meetReadiness(loadConfig());
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ready ? 0 : 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
