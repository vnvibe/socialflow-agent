package main

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	wailsRuntime "github.com/wailsapp/wails/v2/pkg/runtime"
	"github.com/wailsapp/wails/v2/pkg/options"
)

// ─── Config ──────────────────────────────────────────────

var (
	supabaseURL  = os.Getenv("SUPABASE_URL")
	supabaseAnon = os.Getenv("SUPABASE_ANON_KEY")
	apiURL       = os.Getenv("API_URL")
)

func init() {
	if supabaseURL == "" {
		supabaseURL = "https://yflkinkfcvntxlmtbldw.supabase.co"
	}
	if supabaseAnon == "" {
		supabaseAnon = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlmbGtpbmtmY3ZudHhsbXRibGR3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI3ODYyNjYsImV4cCI6MjA4ODM2MjI2Nn0.n1SAQE8vjF7B9vtst0OYQoLAtiQlsxSTFqKNLX6HdGs"
	}
	if apiURL == "" {
		apiURL = "https://socialflow-production-d02c.up.railway.app"
	}
}

// ─── Agent Config (fetched from API after login) ────────

type AgentConfig struct {
	SupabaseURL    string `json:"supabase_url"`
	SupabaseAnon   string `json:"supabase_anon_key"`
	APIURL         string `json:"api_url"`
	AgentSecretKey string `json:"agent_secret_key"`
	UserID         string `json:"user_id"`
}

// Phase 10: cache file lives at ~/.socialflow/agent-config.json
func agentConfigCachePath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(home, ".socialflow")
	_ = os.MkdirAll(dir, 0700)
	return filepath.Join(dir, "agent-config.json")
}

type cachedAgentConfig struct {
	*AgentConfig
	CachedAt string `json:"cached_at"`
}

func saveCachedAgentConfig(cfg *AgentConfig) {
	if cfg == nil {
		return
	}
	p := agentConfigCachePath()
	if p == "" {
		return
	}
	data, err := json.MarshalIndent(cachedAgentConfig{
		AgentConfig: cfg,
		CachedAt:    time.Now().UTC().Format(time.RFC3339),
	}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(p, data, 0600)
}

func loadCachedAgentConfig() (*AgentConfig, string) {
	p := agentConfigCachePath()
	if p == "" {
		return nil, ""
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, ""
	}
	var cached cachedAgentConfig
	if err := json.Unmarshal(data, &cached); err != nil {
		return nil, ""
	}
	if cached.AgentConfig == nil || cached.SupabaseURL == "" {
		return nil, ""
	}
	return cached.AgentConfig, cached.CachedAt
}

// warmUpAPI — Phase 12: fire a longer-timeout ping to /health BEFORE the real
// config fetch, so Railway free-tier has a chance to cold-start (30-60s) before
// Phase 10 retry budget kicks in. Fire-and-forget — result is ignored; its only
// job is to wake the container.
func (a *App) warmUpAPI() {
	client := &http.Client{Timeout: 45 * time.Second}
	url := fmt.Sprintf("%s/health", apiURL)
	a.addLog("Đang đánh thức API (có thể mất 30-60s nếu server vừa ngủ)...", "info")
	resp, err := client.Get(url)
	if err == nil {
		resp.Body.Close()
		a.addLog("API đã sẵn sàng", "success")
	}
	// Errors are ignored — Phase 10 retry loop below will handle failures properly.
}

// fetchAgentConfig — Phase 10 + 12:
//   0. Warm-up ping to /health (45s timeout) — wakes a sleeping Railway dyno.
//   1. Try doFetchAgentConfig with exponential backoff (5s, 15s, 30s, 60s, 120s).
//   2. On 401 anywhere in the chain, re-login once and continue retries.
//   3. On total failure, fall back to ~/.socialflow/agent-config.json cache.
//   4. On success, persist to cache so next offline start has fresh config.
func (a *App) fetchAgentConfig() (*AgentConfig, error) {
	if a.user == nil {
		return nil, fmt.Errorf("not logged in")
	}

	// Phase 12: kick Railway awake before the real request.
	a.warmUpAPI()

	delays := []time.Duration{5 * time.Second, 15 * time.Second, 30 * time.Second, 60 * time.Second, 120 * time.Second}
	maxRetries := len(delays)
	var lastErr error
	reloggedIn := false

	for attempt := 0; attempt < maxRetries; attempt++ {
		cfg, err := a.doFetchAgentConfig()
		if err == nil {
			saveCachedAgentConfig(cfg)
			a.setOnline(true)
			if attempt > 0 {
				a.addLog(fmt.Sprintf("Lấy config thành công sau %d lần thử", attempt+1), "info")
			}
			return cfg, nil
		}
		lastErr = err

		// Token expired path: try re-login once, then keep retrying
		if !reloggedIn && strings.Contains(err.Error(), "401") {
			reloggedIn = true
			a.addLog("Token hết hạn, đang đăng nhập lại...", "warn")
			saved := a.loadCredentials()
			if saved != nil && saved["email"] != "" && saved["password"] != "" {
				result := a.Login(saved["email"], saved["password"])
				if result["error"] != nil {
					a.addLog(fmt.Sprintf("Re-login thất bại: %v", result["error"]), "warn")
				}
			}
			// Don't sleep on the re-login attempt — retry immediately
			continue
		}

		// Network error → wait and retry
		if attempt < maxRetries-1 {
			delay := delays[attempt]
			a.addLog(fmt.Sprintf("Lỗi kết nối, thử lại lần %d/%d sau %ds...", attempt+1, maxRetries, int(delay.Seconds())), "warn")
			time.Sleep(delay)
		}
	}

	// All retries exhausted → fall back to cached config
	a.setOnline(false)
	if cached, cachedAt := loadCachedAgentConfig(); cached != nil {
		a.addLog(fmt.Sprintf("Dùng config cached (%s) — sẽ tự kết nối lại sau", cachedAt), "warn")
		return cached, nil
	}
	a.addLog(fmt.Sprintf("Không lấy được config và không có cache: %v", lastErr), "error")
	return nil, lastErr
}

func (a *App) doFetchAgentConfig() (*AgentConfig, error) {
	url := fmt.Sprintf("%s/agent/config", apiURL)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", a.user.Token))

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("cannot reach API: %s", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("API error %d: %s", resp.StatusCode, string(body))
	}

	var cfg AgentConfig
	if err := json.NewDecoder(resp.Body).Decode(&cfg); err != nil {
		return nil, fmt.Errorf("invalid config response: %s", err)
	}
	return &cfg, nil
}

// ─── Types ───────────────────────────────────────────────

type LogEntry struct {
	Time string `json:"time"`
	Text string `json:"text"`
	Type string `json:"type"` // info, success, warn, error
}

type UserSession struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Token string `json:"access_token"`
}

// ─── App ─────────────────────────────────────────────────

type App struct {
	ctx     context.Context
	mu      sync.Mutex
	logs    []LogEntry
	user    *UserSession
	cmd     *exec.Cmd
	cancel  context.CancelFunc
	running bool
	// Phase 10: connectivity tracking
	online      bool
	onlineSince time.Time
}

const maxLogs = 500

func NewApp() *App {
	return &App{
		logs: make([]LogEntry, 0, maxLogs),
	}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	// Auto-login: try server-side directly instead of sending to frontend
	go func() {
		time.Sleep(1 * time.Second)
		saved := a.loadCredentials()
		if saved != nil && saved["email"] != "" && saved["password"] != "" {
			result := a.Login(saved["email"], saved["password"])
			if result["error"] == nil {
				// Login succeeded — notify frontend
				wailsRuntime.EventsEmit(a.ctx, "user", a.user)
			} else {
				// Failed — show login screen with pre-filled email
				wailsRuntime.EventsEmit(a.ctx, "auto-login-failed", saved["email"])
			}
		}
	}()

	// Start auto-updater (initial check after 60s, then every 30 min)
	a.startAutoUpdater()

	// Phase 10: connectivity watcher (every 5 min) — emits status to frontend.
	a.online = true
	a.onlineSince = time.Now()
	a.startConnectivityWatcher()
}

// ─── Credential Storage ─────────────────────────────────

func credentialsFile() string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".socialflow")
	os.MkdirAll(dir, 0700)
	return filepath.Join(dir, ".credentials")
}

func (a *App) saveCredentials(email, password string) {
	data, _ := json.Marshal(map[string]string{"email": email, "password": password})
	// Simple XOR obfuscation (not encryption, just avoid plaintext)
	key := byte(0x5F)
	for i := range data {
		data[i] ^= key
	}
	os.WriteFile(credentialsFile(), data, 0600)
}

func (a *App) loadCredentials() map[string]string {
	data, err := os.ReadFile(credentialsFile())
	if err != nil {
		return nil
	}
	key := byte(0x5F)
	for i := range data {
		data[i] ^= key
	}
	var creds map[string]string
	if json.Unmarshal(data, &creds) != nil {
		return nil
	}
	if creds["email"] == "" {
		return nil
	}
	return creds
}

func (a *App) clearCredentials() {
	os.Remove(credentialsFile())
}

func (a *App) beforeClose(ctx context.Context) bool {
	a.StopAgent()
	return false // allow close
}

func (a *App) shutdown(ctx context.Context) {
	a.StopAgent()
}

func (a *App) onSecondInstance(data options.SecondInstanceData) {
	wailsRuntime.WindowShow(a.ctx)
	wailsRuntime.WindowSetAlwaysOnTop(a.ctx, true)
	wailsRuntime.WindowSetAlwaysOnTop(a.ctx, false)
}

// ─── Log management ──────────────────────────────────────

func (a *App) addLog(text, logType string) {
	a.mu.Lock()
	entry := LogEntry{
		Time: time.Now().Format(time.RFC3339),
		Text: text,
		Type: logType,
	}
	a.logs = append(a.logs, entry)
	if len(a.logs) > maxLogs {
		a.logs = a.logs[1:]
	}
	a.mu.Unlock()

	wailsRuntime.EventsEmit(a.ctx, "log", entry)
}

func classifyLogType(line string) string {
	if strings.Contains(line, "[ERROR]") || strings.Contains(line, "Error") {
		return "error"
	}
	if strings.Contains(line, "[WARN]") {
		return "warn"
	}
	if strings.Contains(line, "[OK]") {
		return "success"
	}
	return "info"
}

// ─── IPC Methods (bound to frontend) ────────────────────

func (a *App) GetStatus() map[string]interface{} {
	return map[string]interface{}{
		"running": a.running,
	}
}

func (a *App) GetLogs() []LogEntry {
	a.mu.Lock()
	defer a.mu.Unlock()
	result := make([]LogEntry, len(a.logs))
	copy(result, a.logs)
	return result
}

func (a *App) GetUser() *UserSession {
	return a.user
}

func (a *App) ClearLogs() bool {
	a.mu.Lock()
	a.logs = a.logs[:0]
	a.mu.Unlock()
	return true
}

// ─── Auth ────────────────────────────────────────────────

func (a *App) Login(email, password string) map[string]interface{} {
	body, _ := json.Marshal(map[string]string{
		"email":    email,
		"password": password,
	})

	url := fmt.Sprintf("%s/auth/v1/token?grant_type=password", supabaseURL)
	req, _ := http.NewRequest("POST", url, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", supabaseAnon)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&result)

	if resp.StatusCode != 200 {
		msg := "Login failed"
		if errMsg, ok := result["error_description"].(string); ok {
			msg = errMsg
		} else if errMsg, ok := result["msg"].(string); ok {
			msg = errMsg
		}
		return map[string]interface{}{"error": msg}
	}

	// Extract user data
	userMap, _ := result["user"].(map[string]interface{})
	accessToken, _ := result["access_token"].(string)

	if userMap == nil {
		return map[string]interface{}{"error": "Invalid response"}
	}

	a.user = &UserSession{
		ID:    fmt.Sprintf("%v", userMap["id"]),
		Email: fmt.Sprintf("%v", userMap["email"]),
		Token: accessToken,
	}

	// Save credentials for next time
	a.saveCredentials(email, password)

	a.addLog(fmt.Sprintf("Đã đăng nhập: %s", a.user.Email), "success")
	wailsRuntime.EventsEmit(a.ctx, "user", a.user)

	return map[string]interface{}{
		"user": map[string]interface{}{
			"id":    a.user.ID,
			"email": a.user.Email,
		},
	}
}

func (a *App) Logout() bool {
	a.StopAgent()
	a.user = nil
	a.clearCredentials()
	a.addLog("Đã đăng xuất", "info")
	wailsRuntime.EventsEmit(a.ctx, "user", nil)
	return true
}

// ─── Agent Process ───────────────────────────────────────

func (a *App) getAppRoot() string {
	exe, err := os.Executable()
	if err != nil {
		return filepath.Join("..", "")
	}
	dir := filepath.Dir(exe)

	// Search for agent.js going up from exe directory
	// Prod: agent.js next to exe
	// Dev: exe at wails/build/bin/ → need to go up to socialflow-agent/
	candidates := []string{
		dir,                                           // same folder as exe
		filepath.Dir(dir),                             // one up (build/)
		filepath.Dir(filepath.Dir(dir)),               // two up (wails/)
		filepath.Dir(filepath.Dir(filepath.Dir(dir))), // three up (socialflow-agent/)
	}

	for _, candidate := range candidates {
		agentPath := filepath.Join(candidate, "agent.js")
		if _, err := os.Stat(agentPath); err == nil {
			return candidate
		}
	}
	return dir
}

func (a *App) StartAgent() map[string]interface{} {
	if a.user == nil {
		return map[string]interface{}{"error": "Chưa đăng nhập"}
	}
	if a.running {
		return map[string]interface{}{"error": "Agent đang chạy"}
	}

	// Check Node.js installed
	if err := a.ensureNodeJS(); err != nil {
		return map[string]interface{}{"error": "Cần cài Node.js trước. Tải tại: https://nodejs.org/"}
	}

	// Auto-install node_modules nếu thiếu (lần đầu chạy)
	if err := a.ensureNodeModules(); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("Không cài được thư viện: %s", err)}
	}

	// Fetch config from API (SaaS model — no .env needed)
	a.addLog("Đang lấy cấu hình từ server...", "info")
	wailsRuntime.EventsEmit(a.ctx, "setup-progress", "Đang lấy cấu hình...")
	cfg, cfgErr := a.fetchAgentConfig()
	wailsRuntime.EventsEmit(a.ctx, "setup-progress", nil)

	if cfgErr != nil {
		a.addLog(fmt.Sprintf("Không lấy được config: %s — thử dùng .env", cfgErr), "warn")
	} else {
		a.addLog("Đã nhận config từ server", "success")
	}

	// Ensure Playwright is installed
	a.ensurePlaywright()

	appRoot := a.getAppRoot()
	agentPath := filepath.Join(appRoot, "agent.js")

	if _, err := os.Stat(agentPath); os.IsNotExist(err) {
		a.addLog(fmt.Sprintf("agent.js not found: %s", agentPath), "error")
		return map[string]interface{}{"error": "agent.js not found"}
	}

	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel

	nodeCmd := "node"
	a.cmd = exec.CommandContext(ctx, nodeCmd, agentPath)
	a.cmd.Dir = appRoot
	hideConsole(a.cmd) // Windows: hide terminal window

	// Build env — API config takes priority, .env as fallback
	env := os.Environ()
	env = append(env, fmt.Sprintf("AGENT_USER_ID=%s", a.user.ID))
	env = append(env, fmt.Sprintf("AGENT_USER_EMAIL=%s", a.user.Email))

	// Load .env first (lowest priority)
	envFile := filepath.Join(appRoot, ".env")
	if data, err := os.ReadFile(envFile); err == nil {
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line != "" && !strings.HasPrefix(line, "#") && strings.Contains(line, "=") {
				env = append(env, line)
			}
		}
	}

	// API config overrides .env (highest priority — appended last wins)
	if cfg != nil {
		env = append(env, fmt.Sprintf("SUPABASE_URL=%s", cfg.SupabaseURL))
		env = append(env, fmt.Sprintf("SUPABASE_ANON_KEY=%s", cfg.SupabaseAnon))
		env = append(env, fmt.Sprintf("API_URL=%s", cfg.APIURL))
		env = append(env, fmt.Sprintf("API_BASE_URL=%s", cfg.APIURL))
		env = append(env, fmt.Sprintf("AGENT_SECRET_KEY=%s", cfg.AgentSecretKey))
	} else {
		// Last-resort fallback: hardcoded public Supabase URL + anon key
		// (these are anon, not secret — same defaults as init())
		env = append(env, fmt.Sprintf("SUPABASE_URL=%s", supabaseURL))
		env = append(env, fmt.Sprintf("SUPABASE_ANON_KEY=%s", supabaseAnon))
		env = append(env, fmt.Sprintf("API_URL=%s", apiURL))
		env = append(env, fmt.Sprintf("API_BASE_URL=%s", apiURL))
	}

	// Pass user JWT so agent can authenticate with API for AI calls
	env = append(env, fmt.Sprintf("AGENT_USER_TOKEN=%s", a.user.Token))

	a.cmd.Env = env

	// Pipe stdout/stderr
	stdout, _ := a.cmd.StdoutPipe()
	stderr, _ := a.cmd.StderrPipe()

	if err := a.cmd.Start(); err != nil {
		a.addLog(fmt.Sprintf("Failed to start agent: %s", err), "error")
		return map[string]interface{}{"error": err.Error()}
	}

	a.running = true
	a.addLog("Agent started", "success")
	wailsRuntime.EventsEmit(a.ctx, "status", map[string]interface{}{"running": true})

	// Stream stdout
	go a.streamOutput(stdout, false)
	// Stream stderr
	go a.streamOutput(stderr, true)

	// Wait for exit
	go func() {
		err := a.cmd.Wait()
		a.running = false
		code := 0
		if err != nil {
			if exitErr, ok := err.(*exec.ExitError); ok {
				code = exitErr.ExitCode()
			}
		}
		a.addLog(fmt.Sprintf("Agent stopped (code: %d)", code), "info")
		wailsRuntime.EventsEmit(a.ctx, "status", map[string]interface{}{"running": false})
	}()

	return map[string]interface{}{"success": true}
}

func (a *App) streamOutput(reader io.ReadCloser, isStderr bool) {
	buf := make([]byte, 4096)
	for {
		n, err := reader.Read(buf)
		if n > 0 {
			lines := strings.Split(strings.TrimRight(string(buf[:n]), "\n"), "\n")
			for _, line := range lines {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}
				logType := classifyLogType(line)
				if isStderr {
					logType = "error"
				}
				a.addLog(line, logType)
			}
		}
		if err != nil {
			break
		}
	}
}

func (a *App) StopAgent() bool {
	if !a.running || a.cmd == nil {
		return true
	}

	a.addLog("Stopping agent...", "info")

	// Cancel context (sends signal)
	if a.cancel != nil {
		a.cancel()
	}

	// Give 5 seconds to exit gracefully
	done := make(chan struct{})
	go func() {
		if a.cmd.Process != nil {
			a.cmd.Process.Wait()
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		if a.cmd.Process != nil {
			a.cmd.Process.Kill()
		}
	}

	a.running = false
	a.cmd = nil
	wailsRuntime.EventsEmit(a.ctx, "status", map[string]interface{}{"running": false})
	return true
}

func (a *App) ensureNodeJS() error {
	cmd := exec.Command("node", "--version")
	if err := cmd.Run(); err != nil {
		a.addLog("Chưa cài Node.js! Tải tại: https://nodejs.org/", "error")
		return fmt.Errorf("nodejs not installed")
	}
	return nil
}

func (a *App) ensureNodeModules() error {
	appRoot := a.getAppRoot()
	nodeModules := filepath.Join(appRoot, "node_modules")

	// Check if node_modules exists and has @supabase
	supabaseDir := filepath.Join(nodeModules, "@supabase")
	if _, err := os.Stat(supabaseDir); err == nil {
		return nil // already installed
	}

	a.addLog("Lần đầu chạy — đang cài thư viện (~1-2 phút)...", "warn")
	wailsRuntime.EventsEmit(a.ctx, "setup-progress", "Đang cài thư viện npm (~1-2 phút)...")

	npm := "npm"
	if runtime.GOOS == "windows" {
		npm = "npm.cmd"
	}

	installCmd := exec.Command(npm, "install", "--production", "--no-audit", "--no-fund")
	installCmd.Dir = appRoot
	hideConsole(installCmd)

	output, err := installCmd.CombinedOutput()
	wailsRuntime.EventsEmit(a.ctx, "setup-progress", nil)

	if err != nil {
		a.addLog(fmt.Sprintf("npm install thất bại: %s", err), "error")
		if len(output) > 0 {
			tail := string(output)
			if len(tail) > 500 {
				tail = tail[len(tail)-500:]
			}
			a.addLog(tail, "error")
		}
		return fmt.Errorf("npm install failed: %s", err)
	}

	a.addLog("Cài thư viện xong!", "success")
	return nil
}

func (a *App) ensurePlaywright() {
	a.addLog("Checking Playwright Chromium...", "info")
	wailsRuntime.EventsEmit(a.ctx, "setup-progress", "Checking browser...")

	appRoot := a.getAppRoot()

	// Check if chromium exists (try to find it)
	npx := "npx"
	if runtime.GOOS == "windows" {
		npx = "npx.cmd"
	}

	// Quick check — try running a test
	checkCmd := exec.Command(npx, "playwright", "install", "--dry-run", "chromium")
	checkCmd.Dir = appRoot
	if err := checkCmd.Run(); err == nil {
		a.addLog("Playwright Chromium ready", "success")
		wailsRuntime.EventsEmit(a.ctx, "setup-progress", nil)
		return
	}

	// Need to install
	a.addLog("Installing Playwright Chromium...", "warn")
	wailsRuntime.EventsEmit(a.ctx, "setup-progress", "Installing Chromium browser...")

	installCmd := exec.Command(npx, "playwright", "install", "chromium")
	installCmd.Dir = appRoot
	output, err := installCmd.CombinedOutput()
	if err != nil {
		a.addLog(fmt.Sprintf("Chromium install failed: %s", err), "error")
	} else {
		a.addLog("Chromium installed successfully", "success")
	}
	if len(output) > 0 {
		a.addLog(strings.TrimSpace(string(output)), "info")
	}

	wailsRuntime.EventsEmit(a.ctx, "setup-progress", nil)
}

// ─── Phase 10: Connectivity watcher ──────────────────────

// setOnline updates a.online and emits a "connectivity" event if state flipped.
// Safe to call from any goroutine — guarded by mu.
func (a *App) setOnline(online bool) {
	a.mu.Lock()
	prev := a.online
	a.online = online
	if online && !prev {
		a.onlineSince = time.Now()
	}
	a.mu.Unlock()
	if prev != online && a.ctx != nil {
		wailsRuntime.EventsEmit(a.ctx, "connectivity", map[string]interface{}{
			"online": online,
			"since":  a.onlineSince.Format(time.RFC3339),
		})
		if online {
			a.addLog("Đã kết nối lại API — đang refresh config", "success")
			// Refresh config opportunistically (non-blocking)
			go func() {
				if a.user != nil {
					_, _ = a.fetchAgentConfig()
				}
			}()
		} else {
			a.addLog("Mất kết nối API — chạy ở chế độ offline (cache)", "warn")
		}
	}
}

// GetConnectivity is exposed to JS so the frontend can poll on first paint.
func (a *App) GetConnectivity() map[string]interface{} {
	a.mu.Lock()
	defer a.mu.Unlock()
	return map[string]interface{}{
		"online": a.online,
		"since":  a.onlineSince.Format(time.RFC3339),
	}
}

// startConnectivityWatcher pings the API /health endpoint every 5 minutes
// and updates a.online accordingly. First check fires after 30s.
func (a *App) startConnectivityWatcher() {
	go func() {
		time.Sleep(30 * time.Second)
		a.checkConnectivity()
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			a.checkConnectivity()
		}
	}()
}

func (a *App) checkConnectivity() {
	client := &http.Client{Timeout: 5 * time.Second}
	url := fmt.Sprintf("%s/health", apiURL)
	resp, err := client.Get(url)
	if err != nil {
		a.setOnline(false)
		return
	}
	defer resp.Body.Close()
	a.setOnline(resp.StatusCode >= 200 && resp.StatusCode < 500)
}

// ─── Auto-Update (GitHub Releases) ───────────────────────

const (
	githubReleaseAPI = "https://api.github.com/repos/vnvibe/socialflow/releases/latest"
	updateCheckEvery = 30 * time.Minute
)

type GHReleaseAsset struct {
	Name        string `json:"name"`
	DownloadURL string `json:"browser_download_url"`
	Size        int64  `json:"size"`
	UpdatedAt   string `json:"updated_at"`
}

type GHRelease struct {
	TagName     string           `json:"tag_name"`
	PublishedAt string           `json:"published_at"`
	Assets      []GHReleaseAsset `json:"assets"`
}

func lastUpdateFile() string {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".socialflow")
	os.MkdirAll(dir, 0700)
	return filepath.Join(dir, "last-update")
}

func (a *App) getLastAppliedUpdate() string {
	data, err := os.ReadFile(lastUpdateFile())
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

func (a *App) saveLastAppliedUpdate(tag string) {
	os.WriteFile(lastUpdateFile(), []byte(tag), 0600)
}

func fetchLatestRelease() (*GHRelease, error) {
	client := &http.Client{Timeout: 15 * time.Second}
	req, _ := http.NewRequest("GET", githubReleaseAPI, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("github api %d", resp.StatusCode)
	}
	var rel GHRelease
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, err
	}
	return &rel, nil
}

// startAutoUpdater runs background loop checking for updates every 30 min
func (a *App) startAutoUpdater() {
	go func() {
		// Initial check after 60s (let app boot first)
		time.Sleep(60 * time.Second)
		a.checkAndApplyUpdate(true)

		ticker := time.NewTicker(updateCheckEvery)
		defer ticker.Stop()
		for range ticker.C {
			a.checkAndApplyUpdate(true)
		}
	}()
}

// checkAndApplyUpdate checks GitHub for new release and applies it silently.
// silent=true: don't log "no update" messages, only act on real updates.
func (a *App) checkAndApplyUpdate(silent bool) {
	rel, err := fetchLatestRelease()
	if err != nil {
		if !silent {
			a.addLog(fmt.Sprintf("Check update lỗi: %s", err), "warn")
		}
		return
	}

	// Find the agent zip asset FIRST so we can key on its updated_at (changes on --clobber re-upload).
	var zipAsset *GHReleaseAsset
	for i := range rel.Assets {
		if strings.HasSuffix(rel.Assets[i].Name, ".zip") {
			zipAsset = &rel.Assets[i]
			break
		}
	}
	if zipAsset == nil {
		if !silent {
			a.addLog("Release không có file zip", "warn")
		}
		return
	}

	lastApplied := a.getLastAppliedUpdate()
	// Key on tag + asset.updated_at (re-uploaded zip via --clobber bumps updated_at,
	// while published_at stays the same on the GitHub release).
	// Fallback to publishedAt if asset has no updated_at (shouldn't happen).
	zipStamp := zipAsset.UpdatedAt
	if zipStamp == "" {
		zipStamp = rel.PublishedAt
	}
	versionKey := rel.TagName + "|" + zipStamp
	if lastApplied == versionKey {
		return // already on this version
	}

	a.addLog(fmt.Sprintf("Phát hiện bản mới: %s — đang cập nhật...", rel.TagName), "info")
	wailsRuntime.EventsEmit(a.ctx, "update-available", map[string]interface{}{
		"tag":     rel.TagName,
		"applying": true,
	})

	if err := a.downloadAndApplyZip(zipAsset.DownloadURL); err != nil {
		a.addLog(fmt.Sprintf("Cập nhật thất bại: %s", err), "error")
		return
	}

	a.saveLastAppliedUpdate(versionKey)
	a.addLog(fmt.Sprintf("Đã cập nhật %s thành công, khởi động lại agent...", rel.TagName), "success")
	wailsRuntime.EventsEmit(a.ctx, "update-applied", map[string]interface{}{
		"tag": rel.TagName,
	})

	// Restart agent if it was running
	if a.running {
		a.addLog("Đang khởi động lại agent...", "info")
		a.StopAgent()
		time.Sleep(2 * time.Second)
		a.StartAgent()
	}
}

// downloadAndApplyZip downloads release zip and replaces agent files in-place.
// Skips SocialFlowAgent.exe (the currently-running binary cannot be replaced).
func (a *App) downloadAndApplyZip(url string) error {
	// Download to temp file
	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download: %s", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download status %d", resp.StatusCode)
	}

	tmpFile, err := os.CreateTemp("", "socialflow-update-*.zip")
	if err != nil {
		return err
	}
	tmpPath := tmpFile.Name()
	defer os.Remove(tmpPath)

	if _, err := io.Copy(tmpFile, resp.Body); err != nil {
		tmpFile.Close()
		return fmt.Errorf("save zip: %s", err)
	}
	tmpFile.Close()

	// Open zip
	zr, err := zip.OpenReader(tmpPath)
	if err != nil {
		return fmt.Errorf("open zip: %s", err)
	}
	defer zr.Close()

	appRoot := a.getAppRoot()

	// Extract — skip the exe (locked), skip top-level dir prefix
	for _, f := range zr.File {
		// Strip leading "socialflow-agent/" if present
		name := f.Name
		if idx := strings.Index(name, "/"); idx != -1 && strings.HasPrefix(name, "socialflow-agent/") {
			name = name[idx+1:]
		}
		if name == "" {
			continue
		}

		// Skip the running exe
		if strings.EqualFold(filepath.Base(name), "SocialFlowAgent.exe") {
			continue
		}
		// Skip user files
		if name == ".env" || name == "config.env" {
			continue
		}

		destPath := filepath.Join(appRoot, name)

		if f.FileInfo().IsDir() {
			os.MkdirAll(destPath, 0755)
			continue
		}

		// Ensure parent dir exists
		os.MkdirAll(filepath.Dir(destPath), 0755)

		// Extract file
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("read entry %s: %s", name, err)
		}

		out, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			rc.Close()
			return fmt.Errorf("write %s: %s", name, err)
		}

		if _, err := io.Copy(out, rc); err != nil {
			rc.Close()
			out.Close()
			return fmt.Errorf("copy %s: %s", name, err)
		}
		rc.Close()
		out.Close()
	}

	// Re-run npm install in case package.json changed
	a.addLog("Cài lại thư viện sau khi update...", "info")
	if err := a.ensureNodeModulesForce(); err != nil {
		a.addLog(fmt.Sprintf("npm install warning: %s", err), "warn")
	}

	return nil
}

// ensureNodeModulesForce always runs npm install (after update)
func (a *App) ensureNodeModulesForce() error {
	appRoot := a.getAppRoot()
	npm := "npm"
	if runtime.GOOS == "windows" {
		npm = "npm.cmd"
	}
	installCmd := exec.Command(npm, "install", "--production", "--no-audit", "--no-fund")
	installCmd.Dir = appRoot
	hideConsole(installCmd)
	output, err := installCmd.CombinedOutput()
	if err != nil {
		if len(output) > 0 {
			tail := string(output)
			if len(tail) > 300 {
				tail = tail[len(tail)-300:]
			}
			a.addLog(tail, "warn")
		}
		return err
	}
	return nil
}

// ─── Version & Update ────────────────────────────────────

func (a *App) GetVersion() string {
	appRoot := a.getAppRoot()
	pkgPath := filepath.Join(appRoot, "package.json")
	data, err := os.ReadFile(pkgPath)
	if err != nil {
		return "unknown"
	}
	var pkg map[string]interface{}
	json.Unmarshal(data, &pkg)
	if v, ok := pkg["version"].(string); ok {
		return v
	}
	return "unknown"
}

func (a *App) CheckUpdate() map[string]interface{} {
	appRoot := a.getAppRoot()

	// Check if git repo
	gitDir := filepath.Join(appRoot, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		// Not a git repo — check HTTP
		return a.checkHTTPUpdate()
	}

	// Git mode: fetch and compare
	fetchCmd := exec.Command("git", "fetch", "origin")
	fetchCmd.Dir = appRoot
	fetchCmd.Run()

	// Get current branch
	branchCmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
	branchCmd.Dir = appRoot
	branchOut, _ := branchCmd.Output()
	branch := strings.TrimSpace(string(branchOut))
	if branch == "" {
		branch = "main"
	}

	// Count commits behind
	logCmd := exec.Command("git", "rev-list", "--count", fmt.Sprintf("HEAD..origin/%s", branch))
	logCmd.Dir = appRoot
	countOut, err := logCmd.Output()
	if err != nil {
		return map[string]interface{}{"hasUpdate": false}
	}

	behind := strings.TrimSpace(string(countOut))
	if behind == "0" || behind == "" {
		return map[string]interface{}{"hasUpdate": false}
	}

	// Get summary of changes
	summaryCmd := exec.Command("git", "log", "--oneline", fmt.Sprintf("HEAD..origin/%s", branch), "-5")
	summaryCmd.Dir = appRoot
	summaryOut, _ := summaryCmd.Output()

	return map[string]interface{}{
		"hasUpdate": true,
		"behind":    behind,
		"summary":   strings.TrimSpace(string(summaryOut)),
		"method":    "git",
	}
}

func (a *App) checkHTTPUpdate() map[string]interface{} {
	// Check GitHub for newer version
	url := "https://raw.githubusercontent.com/nguyentanviet92-pixel/socialflow/main/socialflow-agent/package.json"
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return map[string]interface{}{"hasUpdate": false}
	}
	defer resp.Body.Close()

	var pkg map[string]interface{}
	json.NewDecoder(resp.Body).Decode(&pkg)
	remoteVersion, _ := pkg["version"].(string)
	localVersion := a.GetVersion()

	if remoteVersion != "" && remoteVersion != localVersion {
		return map[string]interface{}{
			"hasUpdate": true,
			"local":     localVersion,
			"remote":    remoteVersion,
			"method":    "http",
		}
	}
	return map[string]interface{}{"hasUpdate": false}
}

func (a *App) ApplyUpdate() map[string]interface{} {
	appRoot := a.getAppRoot()
	gitDir := filepath.Join(appRoot, ".git")

	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		// HTTP mode: open GitHub releases
		wailsRuntime.BrowserOpenURL(a.ctx, "https://github.com/nguyentanviet92-pixel/socialflow/releases")
		a.addLog("Mở trang tải bản mới...", "info")
		return map[string]interface{}{"success": true, "method": "http"}
	}

	// Git mode: stop agent, pull, restart
	if a.running {
		a.addLog("Đang tắt agent để cập nhật...", "info")
		a.StopAgent()
		time.Sleep(2 * time.Second)
	}

	a.addLog("Đang tải bản cập nhật...", "info")
	wailsRuntime.EventsEmit(a.ctx, "setup-progress", "Đang cập nhật...")

	pullCmd := exec.Command("git", "pull", "--rebase", "origin")
	pullCmd.Dir = appRoot
	output, err := pullCmd.CombinedOutput()

	wailsRuntime.EventsEmit(a.ctx, "setup-progress", nil)

	if err != nil {
		msg := fmt.Sprintf("Cập nhật thất bại: %s", strings.TrimSpace(string(output)))
		a.addLog(msg, "error")
		return map[string]interface{}{"success": false, "message": msg}
	}

	a.addLog("Cập nhật thành công! Đang khởi động lại...", "success")

	return map[string]interface{}{"success": true, "message": "Updated", "method": "git"}
}
