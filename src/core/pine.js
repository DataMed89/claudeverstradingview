/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  await evaluate(`
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return;
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      else if (typeof bwb.showWidget === 'function') bwb.showWidget('pine-editor');
    })()
  `);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
  }
  return false;
}

// ── Pine editor controller (internal TradingView API) ──
//
// The Pine editor publishes a controller object through a React context. It has the methods the
// editor UI itself uses: openNewScript(type), showEditor({scriptIdPart, version}),
// getScriptIdVersion(), isModified(), isDraft(), setScript(src), saveScript(), getSource().
// We find it by walking the React fiber tree up from the editor header, which carries stable,
// language-independent data-qa-id attributes. Every write path in this file goes through this
// controller or through data-qa-id buttons, never through localized button labels.
//
// Stable selectors (checked on TradingView Desktop 3.5, French UI):
//   [data-qa-id="pine-script-title-button"]  script-name dropdown in the editor header
//   [data-qa-id="pine-script-save-button"]   save button (class has saved-/unsaved-)
//   [data-qa-id="add-script-to-chart"]       "Add to chart" / "Update on chart"
//   [data-name="rename-dialog"]              "Save script" naming dialog
//     [data-qa-id="ui-lib-Input-input"]      name input, prefilled from indicator()/strategy() title
//     [data-qa-id="save-btn"] / [data-qa-id="cancel-btn"]
export const PINE_SELECTORS = {
  titleButton: '[data-qa-id="pine-script-title-button"]',
  saveButton: '[data-qa-id="pine-script-save-button"]',
  addToChartButton: '[data-qa-id="add-script-to-chart"]',
  saveDialog: '[data-name="rename-dialog"]',
  saveDialogInput: '[data-qa-id="ui-lib-Input-input"]',
  saveDialogConfirm: '[data-qa-id="save-btn"]',
  saveDialogCancel: '[data-qa-id="cancel-btn"]',
};
const SEL = PINE_SELECTORS;

export const FIND_PINE_CTRL = `
  (function findPineEditorController() {
    function isCtrl(v) {
      return !!v && typeof v === 'object' && !!v._editorStore
        && typeof v.getScriptIdVersion === 'function'
        && typeof v.openNewScript === 'function'
        && typeof v.isModified === 'function';
    }
    var anchors = [
      document.querySelector('${SEL.titleButton}'),
      document.querySelector('${SEL.saveButton}'),
      document.querySelector('${SEL.addToChartButton}'),
      document.querySelector('.monaco-editor.pine-editor-monaco'),
    ];
    for (var a = 0; a < anchors.length; a++) {
      var el = anchors[a];
      if (!el) continue;
      var key = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      var f = key ? el[key] : null;
      for (var d = 0; d < 80 && f; d++) {
        var v = f.memoizedProps && f.memoizedProps.value;
        if (isCtrl(v)) return v;
        f = f.return;
      }
    }
    return null;
  })()
`;

// First visible element matching a selector (TradingView keeps hidden copies of some buttons).
const VISIBLE = (selector) => `
  (function() {
    var els = document.querySelectorAll('${selector}');
    for (var i = 0; i < els.length; i++) if (els[i].offsetParent !== null) return els[i];
    return null;
  })()
`;

// Describes the script the editor currently holds.
//   kind: 'saved'   – a saved script (has an id, not a draft)
//         'draft'   – an unsaved script TradingView stored as a draft (e.g. added to chart before saving)
//         'new'     – a brand-new untitled script (no id yet)
//         'unknown' – controller not found; only DOM hints are available
export const READ_PINE_STATE = `
  (function readPineState() {
    var titleEl = document.querySelector('${SEL.titleButton}');
    var title = titleEl ? titleEl.textContent.trim() : null;
    var saveBtn = ${VISIBLE(SEL.saveButton)};
    var cls = saveBtn ? String(saveBtn.className).split(' ') : [];
    var hasCls = function(prefix) { return cls.some(function(c) { return c.indexOf(prefix) === 0; }); };
    var saveButton = !saveBtn ? 'missing' : hasCls('unsaved-') ? 'unsaved' : hasCls('saved-') ? 'saved' : 'other';
    var ctrl = ${FIND_PINE_CTRL};
    if (!ctrl) {
      return { api: false, name: title, script_id: null, version: null, kind: 'unknown',
        modified: saveButton === 'unsaved' ? true : saveButton === 'saved' ? false : null, save_button: saveButton };
    }
    var idv = null, modified = null, draft = null, active = null;
    try { idv = ctrl.getScriptIdVersion(); } catch (e) {}
    try { modified = !!ctrl.isModified(); } catch (e) {}
    try { draft = !!ctrl.isDraft(); } catch (e) {}
    try { active = ctrl._editorStore.getEditorActiveScript(); } catch (e) {}
    var id = (idv && idv.scriptIdPart) || null;
    return {
      api: true,
      name: (active && (active.scriptName || active.scriptTitle)) || title,
      script_id: id,
      version: (idv && idv.version) || null,
      kind: !id ? 'new' : (draft ? 'draft' : 'saved'),
      modified: modified,
      save_button: saveButton,
    };
  })()
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const SCRIPT_TYPES = ['indicator', 'strategy', 'library'];

/** CDP Input modifier bitmask for the "command" key: Alt=1, Ctrl=2, Meta(Cmd)=4, Shift=8. */
export function keyModifierForPlatform(platform) {
  return /mac|darwin|iphone|ipad/i.test(String(platform || '')) ? 4 : 2;
}

/**
 * Switching the editor to another script (pine_new, pine_open) drops unsaved edits in the
 * current one. Returns an error message when that would happen, otherwise null.
 */
export function switchGuardError(state, { discard_unsaved = false } = {}) {
  if (!state || discard_unsaved) return null;
  if (state.modified) {
    return `The open script "${state.name}" has unsaved changes that would be lost. `
      + 'Save them first with pine_save, or pass discard_unsaved: true to drop them. Nothing was changed.';
  }
  return null;
}

/**
 * "Add to chart" / "Update on chart" on a saved script with unsaved edits makes TradingView save
 * those edits as a new version of that saved script. Returns an error message unless allowed.
 */
export function chartGuardError(state, { allow_save = false } = {}) {
  if (!state || allow_save) return null;
  if (state.kind === 'saved' && state.modified) {
    return `"${state.name}" (${state.script_id}) is a saved script with unsaved edits. `
      + 'Adding or updating it on the chart makes TradingView save those edits as a new version of that script. '
      + 'If that is intended, pass allow_save: true (or call pine_save first). '
      + 'If you meant to build a separate script, call pine_new first. Nothing was clicked.';
  }
  if (state.kind === 'unknown' && state.modified !== false) {
    return 'Could not identify the open script (TradingView\'s Pine editor API was not found) and it may have unsaved edits; '
      + 'adding it to the chart could save over a saved script. Pass allow_save: true to proceed anyway. Nothing was clicked.';
  }
  return null;
}

/**
 * Picks one saved script by name: exact scriptName, then exact scriptTitle, then a substring
 * match that must be unique. Case-insensitive. Throws when nothing or several scripts match.
 */
export function resolveScriptByName(scripts, name) {
  const target = String(name ?? '').trim().toLowerCase();
  if (!target) throw new Error('Script name is required.');
  const nameOf = s => String(s.scriptName || '').toLowerCase();
  const titleOf = s => String(s.scriptTitle || '').toLowerCase();
  let hits = scripts.filter(s => nameOf(s) === target);
  if (hits.length === 0) hits = scripts.filter(s => titleOf(s) === target);
  if (hits.length === 0) hits = scripts.filter(s => nameOf(s).includes(target) || titleOf(s).includes(target));
  if (hits.length === 0) throw new Error(`Script "${name}" not found. Use pine_list_scripts to see saved scripts.`);
  if (hits.length > 1) {
    throw new Error(`"${name}" matches ${hits.length} saved scripts: ${hits.map(s => `"${s.scriptName}"`).join(', ')}. Use the exact name.`);
  }
  return hits[0];
}

/** Returns the saved script (other than ownId) whose name equals `name`, case-insensitive, or null. */
export function findNameCollision(scripts, name, ownId = null) {
  const target = String(name ?? '').trim().toLowerCase();
  if (!target) return null;
  return scripts.find(s => String(s.scriptName || '').trim().toLowerCase() === target && s.scriptIdPart !== ownId) || null;
}

async function getPineState() {
  return evaluate(READ_PINE_STATE);
}

/** Opens the editor and returns its state; throws if the internal controller cannot be found. */
async function requirePineController() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');
  for (let i = 0; i < 15; i++) {
    const state = await getPineState();
    if (state?.api) return state;
    await sleep(200);
  }
  throw new Error('TradingView\'s internal Pine editor controller was not found (TradingView may have changed). '
    + 'Refusing to continue: the only fallback would write into whichever script is open. Nothing was changed.');
}

async function getKeyModifier() {
  try {
    const platform = await evaluate('navigator.platform');
    return keyModifierForPlatform(platform);
  } catch {
    return keyModifierForPlatform(process.platform);
  }
}

/** Presses Cmd/Ctrl + key with focus in the Monaco editor. */
async function pressEditorShortcut(key, code, keyCode) {
  await evaluate(`(function() { var m = ${FIND_MONACO}; if (m) m.editor.focus(); })()`);
  const modifiers = await getKeyModifier();
  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers, key, code, windowsVirtualKeyCode: keyCode });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', modifiers, key, code, windowsVirtualKeyCode: keyCode });
  return `${modifiers === 4 ? 'Cmd' : 'Ctrl'}+${key}`;
}

async function fetchSavedScriptsRaw() {
  const result = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return { error: 'pine-facade returned unexpected data' };
        return { scripts: data.map(function(s) {
          return { scriptIdPart: s.scriptIdPart, version: s.version, scriptName: s.scriptName, scriptTitle: s.scriptTitle };
        }) };
      })
      .catch(function(e) { return { error: e.message }; })
  `);
  if (result?.error) throw new Error(`Could not list saved scripts: ${result.error}`);
  return result?.scripts || [];
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  const script = await getPineState();
  return {
    success: true,
    lines_set: source.split('\n').length,
    script,
    warning: script?.kind === 'saved'
      ? `This edited the saved script "${script.name}" (${script.script_id}). pine_smart_compile / pine_save will write these edits into it. To work on a separate script, call pine_new first.`
      : undefined,
  };
}

/**
 * Clicks the editor's "Add to chart" / "Update on chart" button (by data-qa-id, any UI language).
 * Never falls back to the save button. Refuses when that would save over a saved script unless
 * allow_save is set; with allow_save it saves first so no confirmation dialog is left open.
 */
async function addToChart({ allow_save = false } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await getPineState();
  const guard = chartGuardError(before, { allow_save });
  if (guard) throw new Error(guard);

  let pre_save;
  if (allow_save && before?.modified && (before.kind === 'saved' || before.kind === 'unknown')) {
    pre_save = await save();
    if (!pre_save.success) throw new Error(`Saving before adding to chart failed: ${pre_save.error}`);
  }

  // Right after a save TradingView briefly swaps in a disabled "pending" button; wait for the real one.
  let label = null;
  for (let i = 0; i < 25 && !label; i++) {
    if (i > 0) await sleep(200);
    label = await evaluate(`
      (function() {
        var b = ${VISIBLE(SEL.addToChartButton)};
        if (!b || b.disabled) return null;
        var text = b.getAttribute('title') || b.getAttribute('aria-label') || b.textContent.trim() || 'add-script-to-chart';
        b.click();
        return text;
      })()
    `);
  }
  const method = label ? 'add_to_chart_button' : await pressEditorShortcut('Enter', 'Enter', 13);

  const warning = before?.kind === 'new'
    ? 'This script was never saved, so TradingView added it to the chart as a draft (version 0.1). Call pine_save to give it a name; ideally save before adding to the chart.'
    : undefined;

  return { before, label, method, pre_save, warning };
}

export async function compile({ allow_save = false } = {}) {
  const r = await addToChart({ allow_save });
  await sleep(2000);
  return {
    success: true,
    button_clicked: r.label || r.method,
    method: r.method,
    script: await getPineState(),
    pre_save: r.pre_save,
    warning: r.warning,
  };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

function isSavedState(state) {
  if (!state) return false;
  if (state.api) return !!state.script_id && state.kind === 'saved' && state.modified === false;
  return state.save_button === 'saved';
}

/**
 * Saves the script that is open in the editor.
 * - Clicks the editor's save button (by data-qa-id); falls back to the editor API, then to
 *   Cmd+S (macOS) / Ctrl+S.
 * - For a new or draft script TradingView asks for a name ("Save script" dialog, prefilled from the
 *   indicator()/strategy() title). `name` overrides it. The save is refused when another saved
 *   script already has that name.
 * - Waits until TradingView reports the script as saved, so a following add-to-chart links the
 *   chart to the saved script instead of a draft.
 */
export async function save({ name } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const before = await getPineState();
  if (isSavedState(before)) {
    return { success: true, action: 'nothing_to_save', script: before };
  }

  let saved = null;
  const savedScripts = async () => (saved ??= await fetchSavedScriptsRaw());
  if (name) {
    const clash = findNameCollision(await savedScripts(), name, before?.script_id);
    if (clash) {
      throw new Error(`A saved script named "${clash.scriptName}" already exists (${clash.scriptIdPart}). Choose another name. Nothing was saved.`);
    }
  }

  // 1. Trigger the save.
  let method = await evaluate(`
    (function() {
      var b = ${VISIBLE(SEL.saveButton)};
      if (!b || b.disabled) return null;
      b.click();
      return 'save_button';
    })()
  `);
  if (!method) {
    const viaApi = await evaluate(`
      (function() {
        var ctrl = ${FIND_PINE_CTRL};
        if (!ctrl || typeof ctrl.saveScript !== 'function') return false;
        Promise.resolve(ctrl.saveScript()).catch(function() {});
        return true;
      })()
    `);
    method = viaApi ? 'editor_api' : await pressEditorShortcut('s', 'KeyS', 83);
  }

  // 2. A naming dialog appears for new scripts and drafts.
  let dialog = null;
  for (let i = 0; i < 20 && !dialog; i++) {
    await sleep(200);
    dialog = await evaluate(`
      (function() {
        var d = document.querySelector('${SEL.saveDialog}');
        if (!d) return null;
        var input = d.querySelector('${SEL.saveDialogInput}') || d.querySelector('input');
        return { value: input ? input.value : null };
      })()
    `);
    if (!dialog && isSavedState(await getPineState())) break;
  }

  let finalName;
  if (dialog) {
    finalName = (name || dialog.value || '').trim();
    const cancel = () => evaluate(`
      (function() {
        var b = document.querySelector('${SEL.saveDialog} ${SEL.saveDialogCancel}');
        if (b) b.click();
      })()
    `);
    if (!finalName) {
      await cancel();
      throw new Error('The save dialog has no script name. Pass name. Nothing was saved.');
    }
    const clash = findNameCollision(await savedScripts(), finalName, before?.script_id);
    if (clash) {
      await cancel();
      throw new Error(`A saved script named "${clash.scriptName}" already exists (${clash.scriptIdPart}); saving under that name could overwrite it. Pass a different name. Nothing was saved.`);
    }
    const confirmed = await evaluate(`
      (function() {
        var d = document.querySelector('${SEL.saveDialog}');
        if (!d) return 'dialog_gone';
        var input = d.querySelector('${SEL.saveDialogInput}') || d.querySelector('input');
        var want = ${JSON.stringify(finalName)};
        if (input && input.value !== want) {
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, want);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        if (input && input.value !== want) return 'name_not_applied';
        var ok = d.querySelector('${SEL.saveDialogConfirm}');
        if (!ok || ok.disabled) return 'confirm_missing';
        ok.click();
        return 'clicked';
      })()
    `);
    if (confirmed !== 'clicked') {
      await cancel();
      throw new Error(`Could not confirm the save dialog (${confirmed}). Nothing was saved.`);
    }
  }

  // 3. Wait for TradingView to finish saving.
  let state = null;
  for (let i = 0; i < 50; i++) {
    state = await getPineState();
    if (isSavedState(state)) break;
    await sleep(200);
  }
  if (!isSavedState(state)) {
    const dialogOpen = await evaluate(`!!document.querySelector('${SEL.saveDialog}')`);
    return {
      success: false,
      error: dialogOpen
        ? 'The save dialog is still open; TradingView did not accept the save.'
        : 'TradingView did not report the script as saved within 10 s.',
      method,
      script: state,
      previous_script: before,
    };
  }

  return {
    success: true,
    action: dialog ? 'saved_new_script' : 'saved_new_version',
    method,
    name: finalName || state.name,
    script: state,
    previous_script: before,
    note: name && !dialog ? 'name was ignored: the script already had a name (TradingView only asks for one on first save).' : undefined,
  };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

export async function smartCompile({ allow_save = false } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const r = await addToChart({ allow_save });

  await sleep(2500);

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: r.label || r.method,
    method: r.method,
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
    script: await getPineState(),
    pre_save: r.pre_save,
    warning: r.warning,
  };
}

/**
 * Creates a NEW untitled script in the editor (same as "Create new > Indicator/Strategy/Library"
 * in the script-name dropdown). The previously open script is left untouched. Optionally fills
 * the new script with `source`.
 */
export async function newScript({ type = 'indicator', source, discard_unsaved = false } = {}) {
  if (!SCRIPT_TYPES.includes(type)) {
    throw new Error(`Unknown script type "${type}". Use one of: ${SCRIPT_TYPES.join(', ')}.`);
  }
  const before = await requirePineController();
  const guard = switchGuardError(before, { discard_unsaved });
  if (guard) throw new Error(guard);

  const result = await evaluateAsync(`
    (async function() {
      var ctrl = ${FIND_PINE_CTRL};
      if (!ctrl) return { error: 'Pine editor controller disappeared.' };
      await ctrl.openNewScript(${JSON.stringify(type)});
      var t0 = Date.now();
      while (ctrl.getScriptIdVersion() !== null && Date.now() - t0 < 5000) {
        await new Promise(function(r) { setTimeout(r, 100); });
      }
      if (ctrl.getScriptIdVersion() !== null) return { error: 'TradingView did not switch to a new untitled script.' };
      var src = ${source === undefined ? 'null' : JSON.stringify(source)};
      if (src !== null) await ctrl.setScript(src);
      return { ok: true };
    })()
  `);
  if (result?.error) throw new Error(`${result.error} Nothing was written to the previously open script.`);

  const after = await getPineState();
  if (!after || after.kind !== 'new') {
    throw new Error(`Expected a new untitled script, but the editor shows "${after?.name}" (${after?.kind}). Not continuing.`);
  }

  return {
    success: true,
    type,
    action: 'created_untitled_script',
    script: after,
    previous_script: before,
    source_set: source !== undefined,
    next_step: 'Call pine_save (with name) before pine_smart_compile. Adding an unsaved script to the chart links the chart to a draft (version 0.1).',
  };
}

/**
 * Switches the editor to a saved script (same as "Open script..." / Cmd+O). The previously open
 * script is left untouched. Fails rather than copying source into the wrong script.
 */
export async function openScript({ name, discard_unsaved = false }) {
  const before = await requirePineController();
  const match = resolveScriptByName(await fetchSavedScriptsRaw(), name);

  if (before.script_id === match.scriptIdPart) {
    return {
      success: true,
      action: 'already_open',
      name: match.scriptName,
      script_id: match.scriptIdPart,
      opened: true,
      script: before,
      note: before.modified ? 'The editor already shows this script, with unsaved edits.' : undefined,
    };
  }

  const guard = switchGuardError(before, { discard_unsaved });
  if (guard) throw new Error(guard);

  const target = { scriptIdPart: match.scriptIdPart, version: match.version };
  const result = await evaluateAsync(`
    (async function() {
      var ctrl = ${FIND_PINE_CTRL};
      if (!ctrl) return { error: 'Pine editor controller disappeared.' };
      var target = ${JSON.stringify(target)};
      if (typeof ctrl.showEditor === 'function') await ctrl.showEditor(target);
      else await ctrl._editorStore.fetchAndOpenScript(target);
      var t0 = Date.now(), idv = null, src = '';
      while (Date.now() - t0 < 8000) {
        idv = ctrl.getScriptIdVersion();
        if (idv && idv.scriptIdPart === target.scriptIdPart) {
          src = await ctrl.getSource();
          if (src) break;
        }
        await new Promise(function(r) { setTimeout(r, 150); });
      }
      return { lines: src ? src.split('\\n').length : 0 };
    })()
  `);
  if (result?.error) throw new Error(result.error);

  const after = await getPineState();
  if (after?.script_id !== match.scriptIdPart) {
    throw new Error(`TradingView did not switch the editor to "${match.scriptName}" (it shows "${after?.name}"). Nothing was injected.`);
  }

  return {
    success: true,
    action: 'opened',
    name: match.scriptName,
    script_id: match.scriptIdPart,
    version: after.version,
    lines: result?.lines,
    opened: true,
    script: after,
    previous_script: before,
    source: 'internal_api',
  };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
