// node --test skills/overnight/tests/guard.test.js
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const GUARD = path.join(__dirname, '..', 'hooks', 'guard.js');
const ENV = { ...process.env, OVERNIGHT_NO_WATCHDOG: '1' };
// Session ids repeat across tests ('A', 'B'); real ones don't. Fresh registry per test.
beforeEach(() => { ENV.OVERNIGHT_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ovn-sess-')); });
const run = (input, args = []) => execFileSync('node', [GUARD, ...args], { input: JSON.stringify(input), encoding: 'utf8', env: ENV, windowsHide: true }).trim();
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
const pre = (dir, sid, tool_input, tool_name = 'Bash') => run({ hook_event_name: 'PreToolUse', tool_name, cwd: dir, session_id: sid, tool_input });
// The owner looks dead to the hook once its heartbeat is older than the watchdog's stale window.
const goQuiet = (dir, minutes = 20) => {
  const t = (Date.now() - minutes * 60000) / 1000;
  for (const f of ['heartbeat', 'owner']) {
    const p = path.join(dir, '.overnight', f);
    if (fs.existsSync(p)) fs.utimesSync(p, t, t);
  }
};

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
  goQuiet(dir); // A crashed: that is what makes the run free to take
  const w = { file_path: path.join(dir, '.overnight', 'deadline') };
  assert.strictEqual(pre(dir, 'C', w, 'Write'), '');
  run({ hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: dir, session_id: 'C', tool_input: w });
  assert.strictEqual(owner(dir), 'C');
  assert.ok(blocks(stop(dir, 'C')));
  assert.strictEqual(stop(dir, 'A'), '');
});

// Two sessions started in the same folder at the same second both see "no deadline" and both write one.
// Last writer wins would strip the first one's guard without telling it — it then stops at the first
// text-only answer, which is the one failure this skill exists to prevent.
test('a live owner is not stolen: the deadline write is denied, ownership stays', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  const w = { file_path: path.join(dir, '.overnight', 'deadline') };
  assert.match(pre(dir, 'B', w, 'Write'), /deny/);
  assert.match(pre(dir, 'B', w, 'Write'), /worktree/);        // tells B what to do instead
  assert.match(pre(dir, 'B', { command: 'echo x > .overnight/deadline' }), /deny/);
  run({ hook_event_name: 'PostToolUse', tool_name: 'Write', cwd: dir, session_id: 'B', tool_input: w });
  assert.strictEqual(owner(dir), 'A');                        // and claim refuses even if a write slips through
  assert.ok(blocks(stop(dir, 'A')));                          // A keeps its guard
  assert.strictEqual(stop(dir, 'B'), '');
});

test('the owner may rewrite its own deadline', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  assert.strictEqual(pre(dir, 'A', { command: 'echo y > .overnight/deadline' }), '');
  assert.strictEqual(pre(dir, 'A', { file_path: path.join(dir, '.overnight', 'deadline') }, 'Write'), '');
});

test('an unowned or finished run is free to take', () => {
  const dir = lab();
  assert.strictEqual(pre(dir, 'A', { command: 'echo x > .overnight/deadline' }), '');  // nobody owns it yet
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  setDeadline(dir, -1);
  assert.strictEqual(pre(dir, 'B', { command: 'echo x > .overnight/deadline' }), '');  // last night's run is over
});

// The watchdog relaunches a quiet owner; the relaunched session takes over by rewriting the deadline.
// If the hook's window were wider than the watchdog's, that relaunch would be denied and the run stuck.
test('the takeover window follows watchdog.json stale', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  goQuiet(dir, 0.2);                                          // 12s quiet
  assert.match(pre(dir, 'B', { command: 'echo x > .overnight/deadline' }), /deny/);
  fs.writeFileSync(path.join(dir, '.overnight', 'watchdog.json'), JSON.stringify({ stale: 1 }));
  assert.strictEqual(pre(dir, 'B', { command: 'echo x > .overnight/deadline' }), '');
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
  assert.ok(blocks(stop(wt, 'A'))); // A owns the root run: still guarded from inside the worktree
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

function repo(minutes = 60) {
  const dir = lab(minutes);
  const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { dir, git };
}
const commit = (dir, git, sid, msg) => {
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', msg);
  return post(dir, sid, { command: `git commit -m "${msg}"` });
};

test('worktree split by a second session gets its own guarded run', () => {
  const { dir, git } = repo();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  git('worktree', 'add', '-q', '.overnight-wt/2', '-b', 'overnight/x-2');
  post(dir, 'B', { command: 'git worktree add .overnight-wt/2 -b overnight/x-2' });
  const wt = path.join(dir, '.overnight-wt', '2');
  assert.strictEqual(owner(wt), 'B');
  assert.ok(blocks(stop(wt, 'B')));
  assert.strictEqual(owner(dir), 'A');
});

test('commits go to the shared claim ledger; other runs see them, a lone run sees nothing', () => {
  const { dir, git } = repo();
  git('switch', '-q', '-c', 'overnight/x');
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  assert.strictEqual(commit(dir, git, 'A', 'CSV 가져오기'), '');
  git('worktree', 'add', '-q', '.overnight-wt/2', '-b', 'overnight/x-2');
  post(dir, 'B', { command: 'git worktree add .overnight-wt/2 -b overnight/x-2' });
  const wt = path.join(dir, '.overnight-wt', '2');
  const wgit = (...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8', windowsHide: true });
  const out = commit(wt, wgit, 'B', '반복 거래');
  assert.match(out, /CSV 가져오기/);
  assert.match(commit(dir, git, 'A', 'edit 명령'), /반복 거래/);
  const ledger = fs.readFileSync(path.join(dir, '.overnight', 'CLAIMS.md'), 'utf8');
  assert.match(ledger, /overnight\/x \| CSV 가져오기/);
  assert.match(ledger, /overnight\/x-2 \| 반복 거래/);
});

test('a non-owner commit is not recorded', () => {
  const { dir, git } = repo();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  commit(dir, git, 'B', 'peek fix');
  assert.ok(!fs.existsSync(path.join(dir, '.overnight', 'CLAIMS.md')));
});

// ---- wrap-up, notify gate, non-goal check, budget, commit nudges, watchdog ----
const notifyOk = (dir, sid) => {
  try { execFileSync('node', [GUARD, '--notify-ok'], { input: JSON.stringify({ hook_event_name: 'Stop', cwd: dir, session_id: sid }), env: ENV, windowsHide: true }); return true; }
  catch { return false; }
};
const setDeadline = (dir, minutes) => fs.writeFileSync(path.join(dir, '.overnight', 'deadline'), new Date(Date.now() + minutes * 60000).toISOString());
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const EXH = '1. REMAINING: 열린 항목 0개, 전부 체크됨\n2. 재기획: R1~R3 수행, 후보 모두 처리\n3. 정리: 테스트 20 pass, 죽은 코드 없음\n4. 문서: README·WORKLOG 갱신 완료\n5. 리뷰: REVIEW.md 버그 1건 수정\n';
const rounds = (excl) => ['R1', 'R2', 'R3'].map((r) => `## ${r} 01:00 재기획\n- 채택: a\n- 채택: b\n- 채택: c\n- 제외(비가역): 클라우드 동기화\n- ${excl}\n`).join('\n');
const PLAN = '# P\n## 목표\n가계부\n## 비목표\n- 웹 UI, 다중 사용자, 은행 연동\n## 변경이력\n';

test('notify gate: popup suppressed only for the owner of a live run', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  assert.strictEqual(notifyOk(dir, 'A'), false);
  assert.strictEqual(notifyOk(dir, 'B'), true);
  setDeadline(dir, -1);
  assert.strictEqual(notifyOk(dir, 'A'), true);
  assert.strictEqual(notifyOk(fs.mkdtempSync(path.join(os.tmpdir(), 'ovn-')), 'A'), true);
});

test('notify gate never claims an unowned run', () => {
  const dir = lab();
  notifyOk(dir, 'B');
  assert.strictEqual(owner(dir), '');
});

test('EXHAUSTED rejects a 비목표 the PLAN does not list, accepts one it does', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  write(dir, 'docs/PLAN.md', PLAN);
  write(dir, 'docs/REMAINING.md', '- [x] a\n');
  write(dir, '.overnight/MORNING.md', 'ok');
  write(dir, '.overnight/EXHAUSTED', EXH);
  write(dir, '.overnight/DECISIONS.md', rounds('제외(비목표): 다중 통화'));
  assert.match(stop(dir, 'A'), /비목표에 없는/);
  write(dir, '.overnight/DECISIONS.md', rounds('제외(비목표): 은행 연동, 웹 UI'));
  assert.strictEqual(stop(dir, 'A'), '');
});

test('accepted EXHAUSTED still needs MORNING.md first', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  write(dir, 'docs/REMAINING.md', '- [x] a\n');
  write(dir, '.overnight/EXHAUSTED', EXH);
  write(dir, '.overnight/DECISIONS.md', rounds('제외(비목표): 은행 연동'));
  assert.match(stop(dir, 'A'), /MORNING\.md/);
  write(dir, '.overnight/MORNING.md', 'ok');
  assert.strictEqual(stop(dir, 'A'), '');
});

test('after the deadline: owner must leave MORNING.md, at most 4 blocks', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  setDeadline(dir, -1);
  for (let i = 0; i < 4; i++) assert.match(stop(dir, 'A'), /MORNING\.md/);
  assert.strictEqual(stop(dir, 'A'), '');
  assert.strictEqual(stop(dir, 'B'), '');
});

test('after the grace hour: nothing', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  setDeadline(dir, -61);
  assert.strictEqual(stop(dir, 'A'), '');
});

test('last of two runs to finish is told to make the merged branch', () => {
  const { dir, git } = repo();
  git('switch', '-q', '-c', 'overnight/x');
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  git('worktree', 'add', '-q', '.overnight-wt/2', '-b', 'overnight/x-2');
  post(dir, 'B', { command: 'git worktree add .overnight-wt/2 -b overnight/x-2' });
  const wt = path.join(dir, '.overnight-wt', '2');
  setDeadline(wt, -1);
  write(wt, '.overnight/MORNING.md', 'ok');
  assert.strictEqual(stop(wt, 'B'), ''); // A still running: B just ends
  setDeadline(dir, -1);
  write(dir, '.overnight/MORNING.md', 'ok');
  assert.match(stop(dir, 'A'), /overnight\/x-2.*merge --no-ff/);
  git('-C', wt, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'b-last');
  git('branch', 'overnight/x-merged', 'overnight/x');               // made early: misses B's last commit
  assert.match(stop(dir, 'A'), /overnight\/x-merged에 overnight\/x-2의 마지막 커밋이 빠져/);
  git('switch', '-q', 'overnight/x-merged');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '-q', '--no-ff', '-m', 'm', 'overnight/x-2');
  git('switch', '-q', 'overnight/x');
  assert.strictEqual(stop(dir, 'A'), '');
});

// A parallel run does not have to sit in .overnight-wt/: any worktree of this repo is one, and a
// branch left out of the merge turn is a branch nobody looks at in the morning.
test('a worktree outside .overnight-wt is still a parallel run at wrap-up', () => {
  const { dir, git } = repo();
  git('switch', '-q', '-c', 'overnight/x');
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  const far = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ovn-far-')), 'wt');
  git('worktree', 'add', '-q', far, '-b', 'overnight/far');
  fs.mkdirSync(path.join(far, '.overnight'), { recursive: true });
  setDeadline(far, -1);
  setDeadline(dir, -1);
  write(dir, '.overnight/MORNING.md', 'ok');
  assert.match(stop(dir, 'A'), /overnight\/far.*merge --no-ff/);
});

test('token budget reached: stop allowed once wrapped up', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  write(dir, '.overnight/budget', '1000');
  const tr = path.join(dir, 't.jsonl');
  const msg = (id, n) => JSON.stringify({ type: 'assistant', message: { id, usage: { output_tokens: n } } });
  fs.writeFileSync(tr, [msg('m1', 600), msg('m1', 600), msg('m2', 300)].join('\n'));
  const s = () => run({ hook_event_name: 'Stop', cwd: dir, session_id: 'A', transcript_path: tr });
  assert.match(s(), /마감까지/); // 900 < 1000 (m1 counted once)
  fs.appendFileSync(tr, '\n' + msg('m3', 200));
  assert.match(s(), /MORNING\.md/);
  write(dir, '.overnight/MORNING.md', 'ok');
  assert.strictEqual(s(), '');
});

test('commit nudges: test-only edits flagged, docs-only noted, review every 8th', () => {
  const { dir, git } = repo();
  git('switch', '-q', '-c', 'overnight/x');
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  const c = (file, text, msg) => {
    write(dir, file, text);
    git('add', file);
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
    return post(dir, 'A', { command: `git commit -m "${msg}"` });
  };
  c('test/a.test.js', 'expect(1)\n', 't1');
  assert.match(c('test/a.test.js', 'expect(2)\n', 't2'), /테스트의 기존 줄만/);
  assert.match(fs.readFileSync(path.join(dir, '.overnight', 'FLAGS.md'), 'utf8'), /t2/);
  assert.match(c('docs/WORKLOG.md', 'x\n', 'd1'), /문서만 바꾼/);
  for (let i = 4; i < 8; i++) c(`src/f${i}.js`, 'x\n', `f${i}`);
  assert.match(c('src/f8.js', 'x\n', 'f8'), /리뷰 차례/);
});

test('watchdog relaunches a quiet run and stops at the deadline', async () => {
  const dir = lab(0.25);
  write(dir, '.overnight/heartbeat', 'old');
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(path.join(dir, '.overnight', 'heartbeat'), old, old);
  fs.utimesSync(path.join(dir, '.overnight', 'deadline'), old, old);
  const fake = path.join(dir, 'fake-claude.js');
  fs.writeFileSync(fake, `require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'launched.txt'))}, process.argv.slice(2).join(' ') + '\\n')`);
  write(dir, '.overnight/watchdog.json', JSON.stringify({ claude: `node "${fake}"`, interval: 1, stale: 2 }));
  const wd = require('child_process').spawn('node', [path.join(__dirname, '..', 'hooks', 'watchdog.js'), dir], { stdio: 'ignore', windowsHide: true });
  const code = await new Promise((r) => wd.on('exit', r));
  assert.strictEqual(code, 0);
  const launched = fs.readFileSync(path.join(dir, 'launched.txt'), 'utf8');
  assert.match(launched, /\/overnight 이어서/);
  assert.match(launched, /bypassPermissions/);
  assert.match(fs.readFileSync(path.join(dir, '.overnight', 'LOG.md'), 'utf8'), /watchdog: .*다시 띄움/);
  assert.ok(!fs.existsSync(path.join(dir, '.overnight', 'watchdog.pid')));
});

// ---- a session working on its worktree run from the repo root (soak run 1 bug) ----
test('worktree owner stays guarded and claimed from the root cwd; cannot write the root run files', () => {
  const { dir, git } = repo();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  git('worktree', 'add', '-q', '.overnight-wt/2', '-b', 'overnight/x-2');
  post(dir, 'B', { command: 'git worktree add .overnight-wt/2 -b overnight/x-2' });
  const wt = path.join(dir, '.overnight-wt', '2');
  // B rewrites its own deadline from the root: claim lands on the worktree, not the root
  post(dir, 'B', { command: 'echo 2030-01-01T00:00:00Z > .overnight-wt/2/.overnight/deadline' });
  assert.strictEqual(owner(wt), 'B');
  assert.strictEqual(owner(dir), 'A');
  assert.ok(blocks(stop(dir, 'B')));                       // guarded although cwd is the root
  const pre = (sid, tool, tool_input) => run({ hook_event_name: 'PreToolUse', tool_name: tool, cwd: dir, session_id: sid, tool_input });
  assert.match(pre('B', 'Write', { file_path: path.join(dir, '.overnight', 'MORNING.md') }), /deny.*overnight-wt/);
  assert.match(pre('B', 'Bash', { command: 'echo done >> .overnight/LOG.md' }), /deny/);
  assert.strictEqual(pre('B', 'Bash', { command: 'echo done >> .overnight-wt/2/.overnight/LOG.md' }), '');
  assert.strictEqual(pre('B', 'Bash', { command: 'cat .overnight/LOG.md' }), '');
  assert.strictEqual(pre('B', 'Bash', { command: 'git log --oneline 90db489..overnight/x-2 > /tmp/x' }), ''); // revision range, not a path
  assert.match(pre('B', 'Bash', { command: `echo d >> "${dir.replace(/\\/g, '/')}/.overnight/LOG.md"` }), /deny/);   // absolute path
  assert.strictEqual(pre('B', 'Bash', { command: 'echo "x | y" >> .overnight/CLAIMS.md' }), '');
  assert.strictEqual(pre('A', 'Write', { file_path: path.join(dir, '.overnight', 'MORNING.md') }), '');
});

test('git-bash style paths resolve (cd /c/... && echo > .overnight/deadline)', () => {
  if (process.platform !== 'win32') return;
  const dir = lab();
  const gb = dir.replace(/^([A-Za-z]):\\/, (_, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
  post(os.tmpdir(), 'A', { command: `cd "${gb}" && echo x > .overnight/deadline` });
  assert.strictEqual(owner(dir), 'A');
});

test('an owner making a helper worktree (merge) keeps its own run', () => {
  const { dir, git } = repo();
  git('switch', '-q', '-c', 'overnight/x');
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  git('worktree', 'add', '-q', '.overnight-wt/merge', '-b', 'overnight/x-merged');
  post(dir, 'A', { command: 'git worktree add .overnight-wt/merge -b overnight/x-merged' });
  assert.ok(!fs.existsSync(path.join(dir, '.overnight-wt', 'merge', '.overnight', 'owner')));
  assert.ok(blocks(stop(path.join(dir, '.overnight-wt', 'merge'), 'A')));   // still guarded as the root run
  assert.ok(fs.statSync(path.join(dir, '.overnight', 'heartbeat')).mtimeMs > Date.now() - 5000);
});

test('EXHAUSTED rejects 비가역 that is really "needs user confirmation"', () => {
  const dir = lab();
  post(dir, 'A', { command: 'echo x > .overnight/deadline' });
  write(dir, 'docs/REMAINING.md', '- [x] a\n');
  write(dir, '.overnight/MORNING.md', 'ok');
  write(dir, '.overnight/EXHAUSTED', EXH);
  write(dir, '.overnight/DECISIONS.md', rounds('제외(비가역): BLS 캘린더 — 발표일 데이터 없이 만들면 오알림 (사용자 확인 필요)'));
  assert.match(stop(dir, 'A'), /결정이다/);
});
