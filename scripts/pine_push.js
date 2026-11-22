#!/usr/bin/env node
// Push scripts/current.pine → TradingView Pine editor, then add/update it on the chart.
//
//   node scripts/pine_push.js                     push into the script open in the editor
//   node scripts/pine_push.js --new [type]        create a new untitled script first (indicator|strategy|library)
//   node scripts/pine_push.js --allow-save        allow saving the edits over the open SAVED script
//                                                 (TradingView saves a new version when a saved script is updated on the chart)
//   node scripts/pine_push.js --new --save "Name" create, save under a name, then add to chart
import { readFileSync } from 'fs';
import { parseArgs } from 'node:util';
import { newScript, setSource, save, smartCompile } from '../src/core/pine.js';
import { disconnect } from '../src/connection.js';

const { values, positionals } = parseArgs({
  options: {
    new: { type: 'boolean' },
    'allow-save': { type: 'boolean' },
    save: { type: 'string' },
  },
  allowPositionals: true,
});

const srcPath = new URL('../scripts/current.pine', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const src = readFileSync(srcPath, 'utf-8');

const describe = (s) => s ? `"${s.name}" (${s.kind}${s.script_id ? `, ${s.script_id} v${s.version}` : ''}${s.modified ? ', unsaved edits' : ''})` : 'unknown script';

try {
  if (values.new) {
    const type = positionals[0] || 'indicator';
    const created = await newScript({ type, source: src });
    console.log(`Created new untitled ${type} with ${src.split('\n').length} lines (previous script ${describe(created.previous_script)} untouched)`);
  } else {
    const set = await setSource({ source: src });
    console.log(`Pushed ${set.lines_set} lines → ${describe(set.script)}`);
    if (set.warning) console.log(`⚠️  ${set.warning}`);
  }

  if (values.save !== undefined) {
    const saved = await save({ name: values.save || undefined });
    if (!saved.success) throw new Error(saved.error);
    console.log(`Saved → ${describe(saved.script)}`);
  }

  const r = await smartCompile({ allow_save: !!values['allow-save'] });
  console.log(`Compile: ${r.button_clicked} → ${describe(r.script)}`);
  if (r.warning) console.log(`⚠️  ${r.warning}`);

  if (!r.has_errors) {
    console.log('✅ Compiled clean — 0 errors');
  } else {
    console.log(`❌ ${r.errors.length} errors:`);
    r.errors.forEach(e => console.log(`  Line ${e.line}: ${e.message}`));
  }
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exitCode = 1;
} finally {
  await disconnect();
}
