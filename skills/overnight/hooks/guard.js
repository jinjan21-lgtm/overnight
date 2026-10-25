#!/usr/bin/env node
// overnight guard — Stop / PreToolUse / PostToolUse hook, plus `--notify-ok` gate for other Stop hooks.
// Active only while .overnight/deadline (nearest one from cwd upward) holds a future ISO time,
// and only for the session that owns it (.overnight/owner = session_id).
// No deadline file, unreadable, or another session's run -> does nothing.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const GRACE_MS = 60 * 60000;      // after the deadline, wrap-up checks run this long
const WRAPUP_MAX_BLOCKS = 4;      // then the session is let go no matter what
const REVIEW_EVERY = 8;           // commits between fresh-eyes reviews
const STALE_S = 900;              // watchdog.js default: quiet this long and the owner is gone

const out = (o) => console.log(JSON.stringify(o));
const readAt = (dir, ...p) => { try { return fs.readFileSync(path.join(dir, ...p), 'utf8'); } catch { return null; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
// git reports the repo root as a real path (/private/var/..) while cwd can arrive symlinked (/var/..).
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The run lives in the nearest .overnight/ from cwd upward, so cd into a subfolder keeps it.
function findRun(cwd) {
  for (let d = path.resolve(cwd); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.overnight', 'deadline'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

function deadlineOf(dir) {
  const d = new Date((readAt(dir, '.overnight', 'deadline') || '').trim());
  return isNaN(d) ? null : d;
}

// The window watchdog.js uses to call a session gone. The two must stay in step: the session the
// watchdog relaunches takes the run over by rewriting the deadline, and a wider window here would
// deny that relaunch and leave the run locked to a dead owner.
function staleMs(dir) {
  let cfg = {};
  try { cfg = JSON.parse(readAt(dir, '.overnight', 'watchdog.json') || '{}'); } catch {}
  const s = Number(cfg.stale);
  return (s > 0 ? s : STALE_S) * 1000;
}

// Who else is mid-run in this folder: a live deadline, and an owner still writing heartbeats.
// Rewriting such a run's deadline is not a handover — it strips that session's guard without telling
// it, and the session then stops at its first text-only answer.
function liveOwner(dir, me) {
  const o = (readAt(dir, '.overnight', 'owner') || '').trim();
  if (!o || o === me) return '';
  const dl = deadlineOf(dir);
  if (!dl || dl <= Date.now()) return '';
  const ov = (f) => path.join(dir, '.overnight', f);
  const beat = mtime(ov('heartbeat')) || mtime(ov('owner'));   // owner file: claimed, no hook event yet
  return Date.now() - beat < staleMs(dir) ? o : '';
}

function gitIn(dir) {
  return (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
}

// Output tokens spent in this session, from the transcript (entries repeat per content block: dedupe by id).
function outputTokens(transcript) {
  const seen = new Map();
  try {
    for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
      if (!l.includes('"output_tokens"')) continue;
      try {
        const m = JSON.parse(l).message;
        if (m && m.id && m.usage) seen.set(m.id, Math.max(seen.get(m.id) || 0, m.usage.output_tokens || 0));
      } catch {}
    }
  } catch {}
  let sum = 0;
  for (const v of seen.values()) sum += v;
  return sum;
}

function overBudget(run, input) {
  const budget = parseInt(readAt(run, '.overnight', 'budget') || '', 10);
  return budget > 0 && input.transcript_path && outputTokens(input.transcript_path) >= budget;
}

function startWatchdog(dir) {
  if (process.env.OVERNIGHT_NO_WATCHDOG) return;
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'watchdog.js'), dir], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch {}
}

// Early exit before the deadline is allowed only when the files show the loop really ran dry.
function exhaustedProblem(run) {
  const lines = (readAt(run, '.overnight', 'EXHAUSTED') || '').split(/\r?\n/).map((l) => l.trim());
  const DEFER = /보류|미실시|안\s?함|하지\s?않|생략|skip|나중에|가치가?\s?(낮|적|없)|대체\s?가능|범위\s?(확장|밖)|불필요|과하/i;
  const missing = [1, 2, 3, 4, 5].filter((n) => !lines.some((l) => l.startsWith(`${n}.`) && l.length >= 12));
  const deferred = lines.filter((l) => /^[1-5]\./.test(l) && DEFER.test(l));

  const rounds = (readAt(run, '.overnight', 'DECISIONS.md') || '').split(/^(?=## R\d+)/m).filter((s) => /^## R\d+/.test(s));
  const last = rounds[rounds.length - 1] || '';
  const cands = last.split(/\r?\n/).filter((l) => /^\s*[-*]\s+/.test(l));
  const badCand = cands.find((l) => !/채택|비목표|비가역/.test(l));
  // "비가역 — 사용자 확인 필요" is a decision handed back, not an irreversible act.
  const askBack = cands.find((l) => /비가역/.test(l) && /(확인|결정|판단|승인)\s?(이\s?)?필요|물어|여쭤/.test(l));

  // "제외(비목표)" must name something PLAN's 비목표 section actually lists.
  const plan = readAt(run, 'docs', 'PLAN.md');
  const nonGoals = plan ? nonGoalSection(plan) : null;
  const fakeNonGoal = plan && cands.find((l) => /비목표/.test(l) && !/채택/.test(l) && !nonGoalListed(l, nonGoals));

  const rem = readAt(run, 'docs', 'REMAINING.md');
  const remLines = rem ? rem.split(/\r?\n/) : [];
  const open = remLines.filter((l) => /^\s*[-*]\s*\[ \]/.test(l) && !/막힘|비가역|아침/.test(l));
  const done = remLines.filter((l) => /^\s*[-*]\s*\[x\]/i.test(l));

  if (missing.length) return `EXHAUSTED에 ${missing.join(', ')}번 줄이 없거나 너무 짧다.`;
  if (deferred.length) return `EXHAUSTED가 미룬 일을 근거로 쓴다: "${deferred[0]}". 미룬 건 소진이 아니다 — 그 일을 하라.`;
  if (rounds.length < 3) return `DECISIONS.md의 재기획(## R1, ## R2 ...)이 ${rounds.length}회뿐이다. 3회 이상 재기획하라.`;
  if (cands.length < 5) return `마지막 재기획에 후보가 ${cands.length}개뿐이다. 5개 이상 적어라.`;
  if (badCand) return `후보 제외 사유는 비목표·비가역뿐이다: "${badCand.trim()}". 그 후보를 만들어라.`;
  if (askBack) return `"${askBack.trim()}" — 확인이 필요하다는 건 비가역이 아니라 결정이다. 스스로 고르고 DECISIONS.md에 남긴 뒤 만들어라(되돌릴 수 있게).`;
  if (fakeNonGoal) return `"${fakeNonGoal.trim()}" — docs/PLAN.md 비목표에 없는 항목이다. 비목표가 아니면 만들어라.`;
  if (rem && !done.length) return 'docs/REMAINING.md에 완료 기록([x])이 없다. 항목을 지우지 말고 체크로 남겨라.';
  if (open.length) return `docs/REMAINING.md에 열린 항목이 남아 있다: "${open[0].trim()}". 그것부터 하라.`;
  return '';
}

function nonGoalSection(plan) {
  const lines = plan.split(/\r?\n/);
  const i = lines.findIndex((l) => /^#+.*비목표/.test(l) || /^\s*\**비목표\**\s*[:：]/.test(l));
  if (i < 0) return '';
  const level = (lines[i].match(/^#+/) || ['#######'])[0].length;
  const body = [lines[i].replace(/^.*비목표\**\s*[:：]?/, '')];
  for (const l of lines.slice(i + 1)) {
    const h = l.match(/^#+/);
    if (h && h[0].length <= level) break;
    body.push(l);
  }
  return body.join('\n').toLowerCase();
}

// Each excluded item needs more than half of its words (2+ chars) in the 비목표 section
// ("다중 통화" does not pass on "다중 사용자"; "은행 API 연동" passes on "은행 연동").
function nonGoalListed(line, section) {
  if (!section) return false;
  const items = line.replace(/^.*비목표\)?\s*[:：]?/, '').split(/\s[—-]\s/)[0].split(/[,，、/·]/);
  return items.every((it) => {
    const words = it.toLowerCase().replace(/[()（）`"']/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
    const hits = words.filter((w) => section.includes(w) || section.includes(w.replace(/(은|는|이|가|을|를)$/, ''))).length;
    return !words.length || hits * 2 > words.length;
  });
}

// Other overnight runs in the same repo, excluding `run` itself: any worktree of this repo is one,
// wherever it was created, plus .overnight-wt/* folders git does not know as worktrees. Keyed by real
// path so a run never counts itself (and a folder is not listed twice).
function otherRuns(run) {
  let root;
  try { root = path.join(gitIn(run)('rev-parse', '--path-format=absolute', '--git-common-dir'), '..'); } catch { return []; }
  const dirs = new Map([[real(root), root]]);
  try {
    for (const l of gitIn(run)('worktree', 'list', '--porcelain').split(/\r?\n/)) {
      if (l.startsWith('worktree ')) { const d = l.slice(9).trim(); dirs.set(real(d), d); }
    }
  } catch {}
  try {
    for (const n of fs.readdirSync(path.join(root, '.overnight-wt'))) {
      const d = path.join(root, '.overnight-wt', n);
      dirs.set(real(d), d);
    }
  } catch {}
  dirs.delete(real(run));
  return [...dirs.values()].filter((d) => fs.existsSync(path.join(d, '.overnight', 'deadline')));
}

const runEnded = (d) => { const dl = deadlineOf(d); return !dl || dl <= Date.now() || fs.existsSync(path.join(d, '.overnight', 'EXHAUSTED')); };

// Before the session finally stops: the morning report is a file, and if parallel runs in this repo
// have all ended, the last one out leaves a merged branch so the morning is review, not conflict fixing.
function wrapUpProblem(run) {
  const problems = [];
  if (!fs.existsSync(path.join(run, '.overnight', 'MORNING.md'))) {
    problems.push('아침 보고를 .overnight/MORNING.md 파일로 써라(채팅에만 쓰면 창을 닫을 때 사라진다). 형식은 스킬의 "끝" 섹션.');
  }
  const others = otherRuns(run);
  if (others.length && others.every(runEnded)) {
    const git = gitIn(run);
    const branchOf = (d) => { try { return gitIn(d)('branch', '--show-current'); } catch { return ''; } };
    const branches = [run, ...others].map(branchOf).filter(Boolean);   // one odd folder must not hide the rest
    let merged = '';
    try { merged = git('branch', '--list', '--format=%(refname:short)', 'overnight/*-merged').split(/\r?\n/)[0] || ''; } catch {}
    // A merged branch made early can miss commits a run made after it: every run's tip must be inside.
    const isIn = (b) => { try { git('merge-base', '--is-ancestor', b, merged); return true; } catch { return false; } };
    const missing = merged ? branches.filter((b) => !isIn(b)) : branches;
    if (missing.length && !fs.existsSync(path.join(run, '.overnight', 'MERGE.md'))) {
      problems.push(merged
        ? `${merged}에 ${missing.join(', ')}의 마지막 커밋이 빠져 있다(통합 뒤에 커밋됨). 그 브랜치를 다시 \`git merge --no-ff\`하고 ` +
          '전체 테스트를 돌린 뒤 MORNING.md의 통합 설명을 고쳐라.'
        : `같은 저장소의 다른 밤샘(${branches.slice(1).join(', ')})도 끝났다. 내 브랜치에서 \`git switch -c <내 브랜치>-merged\` 후 ` +
          '다른 브랜치를 `git merge --no-ff`로 합치고 충돌을 풀고 전체 테스트를 돌려라(원래 브랜치는 그대로 둔다). ' +
          '결과를 MORNING.md 아침에 할 일 맨 위에. 끝내 못 풀면 git merge --abort 후 .overnight/MERGE.md에 이유를 적어라.');
    }
  }
  return problems.join(' ');
}

function wrapUpGate(run) {
  const problem = wrapUpProblem(run);
  if (!problem) process.exit(0);
  const f = path.join(run, '.overnight', 'wrapup-blocks');
  const n = parseInt(readAt(run, '.overnight', 'wrapup-blocks') || '0', 10);
  if (n >= WRAPUP_MAX_BLOCKS) process.exit(0);
  fs.writeFileSync(f, String(n + 1));
  out({ decision: 'block', reason: `마무리 전 할 일: ${problem}` });
  process.exit(0);
}

// After every owner commit: claim ledger, and nudges about what the commit looks like.
function afterCommit(run, input, me) {
  const notes = [];
  try {
    const git = gitIn(input.cwd || run);
    const root = path.join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), '..');
    const claims = path.join(root, '.overnight', 'CLAIMS.md');
    const branch = git('branch', '--show-current');
    const subject = git('log', '-1', '--format=%s');
    fs.mkdirSync(path.dirname(claims), { recursive: true });
    fs.appendFileSync(claims, `${branch} | ${subject} (커밋)\n`);
    const ledger = fs.readFileSync(claims, 'utf8').split(/\r?\n/).filter(Boolean);
    const others = ledger.filter((l) => !l.startsWith(branch + ' |'));
    if (others.length) {
      notes.push(`같은 저장소의 다른 밤샘 세션이 이미 잡았거나 끝낸 일 (${claims}):\n${others.slice(-30).join('\n')}\n` +
        '이 기능들은 표현이 달라도 줍지 마라. 내 REMAINING에서 [x] (다른 세션: <브랜치>)로 체크하고 다음 항목으로.');
    }

    const files = git('show', '--numstat', '--format=', 'HEAD').split(/\r?\n/).filter(Boolean).map((l) => l.split('\t'));
    const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(py|go)$|(^|\/)test_[^/]*\.py$/;
    if (files.length && files.every(([, , f]) => TEST.test(f)) && files.some(([, del]) => +del > 0)) {
      fs.appendFileSync(path.join(run, '.overnight', 'FLAGS.md'),
        `- ${git('rev-parse', '--short', 'HEAD')} ${subject} — 테스트 기존 줄만 수정. 기댓값을 코드에 맞춘 건지 확인\n`);
      notes.push('이 커밋은 테스트의 기존 줄만 고쳤다(.overnight/FLAGS.md에 기록됨). 코드가 틀렸는데 기댓값을 맞춘 거라면 되돌리고 코드를 고쳐라. ' +
        '기댓값이 틀렸던 거라면 그 근거를 DECISIONS.md에 한 줄.');
    }
    if (files.length && files.every(([, , f]) => /\.md$/i.test(f))) {
      notes.push('문서만 바꾼 커밋이다. 기록(WORKLOG·REMAINING)은 다음부터 그 항목의 기능 커밋에 함께 넣어라(만들기 → 기록 → 커밋).');
    }

    const mine = ledger.filter((l) => l.startsWith(branch + ' |')).length;
    if (mine % REVIEW_EVERY === 0) {
      notes.push(`커밋 ${mine}개째 — 리뷰 차례. Agent(general-purpose)에 "읽기 전용, 최근 ${REVIEW_EVERY}커밋(git log -${REVIEW_EVERY} -p) 버그 사냥, ` +
        '파일:라인과 재현 방법으로 보고"를 맡기고, 나온 버그는 REMAINING 맨 위에 추가해 다음 항목으로 고쳐라.');
    }
  } catch {}
  if (overBudget(run, input)) {
    notes.push('토큰 상한(.overnight/budget)에 닿았다. 지금 항목을 커밋하고 마무리(MORNING.md)한 뒤 멈춰라. 훅이 멈춤을 허용한다.');
  }
  if (notes.length) out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: notes.join('\n\n') } });
}

// ---- which run a session belongs to ----
// Registry: <sessions dir>/<session_id> holds the run folder the session owns.
const SESSIONS = process.env.OVERNIGHT_SESSIONS_DIR || path.join(require('os').homedir(), '.claude', 'overnight-sessions');
const sessionFile = (me) => path.join(SESSIONS, me.replace(/[^\w-]/g, '_'));

function registeredRun(me) {
  if (!me) return null;
  const dir = (readAt(sessionFile(me)) || '').trim();
  return dir && (readAt(dir, '.overnight', 'owner') || '').trim() === me && deadlineOf(dir) ? dir : null;
}

function claim(dir, me) {
  if (liveOwner(dir, me)) return false;   // backstop: a live run is never taken over
  fs.writeFileSync(path.join(dir, '.overnight', 'owner'), me + '\n');
  try { fs.mkdirSync(SESSIONS, { recursive: true }); fs.writeFileSync(sessionFile(me), path.resolve(dir)); } catch {}
  startWatchdog(dir);
  return true;
}

// git-bash paths (/c/Users/..) to native ones.
const native = (p) => (process.platform === 'win32' ? p.replace(/^\/([a-zA-Z])\//, '$1:/') : p);

// Where a Bash command runs: a leading `cd <dir> &&` moves it.
function baseDir(input, cmd) {
  const cwd = input.cwd || process.cwd();
  const m = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/);
  return m ? path.resolve(cwd, native(m[1] || m[2] || m[3])) : cwd;
}

// Only a write counts (Write tool, or a shell redirect/tee into the file) — reading it must not steal the run.
function deadlineTarget(ti, cmd, base) {
  const fp = String(ti.file_path || '');
  if (/(^|[\\/])\.overnight[\\/]+deadline$/.test(fp)) return path.resolve(base, native(fp), '..', '..');
  const m = cmd.match(/(?:>{1,2}|\btee(?:\s+-a)?)\s*["']?([^\s"'|;&<>]*\.overnight[\\/]+deadline)\b/);
  return m ? path.resolve(base, native(m[1]), '..', '..') : null;
}

// .overnight files this tool call writes: [{ dir: run folder, file }]. CLAIMS.md is shared on purpose.
function overnightWrites(tool, ti, cmd, base) {
  const files = [];
  const fp = String(ti.file_path || '');
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && /(^|[\\/])\.overnight[\\/]/.test(fp)) files.push(fp);
  if (tool === 'Bash' && /(>|\btee\b|\bsed\s+-i|\b(cp|mv|rm|touch)\s)/.test(cmd)) {
    // `.overnight` must start a path segment: `git log a1b2..overnight/x` is a revision range, not a path.
    for (const m of cmd.matchAll(/(?:^|[\s"'=])((?:[^\s"'|;&<>]*[\\/])?\.overnight[\\/]+[^\s"'|;&<>]+)/g)) files.push(m[1]);
  }
  return files.map((f) => {
    const abs = path.resolve(base, native(f));
    return { dir: abs.slice(0, abs.search(/[\\/]\.overnight[\\/]/)), file: path.basename(abs) };
  }).filter((t) => t.file !== 'CLAIMS.md');
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const notifyGate = process.argv.includes('--notify-ok');

  const ev = input.hook_event_name;
  const me = input.session_id || '';
  const ti = input.tool_input || {};
  const cmd = String(ti.command || '');
  const base = baseDir(input, cmd);

  // Two overnights started in the same folder in the same minute both see "no deadline" and both
  // write one. Send the second one into its own worktree instead of letting it take the first's run.
  if (ev === 'PreToolUse' && me && !notifyGate && !registeredRun(me)) {
    const dl = deadlineTarget(ti, cmd, base);
    if (dl && liveOwner(dl, me)) {
      out({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `${dl} 는 다른 세션이 지금 밤샘 중인 폴더다(.overnight/owner 의 heartbeat가 살아 있다). ` +
            'deadline을 다시 쓰면 그 세션의 가드가 조용히 풀려 첫 텍스트 응답에서 멈춘다. ' +
            '`git worktree add .overnight-wt/<n> -b overnight/<시작일>-<n>` 로 갈라져 그 폴더에서 내 마감을 써라 ' +
            '(앞 세션이 죽어 조용해지면 그때는 이어받을 수 있다).',
        },
      });
      process.exit(0);
    }
  }

  // Ownership is claimed after the write, on the folder whose .overnight/deadline was actually written
  // (a second overnight may write its worktree's deadline while its shell still sits in the repo root).
  if (ev === 'PostToolUse' && me && !notifyGate) {
    const dl = deadlineTarget(ti, cmd, base);
    if (dl && deadlineOf(dl)) claim(dl, me);
    // A second overnight that splits off into .overnight-wt/<n> gets its own guarded run right away
    // (parent's deadline as default; writing its own deadline later overrides it).
    const wt = /\bworktree\s+add\b/.test(cmd) && cmd.match(/(\.overnight-wt[\\/][^\s"'&;|]+)/);
    // Only a session that owns no live run yet is splitting off; an owner making a helper worktree
    // (e.g. .overnight-wt/merge for the morning merge) keeps its own run.
    const parent = wt && !registeredRun(me) && findRun(base);
    if (parent) {
      const dir = path.resolve(base, wt[1]);
      if (fs.existsSync(dir) && !fs.existsSync(path.join(dir, '.overnight', 'deadline'))) {
        fs.mkdirSync(path.join(dir, '.overnight'), { recursive: true });
        fs.copyFileSync(path.join(parent, '.overnight', 'deadline'), path.join(dir, '.overnight', 'deadline'));
        claim(dir, me);
      }
    }
  }

  // This session's run: the one it owns (wherever it cd's), else the nearest .overnight/ from cwd.
  const run = registeredRun(me) || findRun(input.cwd || process.cwd());
  if (!run) process.exit(0);
  const deadline = deadlineOf(run);
  if (!deadline) process.exit(0);
  let owner = (readAt(run, '.overnight', 'owner') || '').trim();
  const live = deadline > Date.now();

  // --notify-ok: exit 1 (suppress "done" popups) only for the owner of a live run. No side effects.
  if (notifyGate) process.exit(live && me && owner === me ? 1 : 0);

  if (!live) {
    if (ev === 'Stop' && me && owner === me && Date.now() - deadline < GRACE_MS) wrapUpGate(run);
    process.exit(0);
  }

  // Any other session in the same folder (the user peeking in, a second overnight before it splits off)
  // is left alone.
  if (!owner && me) { claim(run, me); owner = me; } // deadline written by hand
  if (owner && me && owner !== me) process.exit(0);

  try { fs.writeFileSync(path.join(run, '.overnight', 'heartbeat'), new Date().toISOString()); } catch {} // for watchdog.js

  if (ev === 'PostToolUse') {
    if (/\bgit\b[^|;&]*\bcommit\b/.test(cmd)) afterCommit(run, input, me);
    process.exit(0);
  }

  const leftMin = Math.ceil((deadline - Date.now()) / 60000);
  const left = `${Math.floor(leftMin / 60)}시간 ${leftMin % 60}분`;

  if (ev === 'PreToolUse') {
    const foreign = overnightWrites(input.tool_name, ti, cmd, base).find((t) => path.resolve(t.dir) !== path.resolve(run));
    if (foreign) {
      out({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `이 세션의 밤샘 폴더는 ${run} 이다. ${foreign.dir} 의 .overnight/는 다른 세션 것이다. ` +
            `기록(${foreign.file})은 ${path.join(run, '.overnight', foreign.file)} 에 써라. 작업도 그 폴더에서(cd).`,
        },
      });
      process.exit(0);
    }
  }

  if (ev === 'PreToolUse' && input.tool_name === 'Bash') {
    // Commands that sit waiting on stdin (e.g. `python -` with no heredoc) hang until timeout.
    if (/\b(python3?|py|node)\s+-(\s|$)/.test(cmd) && !/<</.test(cmd) && !/\|\s*(python3?|py|node)\s+-/.test(cmd)) {
      out({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            '`python -`/`node -`가 stdin을 기다리며 멈춘다. heredoc(<<\'EOF\')으로 입력을 주거나, 파일 수정은 Edit 도구를 써라.',
        },
      });
    }
    process.exit(0);
  }

  if (ev === 'PreToolUse') {
    if (input.tool_name !== 'AskUserQuestion') process.exit(0);
    out({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `overnight 진행 중 (마감까지 ${left}). 사용자는 자고 있어 답할 수 없다. ` +
          '질문 대신 스스로 고르고 .overnight/DECISIONS.md 에 근거와 바꾸는 법을 적은 뒤 계속하라.',
      },
    });
    process.exit(0);
  }

  if (ev !== 'Stop') process.exit(0);

  // Token budget reached, or a dry loop proven by the files: wrap up, then let go.
  if (overBudget(run, input)) wrapUpGate(run);
  const exitProblem = fs.existsSync(path.join(run, '.overnight', 'EXHAUSTED')) ? exhaustedProblem(run) : null;
  if (exitProblem === '') wrapUpGate(run);

  out({
    decision: 'block',
    reason:
      (exitProblem ? `EXHAUSTED 거부: ${exitProblem} ` : '') +
      `overnight 마감까지 ${left} 남음. 멈추지 마라 — 사용자는 자고 있다. ` +
      '결정이 필요하면 스스로 고르고 .overnight/DECISIONS.md 에 기록, 되돌릴 수 없는 행위는 "아침에 할 일"로 미룬다. ' +
      '루프를 계속하라: REMAINING에서 줍기 → 만들기 → 기록(WORKLOG/REMAINING) → 커밋. ' +
      'REMAINING이 비었으면 PLAN 목표를 다시 읽고 재기획해 다음 항목 3~5개를 REMAINING에 추가하라. ' +
      '진행 보고는 채팅이 아니라 .overnight/LOG.md 에. ' +
      '같은 상태를 로그에 반복해 적는 건 진행이 아니다. 재기획으로도 의미 있는 항목이 안 나오면 ' +
      '.overnight/EXHAUSTED 에 "1. REMAINING 2. 재기획 3. 정리 4. 문서 5. 리뷰" 근거를 한 줄씩 적고 .overnight/MORNING.md 를 쓴 뒤 멈춰라.',
  });
  process.exit(0);
});
