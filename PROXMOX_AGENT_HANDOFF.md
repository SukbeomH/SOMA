# SOMA 웹 버전 — Proxmox x64 에이전트 전달 프롬프트

작성 기준: 2026-11-10 (Asia/Seoul). 아래 프롬프트 전체를 대상 에이전트에게 전달한다.
환경 정보가 이미 제공됐거나 확인 가능하면 다시 묻지 말고 조사부터 진행한다.

이 문서는 VM + Docker Compose 경로다. **비특권 CT에 Docker 없이 직접 설치**하려면
[CT 직접 설치 가이드](PROXMOX_CT_AGENT_HANDOFF.md)를 사용한다. CT 경로에서는 아래 VM/Docker 지시 대신 해당 가이드의 설치·운영 절차를 적용한다.

---

Proxmox x64 환경에 포크한 SOMA 웹 버전을 구축하고 실제 사용 흐름을 검증해 줘.
계획만 제안하지 말고, 이미 승인된 작업 범위에서 구축·시험·운영 문서 작성까지 진행해 줘.

## 목표와 기준 소스

- 저장소: https://github.com/SukbeomH/SOMA.git
- 브랜치: `feat/local-web-ui`
- 검증 기준 커밋: `f56f444def1f98ead40e6a1168c839b0be5290d5`
- 해당 커밋을 기준으로 시작한다. 원격에 새 커밋이 있으면 차이를 보고하고 실제 사용 SHA를 기록한다. 무조건 최신 버전으로 모든 의존성을 올리지 않는다.
- CadQuery, 기존 좌측 3D 뷰어와 우측 에이전트 터미널을 유지한다.
- 기존 Electron UI를 삭제하지 않되, 웹 서비스 실행에 Electron·Xvfb·X11·서버 Chromium을 추가하지 않는다.
- 핵심 흐름: Codex에 요구사항 전달 → Python 변경 → CAD 재생성 → 형상 선택·강조 → 추가 수정 → 뷰어 갱신 → 원본/STEP/STL 다운로드.
- 파일 업로드, Codex resume, PNG/MP4 렌더링, PNG 클립보드 붙여넣기도 검증한다.
- FEM은 기본 이미지에 없으므로 아래 별도 단계로 추가·검증한다.

## 1. 환경 확인과 배치

먼저 현재 실행 위치가 Proxmox 호스트인지, VM인지, LXC인지 확인한다.
OS, 커널, `uname -m`, CPU/RAM, 여유 디스크, Docker Engine/Compose, Git, 현재 포트 사용과 권한을 기록한다.

기본 배치안은 **Proxmox → 전용 x86_64 Linux VM → Docker Compose**다.
Proxmox 호스트에 직접 Docker나 CAD 패키지를 설치하지 않는다.
이미 적합한 VM이 있으면 재사용한다. LXC만 있는 경우 nesting/권한 문제를 확인하고, privileged 전환이나 보안 제한 해제로 우회하지 않는다.
VM 생성·호스트 설정 변경이 필요하면 대상, CPU/RAM/디스크, 영향과 작업안을 먼저 제시한다.
초기 검증용 예산으로 4 vCPU, RAM 8 GiB, 디스크 40 GiB를 검토하되, 이는 보장된 최소 사양이 아니다. FEM 규모와 빌드 임시 공간에 따라 조정한다.
기존 VM·스토리지·프로젝트를 덮어쓰지 않는다.

VM 안의 별도 디렉터리에 clone한다. 기존 checkout이면 dirty 상태와 remote부터 확인한다.
다음 파일을 읽고 실제 코드와 교차 확인한다:
- `Dockerfile`, `compose.yaml`, `.dockerignore`
- `python/requirements-base.txt`, `python/requirements-web.txt`
- `WEB_LOCAL.md`, `RENDER_FEM_REVIEW.md`
- `app/src/main/web.ts`, `app/src/web/server.ts`, `app/src/web/render-service.ts`
- `validation/web-render-fem.json`, `validation/web-transfer-resume.json`

주의: `WEB_LOCAL.md` 하단에 “PNG/video desktop-only”라는 과거 제한 문구가 남아 있다. 상단의 구현 설명, 기준 커밋의 실제 코드와 검증 기록을 우선해 판단하고, 모순을 발견하면 배포 문서에 명시한다.
Mac 검증, 과거 ARM64 Docker 검증, 이번 x64 실행 결과를 구분한다. x64는 아직 검증 완료로 간주하지 않는다.

## 2. 최소 웹 서비스 구축

기존 Dockerfile/Compose로 `linux/amd64` 네이티브 빌드를 먼저 시도한다. ARM 에뮬레이션은 사용하지 않는다.
현재 이미지 구조는 Node 24 / Python 3.12 / Codex CLI 0.167.0이며, 실제 설치 버전과 이미지 ID를 기록한다.
Codex 네이티브 실행 파일과 node-pty가 x64에서 실제 실행되는지 확인한다. 이미지 빌드 성공만으로 완료 처리하지 않는다.
실패하면 정확한 오류와 아키텍처·wheel·공유 라이브러리 원인을 조사해 최소 변경으로 수정한다.

기본 명령:
```sh
docker compose config
docker compose up --build -d
docker compose ps
docker compose logs --tail=100 soma
```
출력에 인증 정보가 있으면 보고서에 복사하지 않는다.

유지할 조건:
- 컨테이너 사용자 UID 10001, privileged/host networking/Docker socket mount 없음.
- VM 호스트 게시 주소 `127.0.0.1:8765`.
- 컨테이너 내부 `0.0.0.0` 리스닝은 Docker 포트 전달용이다. 호스트 공개 주소와 구분한다.
- 자동 재시작은 현재 `restart: "no"`. 상시운영/자동 시작 변경은 별도로 설명한다.
- `/data`와 `/home/soma/.codex`는 서로 다른 영속 볼륨.
- 기존 Mac 인증 파일, 홈 디렉터리, 비밀 환경 파일을 이미지에 복사하지 않는다.

## 3. 사용자 브라우저 접속

현재 서버는 `127.0.0.1:<port>` Host/Origin과 브라우저 쿠키·단일 활성 클라이언트를 검사한다.
포트 바인딩만 `0.0.0.0`으로 바꾸거나 VM IP로 접속하는 방법을 완료된 원격 접근 구성으로 제시하지 않는다.

첫 검증은 사용자 승인하에 SSH 로컬 포트 포워딩을 사용하는 방안을 제시한다:
```sh
# 사용자 Mac에서 실행. <VM_USER>, <VM_IP>는 확인된 실제 값으로 교체.
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8765:127.0.0.1:8765 <VM_USER>@<VM_IP>
```
사용자 브라우저 URL: `http://127.0.0.1:8765/`.
기존 Mac SOMA가 8765를 쓰고 있으면 임의로 종료하지 않는다. VM Compose에 `SOMA_WEB_PORT=8876`을 일관되게 적용하고, 포워딩 양쪽 포트와 브라우저 URL도 모두 8876으로 맞춘다.
예: `ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8876:127.0.0.1:8876 <VM_USER>@<VM_IP>`.

LAN 직접 접속/도메인/리버스 프록시/외부 공개/방화벽 변경/상시 터널은 기본 범위 밖이다.
그 접근 방식이 필요하면 인증·TLS·WebSocket/SSE·Host/Origin 정책을 포함한 별도 안을 제시하고 승인 후 진행한다. 기존 검사를 삭제해서 해결하지 않는다.
실제 게시 주소는 `docker compose port`, Docker 설정과 `ss` 등으로 확인한다.

## 4. Codex 인증과 터미널

Docker 인증은 Mac과 별개다. 사용자에게 다음 정상 로그인 흐름을 안내하고, 로그인 자체는 사용자가 완료하도록 한다:
```sh
docker compose exec soma codex login --device-auth
```
API 키·토큰·로그인 코드·세션 원문을 Git, 이미지, 일반 로그 또는 보고서에 남기지 않는다.
계정/조직 정책으로 로그인이나 추론이 막히면 정확한 이유와 사용자에게 필요한 조치를 보고한다.
인증 정책이나 Codex sandbox를 끄거나 광범위한 호스트 마운트를 추가해 우회하지 않는다.

인증 후 실제 웹 터미널에서 Codex를 실행하고 모델 파일 수정까지 확인한다.
브라우저 재접속 및 컨테이너 재시작 후, 같은 모델 디렉터리에서 `codex resume --last --no-alt-screen`이 이전 대화를 복원하는지 확인한다.
이는 디렉터리의 최근 대화 복원이지 정확한 PTY·모든 탭·미전송 입력 복원이 아니다.

## 5. 브라우저/파일/렌더링 검증

실제 사용자 브라우저에서 다음을 검증한다. 서버 HTTP 체크만으로 브라우저 검증을 대체하지 않는다.
브라우저를 직접 제어할 수 없다면 실행 가능한 사용자 확인 절차를 주고, 해당 항목은 미검증으로 남긴다.

- CAD 생성, 회전·확대, 면 선택/강조, 선택 내용을 에이전트로 전달, 치수 수정 후 자동 갱신.
- 터미널 스크롤, 일반 텍스트 붙여넣기, 에이전트 실행.
- PNG/STEP 등 파일 업로드 및 원본 Python·SOMA/ZIP·STEP·STL 다운로드.
- 사진 붙여넣기: Codex 입력창 준비 후 클라이언트에서 PNG 복사 → ⌘V/Ctrl+V/＋Image → 서버 inputs/ 저장 → `[Image #1]` → 실제 이미지 인식.
- 사진은 PNG, 장당 20 MiB·32메가픽셀, 한 번에 최대 4개. 서버 OS 클립보드는 필요하지 않다. 브라우저 권한 거부와 일반 텍스트 동작도 확인한다.
- Render / FEM → Export PNG, 웹 터미널의 `soma render`.
- Animation → Make video → MP4·contact sheet·VTT 다운로드와 실제 재생.
- 영상은 클라이언트 브라우저에서 인코딩한다. 서버 GPU는 이 방식의 필수 조건이 아니다. 브라우저 연결과 WebGL/인코더 지원은 필요하다.
- 렌더 취소/브라우저 연결 끊김/없는 파일 오류를 확인한다. 기존 파일이 남았다는 이유로 새 성공 결과로 오인하지 않는다.

CAD 형상은 유효성, 솔리드 수, 치수, 구멍과 체적을 측정하고 STEP/STL 재읽기도 검사한다.
`validation/headless-model/`과 해당 검증 스크립트·기록을 재사용한다. STL 단위는 mm 기준임을 기록한다.
시험용 모델에서만 의도적 오류를 만든 뒤 원복한다. 사용자 원본을 실패 시험용으로 손상시키지 않는다.

## 6. x64 FEM 추가와 검증

**현재 기본 Docker 이미지에는 FEM용 gmsh/pyamg가 제외돼 있다. UI 버튼 존재가 컨테이너 FEM 지원을 의미하지 않는다.**

기본 웹 이미지 성공 후, x64 FEM용 선택 가능한 빌드 옵션/별도 target 또는 override를 최소 변경으로 마련한다.
`python/requirements-base.txt`의 제약을 사용한다. 현재 핀은 gmsh 4.15.2, pyamg 5.3.0이다.
x64 wheel 존재와 해당 이미지에서의 Python import/실제 solver 실행은 별도로 검증한다.
처음에는 기존 SOMA 내장 선형탄성 솔버로 시험하고, CalculiX 접촉·볼트 프리로드 해석은 별도 검증 범위로 보고한다.
ARM64 기본 빌드를 깨뜨리지 않는다. 돌아가는 컨테이너에 임시 pip 설치만 하고 완료 처리하지 말고 재빌드로 재현 가능하게 한다.

`validation/fem-review-model/`의 model.py, study.py를 별도 테스트 프로젝트로 가져온다.
주의: `.dockerignore`가 validation/과 app/test/를 제외하므로 런타임 이미지에 이 경로들이 있다고 가정하지 않는다. 테스트용 복사/마운트로 제공하되 비밀 파일이나 Docker socket을 노출하지 않는다.

시험: 40×10×10 mm Aluminium 6082 막대, 한쪽 고정, 반대쪽 축하중 100 N.
- 웹 UI에서 study.py 실행 → Analysis에서 응력/변위/하중 표시 → 결과 PNG 생성.
- `DISPLAY`/`WAYLAND_DISPLAY` 없는 환경에서 실제 실행.
- 반력 −100 N과 하중 +100 N의 평형 확인.
- 축방향 연신 이론값 FL/EA ≈ 0.0005714286 mm와 비교.
- 출력 변위의 반올림 정밀도를 고려해 오차를 기록. Mac의 0.0006 mm를 정밀 오차 검증값으로 취급하지 않는다.
- 메시 크기·요소/절점 수·실행시간·솔버·수렴성/메시 변경 민감도를 기록.
- 고정부의 국부 최대응력을 균일 축응력 1 MPa와 단순 비교해 실패/성공 판정하지 않는다.
- 시험 성공은 파이프라인 검증이며 3D 프린트 부품의 강도 인증이 아니다.

## 7. 영속성·운영·완료 보고

모델과 인증 볼륨을 보존한 채 stop/start와 컨테이너 재생성 후 데이터·Codex resume를 확인한다.
`docker compose down -v`, 볼륨 prune, 전체 디스크/스토리지 초기화는 하지 않는다.
모델 데이터는 정지 상태에서 일관되게 백업하고 별도 테스트 볼륨에 복원해 확인한다.
인증 볼륨은 민감 데이터다. 일반 결과물에 포함하지 말고 보호된 백업 또는 재로그인 방침을 명시한다.

최종 보고:
1. VM/OS/아키텍처/리소스와 프로젝트 경로, 브랜치·정확한 SHA.
2. 실제 사용자 접속 URL 및 연결 방법, 루프백 바인딩 증거.
3. 이미지 ID, Node/Python/CadQuery/OCP/Codex/Gmsh/솔버 버전.
4. 시작·종료·재실행·업데이트·백업·복원 명령과 롤백 절차.
5. CAD, Codex 수정/resume, 파일 전송, 이미지 붙여넣기, PNG/영상, FEM 각 항목의 실제 PASS/FAIL/미검증 및 증거.
6. 필요한 최소 소스/Compose 변경 내역과 재현 가능한 테스트 명령.
7. 실패 원인과 아직 필요한 사용자 작업. Mac의 이전 성공을 이번 서버 성공으로 대체하지 않는다.

수정이 필요하면 배포 전용 브랜치에서 작업하고 diff를 남긴다. 별도 지시 없이 main 병합, force push, 외부 공개를 하지 않는다.
막히면 오류를 숨기거나 범위를 무한히 넓히지 말고, 완료 범위와 가장 작은 해결책을 보고한다.

---

배치 참고: Proxmox 공식 FAQ/컨테이너 안내의 Docker와 QEMU VM 설명.
https://github.com/proxmox/pve-docs/blob/master/pve-faq.adoc
https://pve.proxmox.com/wiki/Linux_Container
