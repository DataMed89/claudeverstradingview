/**
 * Offline tests for the Pine editor safety logic (no TradingView connection needed).
 *
 * Background: pine_new used to replace the source of whatever script was open, and pine_open
 * copied another script's source into it; a following save/compile then overwrote the open saved
 * script. These tests pin down the guards, the script matching, the platform shortcut modifier,
 * the language-independent selectors, and the in-page controller/state detection.
 *
 * Run: node --test tests/pine_safety.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  keyModifierForPlatform,
  switchGuardError,
  chartGuardError,
  resolveScriptByName,
  findNameCollision,
  PINE_SELECTORS,
  FIND_PINE_CTRL,
  READ_PINE_STATE,
  SCRIPT_TYPES,
  newScript,
} from '../src/core/pine.js';

const saved = (over = {}) => ({ api: true, name: 'Momentum Composite', script_id: 'USER;3deb1ebf', version: '7.0', kind: 'saved', modified: false, ...over });

describe('keyModifierForPlatform', () => {
  it('uses Cmd (4) on macOS', () => {
    assert.equal(keyModifierForPlatform('MacIntel'), 4);
    assert.equal(keyModifierForPlatform('darwin'), 4);
  });
  it('uses Ctrl (2) elsewhere', () => {
    assert.equal(keyModifierForPlatform('Win32'), 2);
    assert.equal(keyModifierForPlatform('Linux x86_64'), 2);
    assert.equal(keyModifierForPlatform(''), 2);
    assert.equal(keyModifierForPlatform(undefined), 2);
  });
});

describe('switchGuardError (pine_new / pine_open)', () => {
  it('refuses to switch away from unsaved edits', () => {
    const msg = switchGuardError(saved({ modified: true }));
    assert.match(msg, /Momentum Composite/);
    assert.match(msg, /discard_unsaved/);
  });
  it('allows switching when discard_unsaved is set', () => {
    assert.equal(switchGuardError(saved({ modified: true }), { discard_unsaved: true }), null);
  });
  it('allows switching away from a clean script', () => {
    assert.equal(switchGuardError(saved()), null);
    assert.equal(switchGuardError({ ...saved(), kind: 'new', script_id: null }), null);
  });
});

describe('chartGuardError (pine_smart_compile / pine_compile)', () => {
  it('refuses add/update on a saved script with unsaved edits', () => {
    const msg = chartGuardError(saved({ modified: true }));
    assert.match(msg, /new version/);
    assert.match(msg, /allow_save/);
    assert.match(msg, /USER;3deb1ebf/);
  });
  it('allows it with allow_save', () => {
    assert.equal(chartGuardError(saved({ modified: true }), { allow_save: true }), null);
  });
  it('allows a clean saved script, a new script and a draft', () => {
    assert.equal(chartGuardError(saved()), null);
    assert.equal(chartGuardError({ ...saved(), kind: 'new', script_id: null, modified: true }), null);
    assert.equal(chartGuardError({ ...saved(), kind: 'draft', modified: true }), null);
  });
  it('fails closed when the script cannot be identified', () => {
    assert.ok(chartGuardError({ api: false, kind: 'unknown', modified: true }));
    assert.ok(chartGuardError({ api: false, kind: 'unknown', modified: null }));
    assert.equal(chartGuardError({ api: false, kind: 'unknown', modified: false }), null);
  });
});

describe('resolveScriptByName (pine_open)', () => {
  const scripts = [
    { scriptIdPart: 'A', version: '7.0', scriptName: 'Momentum Composite', scriptTitle: 'Momentum Composite' },
    { scriptIdPart: 'B', version: '1.0', scriptName: 'Momentum', scriptTitle: 'Momentum basic' },
    { scriptIdPart: 'C', version: '2.0', scriptName: 'Turtle D1 BTC', scriptTitle: 'Turtle D1 BTC' },
    { scriptIdPart: 'D', version: '3.0', scriptName: '7 moyennes mobiles', scriptTitle: '7 EMAs pour BTCUSD' },
  ];
  it('prefers an exact name over a substring match', () => {
    assert.equal(resolveScriptByName(scripts, 'momentum').scriptIdPart, 'B');
    assert.equal(resolveScriptByName(scripts, 'MOMENTUM COMPOSITE').scriptIdPart, 'A');
  });
  it('matches the exact title', () => {
    assert.equal(resolveScriptByName(scripts, '7 EMAs pour BTCUSD').scriptIdPart, 'D');
  });
  it('accepts a unique substring', () => {
    assert.equal(resolveScriptByName(scripts, 'turtle').scriptIdPart, 'C');
  });
  it('refuses an ambiguous substring and lists the candidates', () => {
    assert.throws(() => resolveScriptByName(scripts, 'mom'), /matches 2 saved scripts.*Momentum Composite.*Momentum/);
  });
  it('throws when nothing matches or the name is empty', () => {
    assert.throws(() => resolveScriptByName(scripts, 'nope'), /not found/);
    assert.throws(() => resolveScriptByName(scripts, '  '), /required/);
  });
});

describe('findNameCollision (pine_save)', () => {
  const scripts = [{ scriptIdPart: 'A', scriptName: 'Momentum Composite' }];
  it('finds another script with the same name, ignoring case and spaces', () => {
    assert.equal(findNameCollision(scripts, '  momentum composite ')?.scriptIdPart, 'A');
  });
  it('ignores the script itself and different names', () => {
    assert.equal(findNameCollision(scripts, 'Momentum Composite', 'A'), null);
    assert.equal(findNameCollision(scripts, 'Momentum Composite v2'), null);
    assert.equal(findNameCollision(scripts, ''), null);
  });
});

describe('language-independent selectors', () => {
  it('every Pine selector uses data-qa-id or data-name', () => {
    for (const [key, sel] of Object.entries(PINE_SELECTORS)) {
      assert.match(sel, /^\[data-(qa-id|name)="[a-z0-9-]+"\]$/i, `${key}: ${sel}`);
    }
  });

  for (const file of ['src/core/pine.js', 'scripts/pine_push.js']) {
    it(`${file} does not match English button labels or hard-code Ctrl`, () => {
      const code = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      assert.doesNotMatch(code, /\/[^/\n]*(add to chart|update on chart|save and add)[^/\n]*\/i/i, 'regex on an English label');
      assert.doesNotMatch(code, /===\s*'Save'/, 'equality with the English "Save" label');
      assert.doesNotMatch(code, /modifiers:\s*2\b/, 'hard-coded Ctrl modifier');
      assert.doesNotMatch(code, /className\.indexOf\('saveButton'\)/, 'save button picked by class as a compile fallback');
    });
  }
});

describe('newScript input validation', () => {
  it('rejects unknown types before touching TradingView', async () => {
    assert.deepEqual(SCRIPT_TYPES, ['indicator', 'strategy', 'library']);
    await assert.rejects(newScript({ type: 'banana' }), /Unknown script type/);
  });
});

// ── In-page code run against a fake DOM + React fiber tree ──

function fakePage({ ctrl, title = 'Turtle D1 BTC', saveClass = 'saveButton-x saved-x' } = {}) {
  const provider = { memoizedProps: { value: ctrl }, return: null };
  const mid = { memoizedProps: { className: 'x' }, return: provider };
  const host = { memoizedProps: {}, return: mid };
  const mk = (extra) => ({ offsetParent: {}, '__reactFiber$abc': host, ...extra });
  const els = {
    [PINE_SELECTORS.titleButton]: mk({ textContent: ` ${title} ` }),
    [PINE_SELECTORS.saveButton]: mk({ className: saveClass, textContent: 'Sauvegarder' }),
  };
  const document = {
    querySelector: (s) => els[s] || null,
    querySelectorAll: (s) => (els[s] ? [els[s]] : []),
  };
  return vm.createContext({ document });
}

function fakeCtrl({ idv = null, modified = false, draft = false, active = null } = {}) {
  return {
    _editorStore: { getEditorActiveScript: () => active },
    getScriptIdVersion: () => idv,
    isModified: () => modified,
    isDraft: () => draft,
    openNewScript: async () => {},
  };
}

describe('in-page controller detection', () => {
  it('finds the controller through the React fiber tree', () => {
    const ctrl = fakeCtrl();
    assert.equal(vm.runInContext(FIND_PINE_CTRL, fakePage({ ctrl })), ctrl);
  });
  it('returns null when no context value looks like the controller', () => {
    assert.equal(vm.runInContext(FIND_PINE_CTRL, fakePage({ ctrl: { _editorStore: {} } })), null);
  });

  it('classifies a saved script', () => {
    const ctrl = fakeCtrl({ idv: { scriptIdPart: 'USER;08045cb1', version: '2.0' }, active: { scriptName: 'Turtle D1 BTC' } });
    const s = vm.runInContext(READ_PINE_STATE, fakePage({ ctrl }));
    assert.equal(s.api, true);
    assert.equal(s.kind, 'saved');
    assert.equal(s.script_id, 'USER;08045cb1');
    assert.equal(s.version, '2.0');
    assert.equal(s.name, 'Turtle D1 BTC');
    assert.equal(s.modified, false);
    assert.equal(s.save_button, 'saved');
  });
  it('classifies a new untitled script and a draft', () => {
    const fresh = vm.runInContext(READ_PINE_STATE, fakePage({ ctrl: fakeCtrl({ draft: true, modified: true }), title: 'Script sans titre', saveClass: 'saveButton-x unsaved-x' }));
    assert.equal(fresh.kind, 'new');
    assert.equal(fresh.script_id, null);
    assert.equal(fresh.name, 'Script sans titre');
    assert.equal(fresh.save_button, 'unsaved');
    const draft = vm.runInContext(READ_PINE_STATE, fakePage({ ctrl: fakeCtrl({ draft: true, idv: { scriptIdPart: 'USER;d', version: '0.1' } }) }));
    assert.equal(draft.kind, 'draft');
  });
  it('falls back to DOM hints without the controller', () => {
    const s = vm.runInContext(READ_PINE_STATE, fakePage({ ctrl: null, saveClass: 'saveButton-x unsaved-x' }));
    assert.equal(s.api, false);
    assert.equal(s.kind, 'unknown');
    assert.equal(s.modified, true);
  });
});
