# 006. web은 Vite 프록시 없이 목 서버에 직접(CORS) 연결한다

## 상황

web(5173)과 목 서버(8787)는 포트가 다르다. 개발 중에 같은 출처로 보이게 하는 일반적인 방법은 Vite `server.proxy`다.

## 검토한 대안

1. Vite 프록시 — CORS 설정이 필요 없다. 대신 목 서버의 장애 주입(TCP 끊기, 정확한 close 시점)이 프록시를 한 번 거치면서 바뀔 수 있다. 예: 업스트림 소켓이 끊겼을 때 프록시가 클라이언트 응답을 어떻게 끝내는지는 프록시 구현에 달려 있다.
2. **목 서버에 CORS를 열고 직접 연결**

## 결정

2번. 목 서버는 `hono/cors`로 `origin: *`, `Authorization`, `Content-Type` 헤더를 허용한다. web은 `VITE_API_URL`(기본 `http://localhost:8787`)로 연결한다.

## 트레이드오프

- `POST /turns`는 `Authorization` 헤더 때문에 preflight(OPTIONS) 요청이 한 번 더 나간다.
- 운영 환경의 프록시·CDN 버퍼링 문제는 이 구성으로 재현되지 않는다. M4의 `proxy-buffering` 시나리오는 목 서버가 직접 흉내 낸다.
