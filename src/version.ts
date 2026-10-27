import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Read from package.json so the version reported to MCP clients never drifts. */
export const VERSION: string = (require('../package.json') as { version: string }).version;
