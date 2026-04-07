package main

import (
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

func (a *App) fetchAgentConfig() (*AgentConfig, error) {
	if a.user == nil {
		return nil, fmt.Errorf("not logged in")
	}

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

	// Check for updates after 5s (non-blocking)
	go func() {
		time.Sleep(5 * time.Second)
		result := a.CheckUpdate()
		if hasUpdate, ok := result["hasUpdate"].(bool); ok && hasUpdate {
			wailsRuntime.EventsEmit(a.ctx, "update-available", result)
		}
	}()
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
	}

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
