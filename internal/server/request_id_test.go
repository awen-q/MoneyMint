package server

// request_id 与异常请求日志契约测试：
//   - 生成 16 位 hex / 合法客户端值沿用 / 非法值重生
//   - 响应头写出且 CORS expose 含该头
//   - 仅 >=400 的非 health 请求记 WARN，path 不含 query string
//   - 与真实路由装配后的端到端响应头

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"familyledger/internal/auth"
	"familyledger/internal/handler"
)

var requestIDHex = regexp.MustCompile(`^[0-9a-f]{16}$`)

// captureRequestIDSlog 临时替换 slog 默认 logger，测试结束还原。
// server 包无 t.Parallel，全局替换安全。
func captureRequestIDSlog(t *testing.T) *bytes.Buffer {
	t.Helper()
	prev := slog.Default()
	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return buf
}

// requestIDChain 构造与生产一致的 cors → request_id 中间件 → 业务 handler 链。
func requestIDChain(next http.Handler) http.Handler {
	return cors(corsOptions{origins: []string{"https://example.com"}}, requestContextMiddleware(next))
}

// TestRequestIDGenerated16Hex 验证自动生成 16 位 hex，且与注入 context 的值一致。
func TestRequestIDGenerated16Hex(t *testing.T) {
	var inHandler string
	h := requestIDChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inHandler = auth.RequestID(r.Context())
		if got := w.Header().Get(requestIDHeader); got != inHandler {
			t.Errorf("响应头 %s=%q 与 context 中 %q 不一致", requestIDHeader, got, inHandler)
		}
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))

	id := rec.Header().Get(requestIDHeader)
	if !requestIDHex.MatchString(id) {
		t.Fatalf("request_id=%q，期望 16 位小写 hex", id)
	}
	if inHandler != id {
		t.Fatalf("handler 读到 %q，响应头为 %q", inHandler, id)
	}
}

// TestRequestIDClientValueReused 验证合法客户端 request_id 原样沿用（端到端串联）。
func TestRequestIDClientValueReused(t *testing.T) {
	const clientID = "trace_abc-123_XYZ"
	h := requestIDChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := auth.RequestID(r.Context()); got != clientID {
			t.Errorf("context request_id=%q，期望 %q", got, clientID)
		}
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set(requestIDHeader, clientID)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if got := rec.Header().Get(requestIDHeader); got != clientID {
		t.Fatalf("响应头 request_id=%q，期望沿用 %q", got, clientID)
	}
}

// TestRequestIDInvalidValueRegenerated 验证非法传入值被忽略并重生（长度/字符/空值）。
func TestRequestIDInvalidValueRegenerated(t *testing.T) {
	badValues := []string{
		"has space",
		"a/b",
		"dot.id",
		"中文",
		strings.Repeat("x", 65),
		"",
	}
	for _, bad := range badValues {
		t.Run(strconv.Quote(bad), func(t *testing.T) {
			h := requestIDChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
			if bad != "" {
				req.Header.Set(requestIDHeader, bad)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)

			got := rec.Header().Get(requestIDHeader)
			if !requestIDHex.MatchString(got) {
				t.Fatalf("非法输入 %q 后 request_id=%q，期望重新生成 16 位 hex", bad, got)
			}
		})
	}
}

// TestRequestIDCORSExpose 验证跨域前端能读到 X-Request-Id。
func TestRequestIDCORSExpose(t *testing.T) {
	h := requestIDChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	req.Header.Set("Origin", "https://example.com")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	expose := rec.Header().Get("Access-Control-Expose-Headers")
	if !strings.Contains(expose, requestIDHeader) {
		t.Fatalf("Access-Control-Expose-Headers=%q，应包含 %s", expose, requestIDHeader)
	}
	// 原有导出提示头不能被覆盖丢失。
	for _, want := range []string{"X-Ledger-Balanced", "X-Ledger-Diffs", "Content-Disposition"} {
		if !strings.Contains(expose, want) {
			t.Fatalf("Access-Control-Expose-Headers=%q，丢失原有 %s", expose, want)
		}
	}
}

// TestFailedRequestLogsContext 验证异常请求 WARN 的关键字段，且 query string 不落日志。
func TestFailedRequestLogsContext(t *testing.T) {
	buf := captureRequestIDSlog(t)
	h := requestIDChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		noteRequestUser(r, 42)
		w.WriteHeader(http.StatusInternalServerError)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/boom?token=SUPERSECRET&amount=999", nil)
	req.Header.Set(requestIDHeader, "rid-fail-1")
	h.ServeHTTP(httptest.NewRecorder(), req)

	line := buf.String()
	for _, want := range []string{
		"level=WARN",
		"msg=http.request.failed",
		"event=http.request.failed",
		"request_id=rid-fail-1",
		"method=POST",
		"path=/api/boom",
		"status=500",
		"duration_ms=",
		"user_id=42",
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("日志缺少 %q，实际:\n%s", want, line)
		}
	}
	for _, leak := range []string{"SUPERSECRET", "token=", "amount=", "?"} {
		if strings.Contains(line, leak) {
			t.Fatalf("日志泄漏 query 内容 %q，实际:\n%s", leak, line)
		}
	}
}

// TestHealthFailureNotLogged 验证 /api/health 即使是异常状态也不记日志（HEALTHCHECK 噪声）。
func TestHealthFailureNotLogged(t *testing.T) {
	buf := captureRequestIDSlog(t)
	h := requestIDChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/health?token=SUPERSECRET", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)

	if strings.Contains(buf.String(), "http.request.failed") {
		t.Fatalf("health 请求不应记异常日志，实际:\n%s", buf.String())
	}
}

// TestSuccessRequestsNotLogged 验证 2xx / 3xx 一律不记异常日志。
func TestSuccessRequestsNotLogged(t *testing.T) {
	for _, code := range []int{http.StatusOK, http.StatusCreated, http.StatusFound} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			buf := captureRequestIDSlog(t)
			h := requestIDChain(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(code)
			}))
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/api/accounts", nil))
			if strings.Contains(buf.String(), "http.request.failed") {
				t.Fatalf("status=%d 不应记异常日志，实际:\n%s", code, buf.String())
			}
		})
	}
}

// TestRequestIDEndToEnd 验证完整路由装配后响应头确实带 request_id。
func TestRequestIDEndToEnd(t *testing.T) {
	e := newAuthEnv(t, handler.DefaultAuthOptions(), corsOptions{})
	resp, _ := e.do(&http.Client{}, http.MethodGet, "/api/health", nil, nil)
	id := resp.Header.Get(requestIDHeader)
	if !requestIDHex.MatchString(id) {
		t.Fatalf("端到端 request_id=%q，期望 16 位小写 hex", id)
	}
}
