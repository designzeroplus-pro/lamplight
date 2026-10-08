# Lamplight

타자기 감성의 macOS 노트 앱 (Electron). 어두운 방의 작은 램프 아래에서 한 글자씩 쓰고,
다 쓰면 메모장 · 이메일 · 도트 프린터 영수증 같은 레트로 PC 템플릿에 담아 PDF · 이미지 · Markdown으로 내보냅니다.

```bash
npm install
npm start          # 개발 실행
npm run dist       # arm64 · Intel DMG (ad-hoc 서명)
```

## 내보내기 (⌘E)

- **레트로 템플릿** (AI 없이도 됨): 노트를 옛날 PC 화면 속 물건으로 바꿔 미리 보고 PDF · 이미지(PNG) · Markdown · 복사로 내보냅니다.
  PDF와 이미지는 종이(창) 크기에 꼭 맞게 잘리고, 이미지는 2배 해상도(바탕화면은 1080 × 1080)입니다.
  - **메모장**: 윈도우 95풍 메모장 창
  - **이메일**: 받는 사람 "미래의 나", 보낸 사람 "오늘의 나"인 새 메시지 창
  - **오늘의 영수증**: 도트 프린터 연속 용지. `- 품목 ··· 값`으로 쓴 항목은 점선으로 이어짐
  - **PC통신 게시판**: 파란 화면 게시글
  - **CRT 터미널**: 초록 형광 모니터에 `TYPE POEM.TXT`
  - **메시지 상자**: 아이콘과 [확인] 버튼이 있는 알림창
  - **바탕화면**: 청록 바탕화면에 한 줄을 띄운 SNS용 정사각형 이미지
- **AI로 어울리게 다듬기** (토글, 기본 꺼짐): 템플릿마다 짝이 있어요 — 메모장은 맞춤법만, 이메일은 미래의 나에게 쓰는 편지로,
  영수증은 하루를 품목과 값으로, 게시판은 90년대 게시글로, 터미널은 시로, 메시지 상자는 한두 문장으로, 바탕화면은 한 줄로.
  "더 바라는 점"을 덧붙일 수 있고, 켤 때만 글이 ChatGPT(로그인) 또는 Claude(API 키)로 전송됩니다.
- 템플릿은 `src/app.js`의 `TEMPLATES`(이름, AI 요청), `src/shared.js`의 `templateHtml`(창 · 머리글 같은 틀),
  `src/doc.css`의 `.doc[data-template=…]`(모양)로 정의합니다. 픽셀 글꼴은 [갈무리](https://github.com/quiple/galmuri)(OFL)입니다.
- PDF는 `src/print.html`에 미리보기와 같은 문서 스타일(`src/doc.css`)로 렌더링해 `printToPDF`로 만듭니다.

## AI 연결 (앱 메뉴 › AI 연결)

**ChatGPT로 로그인 (Plus · Pro 구독)** — `chatgpt.js`
- OpenAI의 [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source) 흐름(오픈소스·로컬 앱용 미리보기)을 따릅니다.
  브라우저에서 `auth.openai.com`에 로그인하면 `http://127.0.0.1:1456/auth/callback`으로 돌아오고(PKCE, state, nonce),
  처음에는 `dynamic_agent_client`로 등록해 발급된 `client_id`를 다음 로그인에 다시 씁니다.
- 요청은 Responses API(`store: false`, `stream: true`)로 요청하며 ChatGPT 구독 한도에서 차감됩니다.
  모델은 계정의 모델 목록에서 고릅니다. 한도 초과나 구독 미지원은 따로 안내합니다.
- 토큰(1시간, 30일 갱신 토큰)은 `safeStorage`로 암호화해 `chatgpt.bin`(권한 0600)에 저장하고 만료 전에 자동 갱신합니다.
- 상용으로 배포하려면 OpenAI의 파트너 승인(interest form)이 필요합니다.

**Claude API 키** — `ai.js`
- `claude-opus-5-5`를 `@anthropic-ai/sdk` 스트리밍으로 호출합니다. 안전 분류기가 거절하면 서버 측 대체 모델로 다시 실행합니다(`fallbacks: "default"`).
- 키는 `safeStorage`(macOS 키체인)로 암호화해 `anthropic-key.bin`에 저장합니다. 저장된 키가 없으면 `ANTHROPIC_API_KEY`를 씁니다.
- Claude Pro · Max 개인 구독은 다른 앱에서 쓸 수 없어서(Anthropic 정책) API 키만 지원합니다.

## 쓰기

- 목록: `1.` `- ` `- [ ] ` 뒤에서 Enter로 이어 쓰고, 빈 항목에서 Enter를 한 번 더 누르면 끝납니다.
  Tab / ⇧Tab으로 들여쓰기·내어쓰기, 항목을 지우거나 옮기면 번호를 다시 매깁니다. `[ ]`를 클릭하면 체크됩니다.
- 가벼운 마크다운: `# 제목`, `**굵게**`, `> 인용` (기호는 흐리게, 글자 폭은 그대로)
- 스크롤해서 지난 내용을 읽을 때는 방이 조금 밝아집니다(설정에서 끌 수 있음).
- ⌘T는 `[14:30]`처럼 지금 시각을 적고, 에디터와 PDF에서 타임스탬프로 표시됩니다.
- 사이드바: 노트 우클릭 › 맨 위에 고정, 빈 곳 우클릭 › 정렬(수정한 날짜 · 만든 날짜 · 제목).

## 글꼴 (설정 › 종이 › 글꼴)

타자기(Courier Prime · 나눔고딕코딩, 기본) · LINE Seed · 마루 부리.
`src/fonts/`에 들어 있고 `src/fonts.css`에서 등록합니다. 글꼴별 저작권과 라이선스 원문은 [src/fonts/README.md](src/fonts/README.md)에 있습니다. 고정폭이 아닌 글꼴에서는 제목·굵게를
글자 굵기 대신 잉크를 두껍게 그려 표시합니다(미러와 textarea의 글자 폭이 어긋나지 않도록).
LINE Seed · 마루 부리는 Bold 한 가지 굵기만 들어 있어 본문도 Bold로 보입니다.

## 백업 (파일 메뉴)

- **모든 노트 백업…**: 고른 폴더에 `Lamplight 백업 <날짜>/`를 만들고, `lamplight-backup.json`(전체 데이터)과
  폴더별로 정리한 `.md` 사본을 저장합니다.
- **백업에서 가져오기…**: `lamplight-backup.json`을 고르면 아직 없는 노트와 폴더만 추가합니다(이미 있는 노트는 덮어쓰지 않음).

## 설정 (⌘,)

밤 / 낮(시스템 설정 따르기) · 글꼴 · 글자 크기 · 레일 위치 · 스크롤할 때 방 밝히기 · 마우스를 따라 빛 움직이기 · 타자기 소리(켜기, 크기, 종류) ·
움직임 줄이기. 처음 안내는 앱 메뉴 › 처음 안내 다시 보기로 다시 열 수 있습니다.

## 배포와 업데이트

내려받기: https://github.com/designzeroplus-pro/lamplight/releases

서명 없는 개인 배포입니다. 처음 열 때 시스템 설정 › 개인정보 보호 및 보안에서 "그래도 열기"를 한 번 누르면 됩니다.
macOS는 서명된 앱만 스스로 교체할 수 있어서, 앱은 실행할 때(그리고 6시간마다) GitHub의 최신 릴리스를 확인해
새 버전이 있으면 알려주고 이 Mac에 맞는 DMG를 내려받게 해줍니다. 앱 메뉴 › 업데이트 확인…으로 직접 확인할 수도 있습니다.

새 버전 내보내기 (빌드 폴더는 `.noindex`로 끝나서 Spotlight·Launchpad에 사본이 나타나지 않습니다):

```bash
npm version patch --no-git-tag-version   # package.json 버전 올리기 (예: 0.1.0 → 0.1.1)
npm run dist                              # dist.noindex/에 arm64 · Intel DMG (ad-hoc 서명)
git commit -am "Release v0.1.1" && git push
gh release create v0.1.1 dist.noindex/Lamplight-0.1.1-arm64.dmg dist.noindex/Lamplight-0.1.1.dmg --title "Lamplight 0.1.1" --notes "변경 사항"
```

나중에 Apple Developer ID로 서명·공증하려면 인증서를 키체인에 설치하고 `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`를 설정한 뒤 `npm run release`를 씁니다.

## 단축키

| 키 | 동작 |
| --- | --- |
| ⌘N | 새 노트 (지금 보는 폴더에) |
| ⌘⇧N | 새 폴더 |
| Tab / ⇧Tab | 목록 들여쓰기 / 내어쓰기 |
| ⌘, | 설정 |
| ⌘K | 모든 노트 검색 |
| ⌘F / ⌘G / ⌘⇧G | 이 노트에서 찾기 / 다음 / 이전 |
| ⌘T | 지금 시각 적기 |
| ⌘L | 램프 켜기 / 끄기 |
| ⌘⇧L | 밤 / 낮 전환 (설정에서 시스템 설정 따르기도 가능) |
| ⌘⌥⌫ | 노트를 휴지통으로 |
| ⌘⇧S | 타자기 소리 |
| ⌘\ | 사이드바 |
| ⌘E | 내보내기 (레트로 템플릿 · PDF · 이미지 · Markdown) |

## 구조

```
main.js            메인 프로세스: 창, 메뉴, 파일 저장, 검색, PDF 내보내기, 업데이트 확인
ai.js              AI 생성: Claude(API 키) 호출, ChatGPT로 위임
chatgpt.js         ChatGPT로 로그인(OAuth PKCE, 토큰 갱신) + Responses API 스트리밍
preload.js         contextBridge로 노출하는 window.memo API
src/
  index.html
  styles.css
  shared.js        메인·화면·테스트가 같이 쓰는 순수 함수 (미리보기, 정렬, Markdown 렌더러, 템플릿 렌더링, 번호 다시 매기기, 버전 비교)
  app.js           화면 조립, 노트 저장/전환, 폴더, 검색, 내보내기, 프레임 루프
  doc.css          내보내기 문서 스타일 (미리보기 · PDF 공용)
  print.html       PDF 렌더링 템플릿
  ink-editor.js    투명 textarea + 글자별 span 미러 (잉크 번짐·타격 애니메이션)
  lamp.js          어둠 캔버스에서 빛 원뿔을 잘라내는 램프 렌더러
  sound.js         Web Audio로 합성한 타자기 소리 (타건, 스페이스, 캐리지 리턴, 벨)
test/              `npm test` (node:test) — shared.js 단위 테스트
```

데이터는 `~/Library/Application Support/Lamplight/notes/<id>/`에 저장됩니다.
폴더 목록은 `folders.json`, 사이드바 목록 캐시는 `index.json`(노트 파일 수정 시각으로 갱신), 창 크기·위치는 `window.json`에 있습니다.
폴더를 지우면 안의 노트는 미분류로 옮겨집니다.
