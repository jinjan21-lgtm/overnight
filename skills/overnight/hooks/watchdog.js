#!/usr/bin/env node
// overnight watchdog — node watchdog.js <run dir>
// Started detached by guard.js when a session takes ownership of a run. Until the deadline, it checks
// .overnight/heartbeat (written by guard.js on every owner hook event). If the owner went quiet
// (crash, usage limit, lost connection), it relaunches `claude -p "/overnight 이어서 ..."` in the run dir.
// A relaunch that dies right away (usage limit not reset yet) is simply retried on the next stale check.
// Optional .overnight/watchdog.json: { "claude": "<path>", "args": [...extra claude args], "interval": sec, "stale": sec }
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const dir = path.resolve(process.argv[2] || '.');
const ov = (...p) => path.join(dir, '.overnight', ...p);
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const log = (msg) => { try { fs.appendFileSync(ov('LOG.md'), `- ${new Date().toISOString()} watchdog: ${msg}\n`); } catch {} };

let cfg = {};
try { cfg = JSON.parse(read(ov('watchdog.json')) || '{}'); } catch {}
const INTERVAL = (cfg.interval || 300) * 1000;
const STALE = (cfg.stale || 900) * 1000;
const MAX_RELAUNCH = 30;

// One watchdog per run.
const pidFile = ov('watchdog.pid');
const other = parseInt(read(pidFile) || '', 10);
if (other && other !== process.pid) {
  try { process.kill(other, 0); process.exit(0); } catch {}
}
fs.writeFileSync(pidFile, String(process.pid));

// Returns a shell-ready command (cfg.claude is used as written).
function claudeCmd() {
  if (cfg.claude) return cfg.claude;
  const q = (a) => (/\s/.test(a) ? `"${a}"` : a);
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    return q(found.find((f) => /\.(exe|cmd)$/i.test(f)) || found[0] || 'claude');
  } catch { return 'claude'; }
}

const PROMPT = '/overnight 이어서 해. 앞 세션이 멈춰서 watchdog가 다시 띄웠다 — 이어받기. 마감은 .overnight/deadline 그대로. 잔다.';
let relaunches = 0;
let lastRelaunch = 0;

function relaunch(quietMin) {
  relaunches++;
  lastRelaunch = Date.now();
  const outFile = ov(`relaunch-${relaunches}.jsonl`);
  const args = ['-p', '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose',
    ...(cfg.args || []), PROMPT];
  const q = (a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
  const fd = fs.openSync(outFile, 'a');
  // Windows: detached(DETACHED_PROCESS)면 셸에 콘솔이 없어 그 아래 claude.exe가 새 콘솔을 만들고, 기본 터미널(Windows Terminal)이
  // 창을 띄운다. detached 없이 windowsHide면 숨은 콘솔(CREATE_NO_WINDOW)을 받아 자식들이 물려받는다 — 창이 안 뜬다.
  // Windows는 부모가 끝나도 자식을 죽이지 않으니 detached가 없어도 살아남는다. 다른 OS는 지금처럼 새 세션(setsid)으로.
  const child = spawn([claudeCmd(), ...args.map(q)].join(' '), {
    cwd: dir, shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', fd, fd],
  });
  child.unref();
  log(`세션이 ${quietMin}분째 조용해서 다시 띄움 (#${relaunches}, pid ${child.pid}, 출력 ${path.basename(outFile)})`);
}

function tick() {
  const deadline = new Date((read(ov('deadline')) || '').trim());
  const done = isNaN(deadline) || deadline <= Date.now() ||
    (fs.existsSync(ov('EXHAUSTED')) && fs.existsSync(ov('MORNING.md'))) || relaunches >= MAX_RELAUNCH;
  if (done) {
    try { if (read(pidFile) === String(process.pid)) fs.unlinkSync(pidFile); } catch {}
    process.exit(0);
  }
  const beat = mtime(ov('heartbeat')) || mtime(ov('deadline'));
  const quiet = Date.now() - beat;
  if (quiet > STALE && Date.now() - lastRelaunch > STALE) relaunch(Math.round(quiet / 60000));
}

tick();
setInterval(tick, INTERVAL);
