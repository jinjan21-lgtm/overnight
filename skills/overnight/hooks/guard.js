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

  // Ladder exhausted: .overnight/EXHAUSTED must account for all 4 steps ("1." .. "4.", 20+ chars each).
  if (input.hook_event_name !== 'PreToolUse') {
    try {
      const ex = fs.readFileSync(path.join(cwd, '.overnight', 'EXHAUSTED'), 'utf8');
      const ok = [1, 2, 3, 4].every((n) =>
        ex.split(/\r?\n/).some((l) => l.trim().startsWith(`${n}.`) && l.trim().length >= 20));
      if (ok) process.exit(0);
    } catch {}
  }
  const left = `${Math.floor(leftMin / 60)}시간 ${leftMin % 60}분`;

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
      `overnight 마감까지 ${left} 남음. 멈추지 마라 — 사용자는 자고 있다. ` +
      '결정이 필요하면 스스로 고르고 .overnight/DECISIONS.md 에 기록, 되돌릴 수 없는 행위는 "아침에 할 일"로 미룬다. ' +
      '맡긴 일이 끝났으면 사다리 다음 항목(강화 → REMAINING/TODO → 린트 정리 → 문서·리뷰)으로. ' +
      '진행 보고는 채팅이 아니라 .overnight/LOG.md 에. ' +
      '같은 상태를 로그에 반복해 적는 건 진행이 아니다. 사다리 4단계를 정말 다 탔다면 ' +
      '.overnight/EXHAUSTED 에 "1. ~ 4." 각 단계에서 한 일이나 할 게 없는 근거를 한 줄씩 적고 아침 보고를 쓴 뒤 멈춰라.',
  }));
  process.exit(0);
});
