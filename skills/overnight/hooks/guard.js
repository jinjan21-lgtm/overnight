#!/usr/bin/env node
// overnight guard — Stop / PreToolUse(AskUserQuestion) hook.
// Active only while <cwd>/.overnight/deadline holds a future ISO time.
// No deadline file, unreadable, or past deadline -> does nothing.
const fs = require('fs');
const path = require('path');

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  const cwd = input.cwd || process.cwd();
  let deadline;
  try {
    deadline = new Date(fs.readFileSync(path.join(cwd, '.overnight', 'deadline'), 'utf8').trim());
  } catch { process.exit(0); }
  if (isNaN(deadline)) process.exit(0);

  const leftMin = Math.round((deadline - Date.now()) / 60000);
  if (leftMin <= 0) process.exit(0);

  // Early exit before the deadline is allowed only when the files show the loop really ran dry:
  //  - .overnight/EXHAUSTED has lines "1." .. "5." (12+ chars), none resting on a deferral
  //  - .overnight/DECISIONS.md has >= 3 replan sections "## R<n>", the last with >= 5 candidates,
  //    each "채택" or excluded only as 비목표/비가역
  //  - docs/REMAINING.md (if present) keeps its done items ([x]) and has no open item
  //    except ones marked 막힘/비가역/아침
  let exitProblem = '';
  const read = (...p) => { try { return fs.readFileSync(path.join(cwd, ...p), 'utf8'); } catch { return null; } };
  const exhausted = input.hook_event_name !== 'PreToolUse' && read('.overnight', 'EXHAUSTED');
  if (exhausted) {
    const lines = exhausted.split(/\r?\n/).map((l) => l.trim());
    const DEFER = /보류|미실시|안\s?함|하지\s?않|생략|skip|나중에|가치가?\s?(낮|적|없)|대체\s?가능|범위\s?(확장|밖)|불필요|과하/i;
    const missing = [1, 2, 3, 4, 5].filter((n) => !lines.some((l) => l.startsWith(`${n}.`) && l.length >= 12));
    const deferred = lines.filter((l) => /^[1-5]\./.test(l) && DEFER.test(l));

    const rounds = (read('.overnight', 'DECISIONS.md') || '').split(/^(?=## R\d+)/m).filter((s) => /^## R\d+/.test(s));
    const last = rounds[rounds.length - 1] || '';
    const cands = last.split(/\r?\n/).filter((l) => /^\s*[-*]\s+/.test(l));
    const badCand = cands.find((l) => !/채택|비목표|비가역/.test(l));

    const rem = read('docs', 'REMAINING.md');
    const remLines = rem ? rem.split(/\r?\n/) : [];
    const open = remLines.filter((l) => /^\s*[-*]\s*\[ \]/.test(l) && !/막힘|비가역|아침/.test(l));
    const done = remLines.filter((l) => /^\s*[-*]\s*\[x\]/i.test(l));

    if (missing.length) exitProblem = `EXHAUSTED에 ${missing.join(', ')}번 줄이 없거나 너무 짧다.`;
    else if (deferred.length) exitProblem = `EXHAUSTED가 미룬 일을 근거로 쓴다: "${deferred[0]}". 미룬 건 소진이 아니다 — 그 일을 하라.`;
    else if (rounds.length < 3) exitProblem = `DECISIONS.md의 재기획(## R1, ## R2 ...)이 ${rounds.length}회뿐이다. 3회 이상 재기획하라.`;
    else if (cands.length < 5) exitProblem = `마지막 재기획에 후보가 ${cands.length}개뿐이다. 5개 이상 적어라.`;
    else if (badCand) exitProblem = `후보 제외 사유는 비목표·비가역뿐이다: "${badCand.trim()}". 그 후보를 만들어라.`;
    else if (rem && !done.length) exitProblem = 'docs/REMAINING.md에 완료 기록([x])이 없다. 항목을 지우지 말고 체크로 남겨라.';
    else if (open.length) exitProblem = `docs/REMAINING.md에 열린 항목이 남아 있다: "${open[0].trim()}". 그것부터 하라.`;
    else process.exit(0);
  }
  const left = `${Math.floor(leftMin / 60)}시간 ${leftMin % 60}분`;

  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash') {
    // Commands that sit waiting on stdin (e.g. `python -` with no heredoc) hang until timeout.
    const cmd = String((input.tool_input || {}).command || '');
    if (/\b(python3?|py|node)\s+-(\s|$)/.test(cmd) && !/<</.test(cmd) && !/\|\s*(python3?|py|node)\s+-/.test(cmd)) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            '`python -`/`node -`가 stdin을 기다리며 멈춘다. heredoc(<<\'EOF\')으로 입력을 주거나, 파일 수정은 Edit 도구를 써라.',
        },
      }));
    }
    process.exit(0);
  }

  if (input.hook_event_name === 'PreToolUse') {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `overnight 진행 중 (마감까지 ${left}). 사용자는 자고 있어 답할 수 없다. ` +
          '질문 대신 스스로 고르고 .overnight/DECISIONS.md 에 근거와 바꾸는 법을 적은 뒤 계속하라.',
      },
    }));
    process.exit(0);
  }

  // Stop
  console.log(JSON.stringify({
    decision: 'block',
    reason:
      (exitProblem ? `EXHAUSTED 거부: ${exitProblem} ` : '') +
      `overnight 마감까지 ${left} 남음. 멈추지 마라 — 사용자는 자고 있다. ` +
      '결정이 필요하면 스스로 고르고 .overnight/DECISIONS.md 에 기록, 되돌릴 수 없는 행위는 "아침에 할 일"로 미룬다. ' +
      '루프를 계속하라: REMAINING에서 줍기 → 만들기 → 커밋 → WORKLOG/REMAINING 기록. ' +
      'REMAINING이 비었으면 PLAN 목표를 다시 읽고 재기획해 다음 항목 3~5개를 REMAINING에 추가하라. ' +
      '진행 보고는 채팅이 아니라 .overnight/LOG.md 에. ' +
      '같은 상태를 로그에 반복해 적는 건 진행이 아니다. 재기획으로도 의미 있는 항목이 안 나오면 ' +
      '.overnight/EXHAUSTED 에 "1. REMAINING 2. 재기획 3. 정리 4. 문서 5. 리뷰" 근거를 한 줄씩 적고 아침 보고를 쓴 뒤 멈춰라.',
  }));
  process.exit(0);
});
