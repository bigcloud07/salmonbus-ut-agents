<div align="center">
  <h1>연어 UT 에이전트</h1>
  <p>네 명의 AI 페르소나가 연어를 사용하고, 관찰실에서 그 과정을 함께 살펴봅니다.</p>
  <p>
    <a href="https://github.com/woowacourse-teams/2026-salmonbus"><strong>연어 원본 저장소</strong></a>
    &nbsp;·&nbsp;
    <a href="https://www.salmonbus.com/"><strong>연어 서비스</strong></a>
    &nbsp;·&nbsp;
    <a href="#빠른-시작"><strong>빠른 시작</strong></a>
  </p>
  <p><code>Node.js 22.9+</code> &nbsp; <code>Playwright</code> &nbsp; <code>GPT-6 Luna</code></p>
</div>

![연어 UT 관찰실에서 medium과 low 리포트의 Markdown 미리보기를 나란히 보는 모습](docs/ut-viewer.png)

*예시 기록으로 본 웹 관찰실의 리포트 비교 화면입니다.*

## 빠른 시작

```sh
git clone https://github.com/bigcloud07/salmonbus-ut-agents.git
cd salmonbus-ut-agents
npm ci
npx playwright install chromium
npm run web
```

1. [연어 UT 관찰실](http://127.0.0.1:4310/)을 열고 OpenAI API 키를 입력합니다. 환경 변수나 `.env`에 `OPENAI_API_KEY`가 있으면 그 값을 사용합니다.
2. **실행할 참가자**에서 한 명 또는 **전체 참가자**를 선택하고 **UT 시작**을 누릅니다. 처음 실행할 때는 **강정식 · 파일럿**을 선택할 수 있습니다.
3. **사용 기록**에서 행동을 클릭해 당시 화면을 확인합니다. 실행이 끝나면 **인터뷰**에서 추가 질문을 보내고 **그룹 대화**, **리포트**를 읽을 수 있습니다.

웹에 입력한 키는 해당 탭에서 사용합니다. 저장된 실행은 키 없이 열 수 있습니다. 모델을 호출할 때 화면 캡처와 페르소나 기록을 OpenAI API에 보내며 사용량에 따라 과금됩니다. [OpenAI API 데이터 처리](https://developers.openai.com/api/docs/guides/your-data)

## 참가자와 테스트 흐름

| 참가자 | 평소 타는 버스 | 이용 습관 |
| --- | --- | --- |
| **강정식** (`P1`) | 9007번, 운중동행정복지센터 → 서울역 방면 | 주 5회 탑승하고 노선에 익숙합니다. |
| **천상민** (`P2`) | 9300번, 도촌동9단지앞 → 서울역 방면 | 좌석 가능성에 따라 출발 시각을 조정합니다. |
| **정미란** (`P3`) | 3000번, 미사역호반써밋 → 판교 방면 | 최근 타기 시작해 정류장과 방면을 다시 확인합니다. |
| **김상효** (`P4`) | 1101번, 단국대정문 → 신분당선강남역 방면 | 용인 수지구에 거주하는 무대 및 세트 디자이너입니다. |

NVIDIA가 공개한 CC BY 4.0 데이터셋에서 네 참가자의 원본 행을 골라 [로컬 JSON](data/nemotron-personas-korea.json)에 각 행의 26개 필드를 보관합니다. UT에서는 이 파일의 원본 프로필과 연어 테스트용 통근 설정을 함께 모델에 전달합니다. 각 실행의 `run.json`에는 당시 프로필과 원본 행 ID, 데이터셋 리비전을 저장합니다. [NVIDIA Nemotron-Personas-Korea](https://huggingface.co/datasets/nvidia/Nemotron-Personas-Korea/tree/ada0f5b53a38bb5a30cce09358adde883c1ab63a)

1. **자유 탐색**에서 참가자에게 첫 화면만 보여 줍니다.
2. **목표 기반 테스트**는 새 비회원 세션에서 시작합니다. 참가자는 평소 타는 버스의 도착 시간과 좌석 예보를 찾고, 다음 출근 때 다시 볼 방법을 탐색합니다.
3. **인터뷰와 그룹 대화**에서 참가자는 자신이 본 화면과 한 행동을 바탕으로 경험을 이야기합니다. 리포트에는 과업 달성 여부, 실제 동선, 관찰 근거를 남깁니다.

관찰 중에는 조작 방법을 알려 주지 않습니다. 합성 참가자에게서 발견한 문제는 실제 사용자 테스트에서 확인할 가설로 활용합니다. [우아한테크코스 UT 실습 가이드](https://techcourse-lms-plus-web.woowahan.com/missions/52?step=495)

## 실행 기록과 검증

각 실행은 로컬 `runs/<run-id>/`에 저장됩니다.

**리포트** 탭에서 `medium`과 `low` 결과를 나란히 볼 수 있습니다. **미리보기**에서는 제목, 표, 근거 링크가 표시되고, **Markdown 원문**으로 전환하거나 파일을 다운로드할 수 있습니다. 재분석에는 선택한 실행의 인터뷰와 행동 전후 화면을 사용합니다. 관찰자 기본값은 `medium`이며, 재분석 결과는 `report-medium.md`, `report-low.md`에 따로 저장됩니다.

| 파일 | 내용 |
| --- | --- |
| `report.md` | 과업별 결과와 주요 발견, 근거 화면 링크 |
| `events.jsonl`, `screens/` | 시간순 행동과 발언, 단계별 화면 |
| `interviews.md`, `discussion.md` | 개별 인터뷰와 참가자 간 대화 |

운영 테스트는 비회원으로 실행하며 로그인 안내 화면까지 관찰할 수 있습니다. `npm test`는 운영 인증 요청과 쓰기 차단, 로컬 카카오 대역에서의 인증 인계와 복귀, 웹 관찰실의 실행과 추가 질문을 검증합니다. 실제 카카오 인증과 즐겨찾기 저장 검증에는 운영 UT 전용 계정이 필요합니다.

<details>
<summary>터미널에서 실행하기</summary>

환경 변수나 `.env`에 `OPENAI_API_KEY`를 설정한 뒤 실행합니다. 명령에는 참가자 이름 대신 표에 적힌 ID를 사용합니다. 아래 파일럿과 인터뷰 예시는 강정식(`P1`)을 선택합니다.

```sh
npm run ut -- run --persona P1
npm run ut -- run
npm run ut -- interview <run-id> P1
npm run ut -- report <run-id>
npm run ut -- report <run-id> --effort low
```

추가 질문에 `P1-arrival-01` 같은 화면 ID를 적으면 참가자가 그 화면을 함께 참조합니다.

</details>
