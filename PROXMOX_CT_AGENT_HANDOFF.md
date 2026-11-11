# SOMA 웹 버전 — 비특권 CT 직접 설치 에이전트 전달 가이드

작성 기준: 2026-11-10. 이 문서는 **Proxmox → 비특권 x86_64 Linux CT → Node/Python 직접 실행** 경로다. Docker/Compose 경로는 `PROXMOX_AGENT_HANDOFF.md`에 유지한다.
이 가이드는 대상 CT에서 아직 실행 검증하지 않았다. 설치 명령은 대상 OS와 경로를 확인한 후 적용하고, Mac 검증을 CT 성공으로 보고하지 않는다.

## 설치 스크립트로 시작하기

저장소의 `scripts/ct.sh`가 아래 수동 절차를 자동화한다. 자동 설치 지원 범위는 **Ubuntu 24.04 / x86_64 / 비특권 LXC**이며 다른 OS는 변경 전에 거부한다. CT 내부 UID 매핑도 확인하지만 Proxmox 호스트의 `pct config` 확인을 대체하지 않는다.

1. CT root 셸에서 이 저장소를 준비하고 관리자 패키지·계정 준비를 실행한다. 이미 checkout이 있으면 그 경로를 사용한다. Git이 없다면 CT 안에서 `apt-get update`와 `apt-get install -y git`으로 먼저 설치한다.

```sh
# CT root. 비어 있는 임시 경로를 사용한다.
git clone --branch feat/local-web-ui https://github.com/SukbeomH/SOMA.git /tmp/SOMA-setup
bash /tmp/SOMA-setup/scripts/ct.sh prepare
```

2. `su - soma`로 전용 사용자 로그인 셸에 들어간 뒤:

```sh
git clone --branch feat/local-web-ui https://github.com/SukbeomH/SOMA.git /home/soma/SOMA
cd /home/soma/SOMA
bash scripts/ct.sh install
# FEM도 설치하려면 위 명령 대신: bash scripts/ct.sh install --fem
bash scripts/ct.sh login
bash scripts/ct.sh run
```

기존 checkout이면 다시 clone하지 않고 현재 SHA와 변경 상태를 확인한다. 새 포트 지정은 `SOMA_CT_PORT=8876 bash scripts/ct.sh install`로 한다. 포트는 저장되며 재설치 시 명시적으로 바꾸지 않으면 유지된다.

- `run`: 전경 실행, Ctrl+C 종료. 별도 soma 셸에서 `bash scripts/ct.sh stop`도 가능.
- `status`: HTTP와 실제 루프백 리스닝 검사. 브라우저 검증을 대체하지 않는다.
- `check`: 타입·웹 격리·headless CAD/PTY 자동 검사. Codex는 테스트 대역이므로 실제 로그인/추론은 별도 확인.
- `install --fem`: 제약 버전의 gmsh/pyamg 설치와 초기화 검사. 실제 study 실행은 별도 확인.
- 설치 실패 시 성공 표시를 지워 이전 성공으로 오인하지 않게 한다. 오류 해결 후 install을 다시 실행한다. 강제 종료로 `.ct-runtime/install.lock`이 남으면 실행 중인 설치가 없는지 확인한 후 그 빈 디렉터리만 제거한다.

Node **24.22.2** 공식 linux-x64 배포본과 고정 SHA-256을 사용한다. 스크립트는 Node를 `~/.local/share/soma-node/`, Codex **0.167.0**을 `~/.local/share/soma-codex/`에 설치하므로 아래 수동 `/opt/soma-node` 예시와 경로가 다르다. Python은 checkout의 `.venv`, 데이터는 `~/data`, 인증은 기본 `~/.codex`를 사용한다. 셸 설정·전역 Python·기존 인증을 변경하지 않는다. 소스 업데이트, 로그인, 서버 시작, 부팅 자동 시작은 설치가 자동 수행하지 않는다.

`install`은 checkout의 `.venv`와 `app/node_modules`를 갱신한다. 서비스가 정지된 전용 checkout에서 실행하며, 업데이트 전 백업은 아래 운영 절차를 따른다. 설치 기록은 Git에서 제외된 `.ct-runtime/`의 버전 목록과 완료 시각에 남는다. 인증정보와 환경 전체를 기록하지 않는다.

선택적으로 systemd를 쓰려면 soma 사용자로 unit을 생성한다:

```sh
bash scripts/ct.sh unit > /home/soma/soma-web.service
```

전경 서버를 종료하고 CT root가 파일을 검토한 뒤, **기존 unit이 없는 경우에만** 아래를 실행한다. 기존 unit이 있으면 덮어쓰지 말고 diff를 검토한다.

```sh
if test ! -e /etc/systemd/system/soma-web.service; then
  install -m 644 /home/soma/soma-web.service /etc/systemd/system/soma-web.service &&
    systemd-analyze verify /etc/systemd/system/soma-web.service &&
    systemctl daemon-reload && systemctl start soma-web
else
  echo "Existing unit: review the diff before changing it."
fi
# 종료: systemctl stop soma-web
# 재시작: systemctl restart soma-web
```

systemd 방식은 `stop:web`/스크립트 `stop` 대신 `systemctl stop`으로 종료한다. `enable`은 자동 실행하지 않는다. 포트를 바꿔 재설치한 경우 unit도 다시 생성해 차이를 검토하고 반영해야 한다.

원격 머지 이후 스크립트에는 선택적 직접 접속 옵션도 있다. 기본값은 여전히 루프백이며 아래 옵션은 해당 접근을 승인한 경우에만 지정한다:

```sh
# CT LAN 주소 직접 접속 (별도 로그인 없음)
SOMA_CT_LAN_HOST=192.168.1.20 bash scripts/ct.sh install --fem
# Tailscale HTTPS 프록시의 정확한 이름 허용 (tailscale serve 설정 자체는 자동 수행하지 않음)
SOMA_CT_TAILSCALE_HOST=soma.example.ts.net bash scripts/ct.sh install --fem
# 저장된 직접 접속 설정 해제
SOMA_CT_LAN_HOST= SOMA_CT_TAILSCALE_HOST= bash scripts/ct.sh install --fem
```

옵션은 재설치 시 유지되므로 LAN에서 Tailscale 전용으로 전환할 때는 `SOMA_CT_LAN_HOST=`도 명시한다. LAN 옵션은 `0.0.0.0` 리스닝과 지정 Host/Origin 허용을 활성화한다. 접근 가능한 사용자는 터미널과 Codex 계정을 사용할 수 있으며 Host/Origin 검사는 로그인 인증이 아니다. Tailscale 이름만 지정하면 기본 루프백 바인딩을 유지한다. `status`는 프록시까지 검증하지 않으므로 실제 HTTPS URL 접속도 별도로 확인한다. systemd 설정은 옵션 변경 후 재생성·검토·반영한다.

일반 LAN HTTP에서는 브라우저 Clipboard API가 없을 수 있다. Ctrl+V/브라우저 Paste는 기본 붙여넣기 이벤트를 이용하지만 ＋Image 버튼의 클립보드 읽기는 HTTPS/localhost가 필요하다. 복사 실패 시 안내 또는 수동 복사 표시를 사용한다.

Mac 접속은 아래 6절 SSH 로컬 포워딩을 따른다. 설치 후에도 7절의 실제 Codex·브라우저·FEM 시험을 완료해야 한다.

개발용 스크립트 검사는 Linux 일반 사용자로 `python3 scripts/test-ct.py`를 실행한다. OS/외부 명령을 대역으로 치환한 테스트이며 CT 실설치 검증이 아니다.

---

아래 내용을 대상 에이전트에게 전달한다.

---

포크한 SOMA 웹 버전을 비특권 Proxmox CT에 Docker 없이 설치하고 실제 Codex CAD 수정까지 검증해 줘. 계획만 작성하지 말고 승인된 범위의 구축·시험·운영 문서 작성을 진행해 줘.

## 1. 소스와 작업 범위

- 저장소: https://github.com/SukbeomH/SOMA.git
- 브랜치: `feat/local-web-ui`
- 기능 기준 커밋: `f56f444def1f98ead40e6a1168c839b0be5290d5`. 이 가이드가 포함된 브랜치를 가져오고 기준 이후 차이와 실제 사용 SHA를 기록한다. 의존성을 일괄 최신화하지 않는다.
- CadQuery와 기존 UI를 유지한다. 왼쪽 뷰어, 오른쪽 Codex 터미널, 형상 선택·강조·수정·뷰어 갱신이 목표다.
- Docker, Electron 런타임, Xvfb/X11 서버, 서버 Chromium을 설치하지 않는다. 기존 데스크톱 UI 코드를 삭제하지 않는다.
- Proxmox 호스트에는 Node/Python/CAD 패키지를 설치하지 않는다. CT 안의 전용 일반 사용자 `soma`로 앱과 Codex를 실행한다.
- 기존 CT의 적합성을 먼저 확인한다. CT 생성이나 호스트 변경이 필요하면 CT ID·스토리지·네트워크·자원과 영향을 제시한다. 기존 데이터와 서비스를 덮어쓰지 않는다.

## 2. 환경과 CT 제한 확인

현재 실행 위치, Proxmox 버전(접근 가능할 때), CT ID, 배포판/버전, 커널, `uname -m`, CPU/RAM/디스크, DNS/외부 다운로드, Git/SSH/systemd, 사용 중인 포트를 기록한다.
Proxmox 측 `pct config <CTID>`에서 `unprivileged: 1`, features, AppArmor/seccomp 관련 설정과 마운트를 확인한다. CT 내부 정보만으로 호스트 정책을 확인했다고 주장하지 않는다.

기본은 배포판 시스템 CT다. Python 3.12를 제공하는 Ubuntu 24.04 같은 glibc 기반 x64 환경을 후보로 삼되, 실제 사용 가능한 템플릿과 지원 상태를 확인한다. 초기 자원 예산은 4 vCPU / RAM 8 GiB / 디스크 40 GiB이며 보장된 최소 사양이 아니다. FEM과 빌드 규모에 따라 조정한다.

- Docker nesting을 위한 설정은 추가하지 않는다. 기존 설정이 있다면 기록하고, 다른 서비스에 영향을 줄 수 있으므로 임의로 제거하지 않는다.
- privileged 전환, AppArmor unconfined, seccomp 해제, 장치 전체 허용, 호스트 디렉터리 광범위 마운트로 우회하지 않는다.
- `/dev/ptmx`, devpts 및 일반 사용자 PTY 실행을 실제 시험한다.
- Codex sandbox의 namespace/시스템 호출 요구가 CT 정책과 충돌할 수 있다. 버전 출력·로그인만으로 검증하지 말고 실제 파일 읽기/수정 및 명령 실행을 시험한다.
- sandbox 비활성화나 무제한 실행 옵션으로 통과시키지 않는다. 차단 시 정확한 오류와 필요한 권한을 보고하고 VM+Compose 대안을 제시한다.

CT는 호스트 커널을 공유하므로 VM과 동일한 격리 경계가 아니다. 전용 CT에서 운영하고 무관한 비밀이나 호스트 관리 권한을 넣지 않는다.

## 3. 런타임 설치와 빌드

먼저 `Dockerfile`, `app/package.json`, `app/package-lock.json`, `app/scripts/start-web.mjs`, `app/src/main/web.ts`, `python/requirements-web.txt`, `python/requirements-base.txt`, `WEB_LOCAL.md`를 읽는다.
기준 런타임은 Node 24 / Python 3.12 / Codex CLI 0.167.0이다. 정확한 설치 버전·배포 출처·아키텍처를 기록한다.

CT 관리자 권한은 게스트 패키지와 계정/서비스 준비에만 사용한다. 실제 설치 범위를 먼저 설명하고 이미 승인된 범위에서 진행한다. Debian/Ubuntu 계열 패키지 후보는 다음과 같으며 대상 배포판에서 이름과 필요성을 확인한다:

```sh
# CT 안에서만 실행. Python 3.12 패키지가 제공되는 배포판 예시.
apt-get update
apt-get install -y --no-install-recommends git bash ca-certificates build-essential python3.12 python3.12-venv python3.12-dev libgl1 libglu1-mesa libgomp1 libxrender1 libxext6 procps curl xz-utils
```

OpenGL 공유 라이브러리는 CAD/Gmsh import용이며 가상 디스플레이 설치를 뜻하지 않는다.
Node 24는 공식 linux-x64 배포본과 체크섬을 검증해 전용 경로 `/opt/soma-node`에 설치하거나, 조직에서 승인한 패키지 공급원을 사용한다. 배포판 기본 Node가 24라고 가정하지 않는다. 원격 설치 스크립트를 검토 없이 파이프로 실행하지 않는다.
`/opt/soma-node/bin/node`, `npm`, Node 헤더를 사용할 수 있도록 준비한다. 기존 전역 Node/Python이나 셸 설정을 교체하지 않는다.

전용 사용자 홈은 `/home/soma`, checkout은 `/home/soma/SOMA`, 데이터는 `/home/soma/data`로 구성한다. 기존 경로가 있으면 소유권과 내용을 확인해 재사용 여부를 판단한다. 아래는 **soma 사용자로**, 새 checkout을 만드는 경우의 명령이다:

```sh
export PATH=/opt/soma-node/bin:/usr/local/bin:/usr/bin:/bin
umask 077
git clone --branch feat/local-web-ui https://github.com/SukbeomH/SOMA.git /home/soma/SOMA
cd /home/soma/SOMA
python3.12 -m venv .venv
.venv/bin/python -m pip install -r python/requirements-web.txt
.venv/bin/python -m pip install ./python
npm --prefix app ci --ignore-scripts
npm --prefix app rebuild node-pty
npm --prefix app run build:web
npm install --global --prefix /home/soma/.local --ignore-scripts @openai/codex@0.167.0
mkdir -p /home/soma/data /home/soma/.codex
chmod 700 /home/soma/data /home/soma/.codex
```

`--ignore-scripts`는 Electron/dugite 바이너리 다운로드를 생략한다. npm 메타데이터나 데스크톱 개발 의존성이 설치되는 것과 Electron 실행이 필요한 것은 구분한다. node-pty만 현재 **Node ABI**로 재빌드한다. 빌드 실패 시 Node 헤더/컴파일러/esbuild 선택 패키지를 확인하고 모든 lifecycle script를 무조건 켜지 않는다.
Codex의 플랫폼 패키지가 설치됐는지 `/home/soma/.local/bin/codex --version`으로 확인한다. 패키지 설치 성공만으로 x64 실행 성공을 판단하지 않는다.

## 4. 먼저 전경 실행과 검증

soma 사용자 셸에서 다음 환경을 사용한다. `SOMA_CONTAINER=0`을 명시한다. **CT도 컨테이너라는 이유로 1로 바꾸면 안 된다.** 현재 코드에서 1은 Docker 포트 전달용 `0.0.0.0` 바인딩을 의미한다.

```sh
cd /home/soma/SOMA
export PATH=/home/soma/.local/bin:/home/soma/SOMA/.venv/bin:/opt/soma-node/bin:/usr/local/bin:/usr/bin:/bin
export SOMA_CONTAINER=0 SOMA_USER_DATA=/home/soma/data
export SOMA_PYTHON=/home/soma/SOMA/.venv/bin/python SOMA_WEB_PORT=8765
export SHELL=/bin/bash
unset DISPLAY WAYLAND_DISPLAY
npm --prefix app run typecheck
npm --prefix app run test:web
npm --prefix app run test:headless
npm --prefix app run start:web
```

`test:headless`는 별도 임시 데이터와 18766 포트를 사용하며 **Codex 실행 파일은 테스트 대역**이다. 이것만으로 실제 Codex 인증·추론·sandbox 검증을 완료했다고 보고하지 않는다. 시작 전 포트 충돌을 확인한다.
다른 CT 셸에서 `ss -ltnp`와 `curl --fail http://127.0.0.1:8765/`로 실제 리스닝과 HTTP를 확인한다. `0.0.0.0` 또는 `[::]` 공개 리스닝이면 원인을 수정한다.
전경 실행은 Ctrl+C로 종료한다. wrapper 실행의 별도 종료 명령은 동일한 `SOMA_USER_DATA` 환경에서 `npm --prefix app run stop:web`이다.

## 5. systemd 운영 예시

전경 검증 후 게스트 systemd 사용이 가능한 경우 `/etc/systemd/system/soma-web.service`를 아래처럼 준비한다. 경로와 Git 위치를 먼저 확인하고 환경에 맞춘다. 서비스 등록·수동 시작과 부팅 자동 시작은 구분하며, `enable`은 별도 운영 요청이 있을 때만 한다.

```ini
[Unit]
Description=SOMA local web service
After=network.target

[Service]
Type=simple
User=soma
Group=soma
WorkingDirectory=/home/soma/SOMA/app
Environment=HOME=/home/soma
Environment=PATH=/home/soma/.local/bin:/home/soma/SOMA/.venv/bin:/opt/soma-node/bin:/usr/local/bin:/usr/bin:/bin
Environment=SOMA_WEB=1
Environment=SOMA_CONTAINER=0
Environment=SOMA_USER_DATA=/home/soma/data
Environment=SOMA_PYTHON=/home/soma/SOMA/.venv/bin/python
Environment=SOMA_WEB_PORT=8765
Environment=SHELL=/bin/bash
Environment=LOCAL_GIT_DIRECTORY=/usr
Environment=GIT_EXEC_PATH=/usr/lib/git-core
Environment=PYTHONDONTWRITEBYTECODE=1
UnsetEnvironment=DISPLAY WAYLAND_DISPLAY
ExecStart=/opt/soma-node/bin/node /home/soma/SOMA/app/dist/web/server.js
UMask=0077
Restart=no
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

`git --exec-path`가 `/usr/lib/git-core`인지 확인한다. systemd는 빌드된 서버를 직접 실행하므로 wrapper의 PID 파일이나 `stop:web`을 쓰지 않는다. 전경 서버를 먼저 종료한 후 CT 관리자 셸에서:

```sh
systemd-analyze verify /etc/systemd/system/soma-web.service
systemctl daemon-reload
systemctl start soma-web
systemctl status soma-web --no-pager
# 종료 / 재시작
systemctl stop soma-web
systemctl start soma-web
# 필요 시 재시작
systemctl restart soma-web
```

로그 확인은 `journalctl -u soma-web`로 하되 인증값·사용자 프롬프트/세션 원문을 보고서에 복사하지 않는다. systemd에서 PTY와 Codex를 다시 시험한다. 추가 systemd 격리 옵션은 Codex sandbox와 충돌할 수 있으므로 효과를 검증한 뒤 적용한다. 서비스 제한을 풀어서 CT 호스트 정책을 우회하지 않는다.

## 6. 접속과 인증

앱은 CT 내부 `127.0.0.1:8765`로만 제공한다. 사용자 브라우저 접속은 승인된 일회성 SSH 로컬 포워딩을 사용한다. SSH 접근 계정은 관리자가 정한 일반 계정이며 반드시 soma 계정일 필요는 없다. SSH 서버가 없다면 설치·접근 정책을 먼저 설명한다.

```sh
# 사용자 Mac. 실제 CT SSH 계정/IP로 교체.
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:8765:127.0.0.1:8765 <CT_SSH_USER>@<CT_IP>
```

브라우저 URL은 `http://127.0.0.1:8765/`. 기존 Mac 서비스와 충돌하면 CT 환경, 서비스 설정, SSH 양쪽 포트, URL을 모두 8876으로 맞춘다. Mac 서버를 임의로 종료하지 않는다.
Host/Origin 검사·쿠키·단일 활성 클라이언트 정책을 유지한다. CT IP 직접 접속, LAN/인터넷 공개, 프록시, 방화벽 변경, 상시 터널은 별도 범위다.

Codex 로그인은 서비스와 같은 soma 사용자/홈/PATH에서 사용자가 `codex login --device-auth`로 완료한다. 기존 Mac 인증을 복사하거나 전역 인증 설정을 바꾸지 않는다. 로그인 코드·토큰·API 키·인증/세션 파일 내용을 Git이나 보고서에 남기지 않는다.

## 7. 기능 및 FEM 검증

`PROXMOX_AGENT_HANDOFF.md`의 **5. 브라우저/파일/렌더링 검증** 전체와 **6. x64 FEM 추가와 검증**의 모델·수치 기준을 재사용한다. Docker 빌드/볼륨/exec 명령은 이 문서의 venv/서비스/디렉터리 방식으로 대체한다.
`WEB_LOCAL.md`의 과거 desktop-only PNG/video 제한 문구보다 실제 코드와 최신 구현 설명을 확인한다.

추가 필수 확인:
- 실제 웹 터미널 Codex로 모델 수정 → CAD 재생성 → 선택/강조 → 추가 수정 → 뷰어 갱신. 일반 사용자 권한과 실제 sandbox 실행 여부 기록.
- 브라우저 재연결 및 서비스 재시작 후 같은 모델 경로에서 `codex resume --last --no-alt-screen`으로 대화 복원. 이는 PTY나 모든 탭 복원이 아니다.
- PNG 붙여넣기/＋Image → inputs 파일 → `[Image #1]` → 실제 이미지 인식. 서버 클립보드는 필요 없다.
- 업로드/다운로드, PNG, MP4/contact sheet/VTT, 재생, 렌더 취소/브라우저 연결 끊김, CAD 실패 시 이전 결과 오인 방지.
- 렌더링은 연결된 클라이언트 브라우저에서 수행한다. 서버에 디스플레이/GPU가 없어도 되는 설계지만 실제 브라우저 WebGL/인코더 동작을 확인한다.

FEM은 기본 requirements-web에서 빠져 있다. 선택 설치로 아래를 soma 사용자 venv에 적용하고, 성공 시 선택 requirements 파일이나 설치 스크립트에 정확히 기록한다:

```sh
cd /home/soma/SOMA
.venv/bin/python -m pip install -c python/requirements-base.txt gmsh pyamg
.venv/bin/python -c 'import cadquery, gmsh, pyamg; gmsh.initialize(); gmsh.finalize()'
```

현재 제약은 gmsh 4.15.2 / pyamg 5.3.0이다. wheel/import 성공뿐 아니라 DISPLAY 없는 실제 study.py 해석과 Analysis PNG까지 확인한다. 기본 내장 선형탄성 솔버로 시작하며 CalculiX는 자동 지원으로 보고하지 않는다.
브라우저를 직접 조작할 수 없으면 사용자 확인 절차를 제공하고 해당 항목은 미검증으로 남긴다.

## 8. 영속성·업데이트·완료 보고

- 데이터: `/home/soma/data`, 폴더 모드로 별도 연 모델 경로, 사용자가 저장한 내보내기 경로를 모두 조사한다. 데이터 디렉터리만 백업하면 외부 프로젝트가 빠질 수 있다.
- 인증/대화: `/home/soma/.codex`는 민감 데이터다. 일반 결과물에 포함하지 않고 보호된 백업 또는 재로그인 방침을 정한다.
- 서비스 정지 후 데이터·별도 모델을 백업하고 별도 경로에 복원 시험한다. 원래 프로젝트 경로를 유지해야 resume 검색이 이어지는지 확인한다.
- Proxmox 백업에 포함되는 디스크와 제외되는 bind mount를 조사한다. 사용자 소유권/비특권 UID 매핑도 확인한다.
- 업데이트 전 현재 SHA·패키지 목록·lockfile·서비스 파일·Node/Python/Codex 버전을 기록한다. 소스 변경은 배포 전용 브랜치에서 수행하고 dirty 상태를 보존한다.
- 업데이트는 서비스 정지 → 소스/환경 백업 → 명시한 SHA 적용 → venv 및 npm lock 기반 설치 → Node PTY 재빌드 → 웹 빌드/검증 → 시작 순서다. Python/npm 환경도 소스와 함께 복원 가능한 롤백 절차를 작성한다. 무조건 git reset/clean이나 데이터 삭제를 하지 않는다.
- 완료 보고: CT/OS/아키텍처/제한, 실제 경로·SHA·의존성 버전, 접속 URL·리스닝 증거, 시작/종료/업데이트/백업/복원 명령, CAD/Codex/resume/파일/붙여넣기/렌더/FEM의 PASS·FAIL·미검증과 근거.
- CT에서 막히면 오류를 숨기거나 보안 제한을 해제하지 말고 완료한 범위와 VM으로 옮겨야 하는 구체적 이유를 보고한다. 별도 지시 없이 main 병합·force push·외부 공개를 하지 않는다.

---

공식 참고: [Proxmox 컨테이너 문서](https://github.com/proxmox/pve-docs/blob/master/pct.adoc) — 커널 공유, 비특권 컨테이너와 리소스 제한 설명. 실제 설치된 Proxmox 버전의 문서/설정도 확인한다.
