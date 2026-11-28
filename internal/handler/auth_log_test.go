package handler

// 认证事件日志契约测试：
//   - 登录成功 / 失败、改密成功 / 失败、登出、注册留下可 grep 的日志
//   - 字段含 request_id / user_id / reason（稳定码）
//   - 日志绝不出现密码原文、token、cookie / session id

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"familyledger/internal/auth"
	"familyledger/internal/db"
	"familyledger/internal/repository"
	"familyledger/internal/service"
)

type authLogEnv struct {
	h     *Handler
	uid   int64
	token string
}

// newAuthLogEnv 用真实 SQLite 装配 handler，并预置一个可登录用户。
func newAuthLogEnv(t *testing.T) *authLogEnv {
	t.Helper()
	conn, err := db.Open(
		filepath.Join(t.TempDir(), "auth-log.db"),
		filepath.Join("..", "..", "schema.sql"),
	)
	if err != nil {
		t.Fatalf("打开测试库: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	svc := service.New(repository.New(conn))
	res, err := svc.Register("loguser", "secret123", "Log User")
	if err != nil {
		t.Fatalf("预置用户: %v", err)
	}
	return &authLogEnv{h: New(svc, nil), uid: res.User.ID, token: res.Token}
}

// newAuthLogReq 构造带 request_id（可选 user_id）的认证请求。
func newAuthLogReq(t *testing.T, method, path, rid string, body any, uid int64, withUser bool) *http.Request {
	t.Helper()
	var rd io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("编组请求体: %v", err)
		}
		rd = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, rd)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	ctx := auth.WithRequestID(req.Context(), rid)
	if withUser {
		ctx = auth.WithUser(ctx, uid)
	}
	return req.WithContext(ctx)
}

func assertAuthLog(t *testing.T, line string, fields ...string) {
	t.Helper()
	for _, want := range fields {
		if !strings.Contains(line, want) {
			t.Fatalf("日志缺少 %q，实际:\n%s", want, line)
		}
	}
}

func assertNoLeak(t *testing.T, line string, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		if strings.Contains(line, secret) {
			t.Fatalf("日志泄漏敏感值 %q，实际:\n%s", secret, line)
		}
	}
}

// TestAuthLoginSuccessLog 验证登录成功日志带 request_id / user_id，且不含密码与 token。
func TestAuthLoginSuccessLog(t *testing.T) {
	env := newAuthLogEnv(t)
	buf := captureSlogForHandler(t)

	rec := httptest.NewRecorder()
	env.h.HandleLogin(rec, newAuthLogReq(t, http.MethodPost, "/api/auth/login", "rid-login-ok",
		map[string]any{"username": "loguser", "password": "secret123"}, 0, false))

	if rec.Code != http.StatusOK {
		t.Fatalf("登录状态 = %d，期望 200: %s", rec.Code, rec.Body.String())
	}
	assertAuthLog(t, buf.String(),
		"msg=auth.login.success", "event=auth.login.success",
		"request_id=rid-login-ok", "user_id="+strconv.FormatInt(env.uid, 10))
	assertNoLeak(t, buf.String(), "secret123", env.token)
}

// TestAuthLoginFailedLog 验证登录失败日志带稳定原因码、user_id=0，且不含任何密码原文。
func TestAuthLoginFailedLog(t *testing.T) {
	env := newAuthLogEnv(t)
	buf := captureSlogForHandler(t)

	rec := httptest.NewRecorder()
	env.h.HandleLogin(rec, newAuthLogReq(t, http.MethodPost, "/api/auth/login", "rid-login-fail",
		map[string]any{"username": "loguser", "password": "wrongpass"}, 0, false))

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("登录状态 = %d，期望 401: %s", rec.Code, rec.Body.String())
	}
	assertAuthLog(t, buf.String(),
		"level=WARN", "msg=auth.login.failed", "event=auth.login.failed",
		"request_id=rid-login-fail", "reason=invalid_credentials", "user_id=0")
	assertNoLeak(t, buf.String(), "secret123", "wrongpass", env.token)
}

// TestAuthPasswordChangedLog 验证改密成功日志带 user_id，且新旧密码都不出现。
func TestAuthPasswordChangedLog(t *testing.T) {
	env := newAuthLogEnv(t)
	buf := captureSlogForHandler(t)

	rec := httptest.NewRecorder()
	req := newAuthLogReq(t, http.MethodPost, "/api/auth/change-password", "rid-pwd-ok",
		map[string]any{"old_password": "secret123", "new_password": "newsecret123"}, env.uid, true)
	env.h.HandleChangePassword(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("改密状态 = %d，期望 200: %s", rec.Code, rec.Body.String())
	}
	assertAuthLog(t, buf.String(),
		"msg=auth.password_changed", "event=auth.password_changed",
		"request_id=rid-pwd-ok", "user_id="+strconv.FormatInt(env.uid, 10))
	assertNoLeak(t, buf.String(), "secret123", "newsecret123", env.token)
}

// TestAuthPasswordChangeFailedLog 验证旧密码错误被映射为稳定原因码且不记录明文。
func TestAuthPasswordChangeFailedLog(t *testing.T) {
	env := newAuthLogEnv(t)
	buf := captureSlogForHandler(t)

	rec := httptest.NewRecorder()
	req := newAuthLogReq(t, http.MethodPost, "/api/auth/change-password", "rid-pwd-fail",
		map[string]any{"old_password": "definitelywrong", "new_password": "newsecret123"}, env.uid, true)
	env.h.HandleChangePassword(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("改密状态 = %d，期望 400: %s", rec.Code, rec.Body.String())
	}
	assertAuthLog(t, buf.String(),
		"level=WARN", "msg=auth.password_change_failed", "event=auth.password_change_failed",
		"request_id=rid-pwd-fail", "reason=old_password_mismatch",
		"user_id="+strconv.FormatInt(env.uid, 10))
	assertNoLeak(t, buf.String(), "definitelywrong", "newsecret123", env.token)
}

// TestAuthLogoutLog 验证登出日志带 user_id 与 request_id，且不含会话 token。
func TestAuthLogoutLog(t *testing.T) {
	env := newAuthLogEnv(t)
	buf := captureSlogForHandler(t)

	req := newAuthLogReq(t, http.MethodPost, "/api/auth/logout", "rid-logout", nil, env.uid, true)
	req.Header.Set("Authorization", "Bearer "+env.token)
	rec := httptest.NewRecorder()
	env.h.HandleLogout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("登出状态 = %d，期望 200: %s", rec.Code, rec.Body.String())
	}
	assertAuthLog(t, buf.String(),
		"msg=auth.logout", "event=auth.logout", "request_id=rid-logout",
		"user_id="+strconv.FormatInt(env.uid, 10))
	assertNoLeak(t, buf.String(), env.token, "Bearer")
}

// TestAuthRegisterLog 验证注册成功日志带非零 user_id，且不含密码原文。
func TestAuthRegisterLog(t *testing.T) {
	env := newAuthLogEnv(t)
	buf := captureSlogForHandler(t)

	rec := httptest.NewRecorder()
	env.h.HandleRegister(rec, newAuthLogReq(t, http.MethodPost, "/api/auth/register", "rid-register",
		map[string]any{
			"username": "loguser2", "password": "registersecret", "display_name": "Second",
		}, 0, false))

	if rec.Code != http.StatusCreated {
		t.Fatalf("注册状态 = %d，期望 201: %s", rec.Code, rec.Body.String())
	}
	assertAuthLog(t, buf.String(),
		"msg=auth.register", "event=auth.register", "request_id=rid-register")
	if strings.Contains(buf.String(), "user_id=0") {
		t.Fatalf("注册日志 user_id 应为非零:\n%s", buf.String())
	}
	assertNoLeak(t, buf.String(), "registersecret")
}

// TestAuthLogWithoutRequestID 验证未经过 request_id 中间件时仍能记事件（该字段可选）。
func TestAuthLogWithoutRequestID(t *testing.T) {
	env := newAuthLogEnv(t)
	buf := captureSlogForHandler(t)

	req := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	req = req.WithContext(auth.WithUser(req.Context(), env.uid))
	rec := httptest.NewRecorder()
	env.h.HandleLogout(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("登出状态 = %d，期望 200", rec.Code)
	}
	assertAuthLog(t, buf.String(), "event=auth.logout", "user_id="+strconv.FormatInt(env.uid, 10))
	if strings.Contains(buf.String(), "request_id=") {
		t.Fatalf("无 request_id 时不应输出该字段:\n%s", buf.String())
	}
}
