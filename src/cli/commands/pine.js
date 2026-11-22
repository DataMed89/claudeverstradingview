import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current Pine Script source from editor',
      handler: () => core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source });
      },
    }],
    ['compile', {
      description: 'Add/update the open script on the chart and check errors (refuses to save over a saved script unless --allow-save)',
      options: {
        'allow-save': { type: 'boolean', description: 'Allow saving edits over the open saved script first' },
      },
      handler: (opts) => core.smartCompile({ allow_save: !!opts['allow-save'] }),
    }],
    ['raw-compile', {
      description: 'Click the add/update-on-chart button without checking errors',
      options: {
        'allow-save': { type: 'boolean', description: 'Allow saving edits over the open saved script first' },
      },
      handler: (opts) => core.compile({ allow_save: !!opts['allow-save'] }),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the open script (new scripts: --name, defaults to the indicator() title)',
      options: {
        name: { type: 'string', short: 'n', description: 'Name for a new or draft script' },
      },
      handler: async (opts) => {
        const result = await core.save({ name: opts.name });
        if (result.success === false) throw new Error(result.error);
        return result;
      },
    }],
    ['new', {
      description: 'Create a new untitled script (indicator, strategy, library); the open script is not modified',
      options: {
        file: { type: 'string', short: 'f', description: 'Fill the new script with this file' },
        'discard-unsaved': { type: 'boolean', description: 'Drop unsaved edits in the open script' },
      },
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        const source = opts.file ? readFileSync(opts.file, 'utf-8') : undefined;
        return core.newScript({ type, source, discard_unsaved: !!opts['discard-unsaved'] });
      },
    }],
    ['open', {
      description: 'Switch the editor to a saved script by name; the open script is not modified',
      options: {
        'discard-unsaved': { type: 'boolean', description: 'Drop unsaved edits in the open script' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script"');
        return core.openScript({ name: positionals.join(' '), discard_unsaved: !!opts['discard-unsaved'] });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      handler: () => core.listScripts(),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
