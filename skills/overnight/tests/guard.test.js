// node --test skills/overnight/tests/guard.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
const run = (input) => execFileSync('node', [GUARD], { input: JSON.stringify(input), encoding: 'utf8' }).trim();
const blocks = (out) => out !== '' && /"block"|"deny"/.test(out);

function lab(minutes = 60) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovn-'));
  fs.mkdirSync(path.join(dir, '.overnight'));
  fs.writeFileSync(path.join(dir, '.overnight', 'deadline'), new Date(Date.now() + minutes * 60000).toISOString());
  return dir;
}
const owner = (dir) => { try { return fs.readFileSync(path.join(dir, '.overnight', 'owner'), 'utf8').trim(); } catch { return ''; } };
const stop = (dir, sid) => run({ hook_event_name: 'Stop', cwd: dir, session_id: sid });
const ask = (dir, sid) => run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', cwd: dir, session_id: sid, tool_input: {} });
const post = (dir, sid, tool_input) => run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', cwd: dir, session_id: sid, tool_input });

test('no deadline file -> no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovn-'));
  assert.strictEqual(stop(dir, 'A'), '');
});

test('past deadline -> no-op', () => {
  assert.strictEqual(stop(lab(-5), 'A'), '');
});

test('the session that writes the deadline owns the run', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo 2026-10-25T08:00:00+09:00 > .overnight/deadline' });
  assert.strictEqual(owner(dir), 'A');
  assert.ok(blocks(stop(dir, 'A')));
  assert.ok(blocks(ask(dir, 'A')));
});

test('another session in the same folder is left alone', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  assert.strictEqual(stop(dir, 'B'), '');
  assert.strictEqual(ask(dir, 'B'), '');
  assert.strictEqual(owner(dir), 'A');
});

test('reading the deadline does not steal the run', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  post(dir, 'B', { command: 'cat .overnight/deadline' });
  assert.strictEqual(owner(dir), 'A');
});

test('rewriting the deadline (resume after a crash) takes over', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  run({ hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: dir, session_id: 'C', tool_input: { file_path: path.join(dir, '.overnight', 'deadline') } });
  assert.strictEqual(owner(dir), 'C');
  assert.ok(blocks(stop(dir, 'C')));
  assert.strictEqual(stop(dir, 'A'), '');
});

test('deadline written by hand: first session to hit the hook owns it', () => {
  const dir = lab();
  assert.ok(blocks(stop(dir, 'A')));
  assert.strictEqual(owner(dir), 'A');
  assert.strictEqual(stop(dir, 'B'), '');
});

test('owner still guarded after cd into a subfolder', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  const sub = path.join(dir, 'src', 'lib');
  fs.mkdirSync(sub, { recursive: true });
  assert.ok(blocks(stop(sub, 'A')));
});

test('a worktree with its own .overnight is a separate run', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  const wt = path.join(dir, '.overnight-wt', '2');
  fs.mkdirSync(path.join(wt, '.overnight'), { recursive: true });
  fs.writeFileSync(path.join(wt, '.overnight', 'deadline'), new Date(Date.now() + 3600000).toISOString());
  post(wt, 'B', { command: 'echo x > .overnight/deadline' });
  assert.ok(blocks(stop(wt, 'B')));
  assert.strictEqual(stop(wt, 'A'), '');
  assert.ok(blocks(stop(dir, 'A')));
  assert.strictEqual(owner(dir), 'A');
});

test('stdin-waiting command denied for the owner only', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  const bash = (sid) => run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: dir, session_id: sid, tool_input: { command: 'python -' } });
  assert.ok(blocks(bash('A')));
  assert.strictEqual(bash('B'), '');
});

test('still guarded with seconds left (no rounding to zero)', () => {
  const dir = lab(0.2);
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  assert.ok(blocks(stop(dir, 'A')));
});
