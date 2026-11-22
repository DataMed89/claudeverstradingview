import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/pine.js';

const ALLOW_SAVE = z.boolean().optional().describe(
  'Allow TradingView to save over the open saved script. Needed only when a SAVED script has unsaved edits: '
  + 'adding/updating it on the chart makes TradingView save those edits as a new version of that script. '
  + 'With true, the edits are saved first, then the script is added/updated. Default false (refuse).'
);
const DISCARD_UNSAVED = z.boolean().optional().describe(
  'Switch away even if the open script has unsaved edits (they are dropped; saved versions are not touched). Default false (refuse).'
);

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get the Pine Script source of the script currently open in the editor', {}, async () => {
    try { return jsonResult(await core.getSource()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_set_source',
    'Replace the source of the script CURRENTLY OPEN in the Pine editor. It does not create or switch scripts: '
    + 'if a saved script is open, this edits that script, and a later pine_save / pine_smart_compile writes the edits into it. '
    + 'To start a separate script, call pine_new first (or pass source to pine_new). '
    + 'The result includes `script` (name, script_id, kind: saved/draft/new) so you can check which script you edited.', {
    source: z.string().describe('Pine Script source code to inject'),
  }, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_compile',
    'Click the editor\'s "Add to chart" / "Update on chart" button (found by data-qa-id, works in any UI language). '
    + 'Never clicks the save button. Refuses when the open script is a saved script with unsaved edits, because TradingView '
    + 'would save them over that script; pass allow_save: true if that is intended. Prefer pine_smart_compile, which also reports errors.', {
    allow_save: ALLOW_SAVE,
  }, async ({ allow_save }) => {
    try { return jsonResult(await core.compile({ allow_save })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {}, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_save',
    'Save the script currently open in the editor to the TradingView cloud. Clicks the editor\'s save button (by data-qa-id, any UI language); '
    + 'falls back to the editor API, then Cmd+S on macOS / Ctrl+S elsewhere. '
    + 'For a saved script this saves a new version OF THAT SCRIPT. For a new or draft script TradingView asks for a name '
    + '(prefilled from the indicator()/strategy() title); `name` overrides it, and the save is refused if another saved script already has that name. '
    + 'Waits until TradingView reports the script as saved. Typical new-script flow: pine_new → pine_save → pine_smart_compile.', {
    name: z.string().optional().describe('Name for a new or draft script (used only on first save). Defaults to the title in indicator()/strategy().'),
  }, async ({ name }) => {
    try {
      const result = await core.save({ name });
      return jsonResult(result, result.success === false);
    }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {}, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_smart_compile',
    'Add or update the open script on the chart, then report compile errors and whether a study was added. '
    + 'Clicks the "Add to chart" / "Update on chart" button by data-qa-id (any UI language); never clicks the save button. '
    + 'Refuses when the open script is a saved script with unsaved edits, because TradingView would save those edits as a new version of it; '
    + 'pass allow_save: true if that is intended. On a never-saved script TradingView adds it as a draft (version 0.1), so call pine_save first.', {
    allow_save: ALLOW_SAVE,
  }, async ({ allow_save }) => {
    try { return jsonResult(await core.smartCompile({ allow_save })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_new',
    'Create a NEW untitled Pine script in the editor (same as the script-name dropdown → "Create new"). '
    + 'The previously open script is not modified. Optionally fills it with `source`. '
    + 'Refuses if the open script has unsaved edits (pass discard_unsaved: true to drop them). '
    + 'Next: pine_save (with name), then pine_smart_compile.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
    source: z.string().optional().describe('Pine source to put in the new script (replaces the template)'),
    discard_unsaved: DISCARD_UNSAVED,
  }, async ({ type, source, discard_unsaved }) => {
    try { return jsonResult(await core.newScript({ type, source, discard_unsaved })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_open',
    'Switch the Pine editor to a saved script (same as "Open script…" / Cmd+O). The previously open script is not modified. '
    + 'Matches the exact name, then the exact title, then a unique substring (case-insensitive). '
    + 'Refuses if the open script has unsaved edits (pass discard_unsaved: true to drop them).', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
    discard_unsaved: DISCARD_UNSAVED,
  }, async ({ name, discard_unsaved }) => {
    try { return jsonResult(await core.openScript({ name, discard_unsaved })); }
    catch (err) { return jsonResult({ success: false, source: 'internal_api', error: err.message }, true); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {}, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  }, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  }, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
