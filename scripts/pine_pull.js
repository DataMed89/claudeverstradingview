#!/usr/bin/env node
// Pull current Pine Script source from TradingView editor → scripts/current.pine
// Uses the same CDP target selection as the MCP server and pine_push.js.
import { writeFileSync } from 'fs';
import { getSource } from '../src/core/pine.js';
import { disconnect } from '../src/connection.js';

try {
  const { source } = await getSource();
  const outPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
  writeFileSync(outPath, source);
  console.log(`Pulled ${source.split('\n').length} lines → scripts/current.pine`);
} catch (err) {
  console.error(`Could not read Pine editor: ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnect();
}
