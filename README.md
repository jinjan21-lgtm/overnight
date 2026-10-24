# overnight

> 아침에 "결정해주세요" 화면만 떠 있는 일을 없앤다.

Claude Code 스킬 + Stop 가드 훅. "밤새 돌려", "10시간 돌려, 자고 올게" 같은 오더에 발동한다. 마감 전에는 사용자를 기다리지 않는다. 결정은 스스로 내려 기록하고, 되돌릴 수 없는 행위만 아침으로 미루고, 맡긴 일이 일찍 끝나면 다음 할 일 사다리를 탄다.

*A Claude Code skill plus a Stop guard hook for unattended overnight runs: before the deadline it never waits on the user — it decides, logs the decision with how to reverse it, defers only irreversible actions to a morning checklist, and keeps working through a fallback ladder when the assigned task finishes early.*

## 왜 만들었나

바이패스 모드로 10시간을 맡기고 잤는데, 아침에 보니 의사결정 질문 하나에서 멈춰 내 대답을 기다리고 있었다.

스킬 없이 측정해 보면 Claude는 결정 앞에서는 꽤 잘 버틴다. 무너지는 곳은 **맡긴 일이 일찍 끝났을 때**다. 2시간 30분 만에 일을 끝낸 에이전트는 7시간 30분을 남기고 이렇게 멈췄다.

> "다음에 하나 고르시면 바로 하겠습니다."

이유는 이랬다.

> "'10시간 돌려'는 쓸 수 있는 시간의 상한이지, 10시간을 다 채우라는 지시는 아니라고 읽는다."
> "범위를 넓히면 사용자가 일어나서 검토할 변경만 커진다."

그리고 구조적인 문제가 하나 더 있다. 도구 호출 없이 텍스트만 내보내면 턴이 끝난다. "아침에 보실 메모"를 채팅에 쓰는 순간 세션은 멈춘다.

## 어떻게 작동하나

**스킬 (규칙)**
- 시작: `.overnight/deadline`에 마감 시각, `overnight/<날짜>` 브랜치, 질문 없이 착수
- 결정 포인트: 되돌릴 수 있으면 고르고 `.overnight/DECISIONS.md`에 근거와 바꾸는 법을 남긴다. 되돌릴 수 없으면(삭제, push, 결제, 공유 리소스) 대안으로 진행하고 실제 행위는 `아침에 할 일`로
- 작업 루프: REMAINING에서 줍기 → 만들기 → 커밋 → WORKLOG/REMAINING 기록 → 비면 PLAN 목표를 다시 읽고 재기획 → 다시 줍기 (session-handoff 문서와 그대로 연계)
- 한 항목 = 한 커밋 (`[goal]` / `[overnight]`). 아침에 `git revert`로 골라 버리면 된다
- 막히면 30분 뒤 WIP 브랜치에 보존하고 다음 항목으로
- 진행 보고는 채팅이 아니라 `.overnight/LOG.md`. 채팅은 마감 때 아침 보고 한 번

**guard 훅 (잠금)**
- `.overnight/deadline`이 미래인 동안 Stop을 막고 AskUserQuestion을 거부한다
- 출구는 하나: `.overnight/EXHAUSTED` + 파일 흔적 검사 (재기획 3회 이상, 마지막 후보 5개 이상, 제외 사유는 비목표·비가역뿐, REMAINING 열린 항목 0). 공회전과 조기 종료를 둘 다 막는다
- `python -`처럼 stdin을 기다리며 멈출 Bash 명령을 거부한다
- deadline 파일이 없으면 아무것도 안 한다. 평소 세션에는 영향 없음
- 잠금은 deadline을 **쓴 세션**에만 걸린다(`.overnight/owner`). 밤샘 중에 같은 폴더에서 다른 세션을 열어도 그 세션은 평소처럼 동작한다. 같은 저장소에서 밤샘을 하나 더 시작하면 `git worktree`로 폴더를 나눠 따로 돈다

아침 보고 예:
```
## 밤샘 결과 (23:00 → 09:00)
골: 주문 테이블 마이그레이션 — 부분 완료
### 내가 내린 결정 (바꾸려면)
- D1 orders_legacy 삭제 대신 rename 보존 → 이관 후 삭제로 바꾸려면 SQL 3줄, 약 15분
### 아침에 할 일 (명령 한 줄로)
- [ ] `git push -u origin overnight/1024` — CI 돌리려면
### 막힌 작업
- 리팩터링 #3 — 브랜치 overnight/1024-wip-refactor3
### 덤으로 한 일 (커밋 단위, 버려도 됨)
- 7e8f9a0 [overnight] 린트 경고 40 → 3
```

## 설치

```
/plugin marketplace add jinjan21-lgtm/overnight
/plugin install overnight@overnight
```

플러그인 설치는 guard 훅(`hooks/hooks.json`)까지 함께 등록한다.

심볼릭 링크로 쓴다면 `~/.claude/skills/overnight`에 `skills/overnight`를 연결하고, `~/.claude/settings.json`에 훅을 직접 넣는다.

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<경로>/skills/overnight/hooks/guard.js\"" }] }],
    "PreToolUse": [{ "matcher": "AskUserQuestion|Bash", "hooks": [{ "type": "command", "command": "node \"<경로>/skills/overnight/hooks/guard.js\"" }] }],
    "PostToolUse": [{ "matcher": "Bash|Write", "hooks": [{ "type": "command", "command": "node \"<경로>/skills/overnight/hooks/guard.js\"" }] }]
  }
}
```

Node.js가 필요하다.

## 검증

writing-skills의 RED → GREEN → REFACTOR, 그리고 `claude -p` 실전 실행.

| 단계 | 결과 |
|---|---|
| RED 4건 (스킬 없음) | 결정 3건은 통과, **일찍 끝난 경우 실패** (7.5시간 남기고 멈춤) |
| GREEN 3건 | 3/3 — 일찍 끝나도 사다리로 마감까지, 비가역은 대안+아침 할 일, 모호한 골은 D1로 정의 |
| 실전 1 (훅만) | Stop 22회 차단, 마감까지 유지. 단 할 일이 없을 때 공회전 발견 |
| 실전 2 (출구 추가) | 7턴 만에 EXHAUSTED 쓰고 정상 종료 |
| 실전 3 (스킬+훅, 백로그 3개) | 골 + 백로그 3개 전부 처리, 결정 3건 기록, 커밋 4개 |
| 실전 9 (같은 폴더에 세션 3개 동시) | 평소 세션은 잠기지 않고 11초에 종료, 두 번째 밤샘은 worktree로 갈라져 각자 마감까지 |
| 실전 4~8 (기획·개발 반복, 인수인계 연계, 25분 × 5회) | 재기획 없음 → 5회, 커밋 6 → 20. 모델 판단 출구는 매번 다른 합리화로 뚫려서, 출구를 파일 흔적(재기획 회차·후보·제외 사유·REMAINING 체크)으로만 열도록 바꿈 |

전체 기록: [skills/overnight/tests/tdd-record.md](skills/overnight/tests/tdd-record.md)

## 주의

- 바이패스 모드에서도 이 스킬은 삭제·push·결제·배포를 하지 않는다. 아침 할 일 목록에 명령으로 남긴다.
- 훅은 Stop을 연속 8회까지만 막을 수 있다(Claude Code 기본 상한, 도구 호출 시 리셋). 일을 하고 있는 한 문제되지 않는다.

## 구성

```
.claude-plugin/       plugin.json, marketplace.json
hooks/hooks.json      플러그인용 훅 등록
skills/overnight/
  SKILL.md
  hooks/guard.js      Stop / AskUserQuestion / Bash 가드, 세션 소유권
  tests/guard.test.js 훅 단위 테스트 (node --test)
  tests/tdd-record.md
```

## 라이선스

MIT
