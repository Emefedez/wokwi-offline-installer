package main

import (
	"archive/tar"
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type ElementSpecs struct {
	Notes string `json:"notes"`
}

type CatalogElement struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Category   string            `json:"category"`
	WokwiType  string            `json:"wokwiType"`
	ChipName   string            `json:"chipName,omitempty"`
	ChipBinary string            `json:"chipBinary,omitempty"`
	ChipJSON   string            `json:"chipJson,omitempty"`
	IDPrefix   string            `json:"idPrefix"`
	IsBoard    bool              `json:"isBoard,omitempty"`
	DefaultCnt int               `json:"defaultCount"`
	Attrs      map[string]string `json:"attrs"`
	Pins       []string          `json:"pins"`
	SignalPin  string            `json:"signalPin,omitempty"`
	PowerPin   string            `json:"powerPin,omitempty"`
	GndPin     string            `json:"gndPin,omitempty"`
	PowerRail  string            `json:"powerRail,omitempty"`
	Specs      ElementSpecs      `json:"specs"`
	ImportPath string            `json:"importDiskPath,omitempty"`
}

type Preset struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Counts      map[string]int `json:"counts"`
}

type Catalog struct {
	Version       int               `json:"version"`
	Title         string            `json:"title"`
	DefaultPreset string            `json:"defaultPreset"`
	Presets       map[string]Preset `json:"presets"`
	Elements      []CatalogElement  `json:"elements"`
}

func resolveInstallerRoot() string {
	exe, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(exe)
		if _, err := os.Stat(filepath.Join(dir, "hardware", "catalog.json")); err == nil {
			return dir
		}
	}
	cwd, _ := os.Getwd()
	return cwd
}

func expandHome(p string) string {
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, "~\\") {
		home, _ := os.UserHomeDir()
		return filepath.Join(home, p[2:])
	}
	return p
}

func loadCatalog(root string) (*Catalog, error) {
	catPath := filepath.Join(root, "hardware", "catalog.json")
	raw, err := os.ReadFile(catPath)
	if err != nil {
		return nil, err
	}
	var cat Catalog
	if err := json.Unmarshal(raw, &cat); err != nil {
		return nil, err
	}
	return &cat, nil
}

func saveCatalog(root string, cat *Catalog) error {
	catPath := filepath.Join(root, "hardware", "catalog.json")
	data, err := json.MarshalIndent(cat, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(catPath, append(data, '\n'), 0644)
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if _, err := io.Copy(out, in); err != nil {
		return err
	}
	info, err := os.Stat(src)
	if err == nil {
		_ = os.Chmod(dst, info.Mode())
	}
	return nil
}

func copyDirRecursive(srcDir, dstDir string) error {
	return filepath.Walk(srcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(srcDir, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dstDir, rel)
		if info.IsDir() {
			return os.MkdirAll(target, 0755)
		}
		return copyFile(path, target)
	})
}

func vsCodeSettingsPath() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		appData := os.Getenv("APPDATA")
		if appData == "" {
			appData = filepath.Join(home, "AppData", "Roaming")
		}
		return filepath.Join(appData, "Code", "User", "settings.json")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Code", "User", "settings.json")
	default:
		return filepath.Join(home, ".config", "Code", "User", "settings.json")
	}
}

func disableVsCodeAutoUpdate() error {
	sPath := vsCodeSettingsPath()
	_ = os.MkdirAll(filepath.Dir(sPath), 0755)
	settings := map[string]interface{}{}
	if raw, err := os.ReadFile(sPath); err == nil && len(bytes.TrimSpace(raw)) > 0 {
		_ = json.Unmarshal(raw, &settings)
		_ = copyFile(sPath, sPath+".wokwi-bak")
	}
	settings["extensions.autoUpdate"] = false
	settings["extensions.autoCheckUpdates"] = false
	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(sPath, append(out, '\n'), 0644)
}

func extractWpkBundle(bundlePath, cacheDir string) (int, error) {
	bundlePath = expandHome(strings.TrimSpace(bundlePath))
	raw, err := os.ReadFile(bundlePath)
	if err != nil {
		return 0, err
	}
	home, _ := os.UserHomeDir()
	wokwiDir := filepath.Join(home, ".wokwi")
	_ = os.MkdirAll(wokwiDir, 0755)
	dstWpk := filepath.Join(wokwiDir, "bundle.wpk")
	if filepath.Clean(bundlePath) != filepath.Clean(dstWpk) {
		_ = copyFile(bundlePath, dstWpk)
	}

	nlIdx := bytes.IndexByte(raw, '\n')
	if nlIdx < 0 {
		return 0, fmt.Errorf("invalid .wpk header")
	}
	payload := make([]byte, len(raw)-(nlIdx+1))
	copy(payload, raw[nlIdx+1:])
	for i := range payload {
		payload[i] ^= 66
	}

	gz, err := gzip.NewReader(bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	count := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return count, err
		}
		name := strings.TrimRight(hdr.Name, "\x00")
		if name == "" || name == "././@LongLink" || strings.Contains(name, "..") {
			continue
		}
		target := filepath.Join(cacheDir, filepath.FromSlash(name))
		if hdr.Typeflag == tar.TypeDir {
			_ = os.MkdirAll(target, 0755)
			continue
		}
		_ = os.MkdirAll(filepath.Dir(target), 0755)
		f, err := os.Create(target)
		if err != nil {
			return count, err
		}
		_, _ = io.Copy(f, tr)
		f.Close()
		count++
	}
	return count, nil
}

func parseUserTokMetadata(raw string) map[string]string {
	keyVal := strings.TrimSpace(raw)
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "key=") {
			keyVal = strings.TrimSpace(strings.TrimPrefix(line, "key="))
			break
		}
	}
	b64 := strings.ReplaceAll(strings.ReplaceAll(strings.TrimRight(keyVal, "="), "_P", "+"), "_S", "/")
	switch len(b64) % 4 {
	case 2:
		b64 += "=="
	case 3:
		b64 += "="
	}
	meta := map[string]string{}
	if decoded, err := base64.StdEncoding.DecodeString(b64); err == nil {
		if nul := bytes.IndexByte(decoded, 0); nul > 0 {
			if vals, err := url.ParseQuery(string(decoded[:nul])); err == nil {
				meta["userId"] = vals.Get("u")
				meta["name"] = vals.Get("n")
				meta["email"] = vals.Get("e")
				meta["expiration"] = vals.Get("x")
				meta["plan"] = vals.Get("p")
			}
		}
	}
	return meta
}

func overwriteUserTok(srcPath, rawContent string, backup bool) (map[string]interface{}, error) {
	home, _ := os.UserHomeDir()
	wokwiDir := filepath.Join(home, ".wokwi")
	_ = os.MkdirAll(wokwiDir, 0755)
	tokPath := filepath.Join(wokwiDir, "user.tok")

	if backup {
		if _, err := os.Stat(tokPath); err == nil {
			_ = copyFile(tokPath, tokPath+".bak")
		}
	}

	var finalText string
	if strings.TrimSpace(srcPath) != "" {
		resolved := expandHome(strings.TrimSpace(srcPath))
		b, err := os.ReadFile(resolved)
		if err != nil {
			return nil, fmt.Errorf("failed to read %s: %w", resolved, err)
		}
		finalText = string(b)
	} else {
		finalText = rawContent
	}

	finalText = strings.TrimSpace(finalText)
	if finalText == "" {
		return nil, fmt.Errorf("empty user.tok content provided")
	}

	meta := parseUserTokMetadata(finalText)
	if !strings.Contains(finalText, "key=") {
		userDesc := "Validated User"
		if meta["name"] != "" || meta["email"] != "" {
			userDesc = fmt.Sprintf("%s <%s> (Plan: %s)", meta["name"], meta["email"], meta["plan"])
		}
		finalText = fmt.Sprintf("# Wokwi License\n# User: %s\n\nkey=%s\nts=%d\n", userDesc, finalText, time.Now().UnixMilli())
	} else if !strings.HasSuffix(finalText, "\n") {
		finalText += "\n"
	}

	if err := os.WriteFile(tokPath, []byte(finalText), 0600); err != nil {
		return nil, err
	}

	// Best-effort hot reload into running VS Code extension bridge if active
	go func() {
		payload, _ := json.Marshal(map[string]interface{}{
			"action":  "load_user_tok",
			"content": finalText,
			"backup":  false,
		})
		client := &http.Client{Timeout: 800 * time.Millisecond}
		resp, err := client.Post("http://127.0.0.1:47129/mcp", "application/json", bytes.NewReader(payload))
		if err == nil && resp != nil {
			resp.Body.Close()
		}
	}()

	msg := fmt.Sprintf("Overwrote %s", tokPath)
	if meta["name"] != "" || meta["email"] != "" {
		msg = fmt.Sprintf("Overwrote %s — User: %s <%s> (Plan: %s, Expires: %s)", tokPath, meta["name"], meta["email"], meta["plan"], meta["expiration"])
	}
	return map[string]interface{}{
		"ok":       true,
		"path":     tokPath,
		"content":  finalText,
		"metadata": meta,
		"message":  msg,
	}, nil
}

func saveLicenseToken(input string) (string, error) {
	input = expandHome(strings.TrimSpace(input))
	if input == "" {
		return "", nil
	}
	if info, err := os.Stat(input); err == nil && !info.IsDir() {
		res, err := overwriteUserTok(input, "", true)
		if err != nil {
			return "", err
		}
		return res["message"].(string), nil
	}
	res, err := overwriteUserTok("", input, true)
	if err != nil {
		return "", err
	}
	return res["message"].(string), nil
}

func runFullEnvironmentSetup(root, bundlePath, licenseInput string, mcpTargets []string) (string, error) {
	home, _ := os.UserHomeDir()
	wokwiDir := filepath.Join(home, ".wokwi")
	extDir := filepath.Join(home, ".vscode", "extensions", "wokwi.wokwi-vscode-4.1.0")
	cacheDir := filepath.Join(extDir, ".cache")

	var summary []string

	// 1. Copy extension & hardware & MCP
	if err := copyDirRecursive(filepath.Join(root, "extension"), extDir); err == nil {
		summary = append(summary, "Installed offline-first Wokwi extension to "+extDir)
	}
	if err := copyDirRecursive(filepath.Join(root, "mcp"), filepath.Join(wokwiDir, "mcp")); err == nil {
		summary = append(summary, "Installed Wokwi Offline MCP to "+filepath.Join(wokwiDir, "mcp"))
	}
	if err := copyDirRecursive(filepath.Join(root, "hardware"), filepath.Join(wokwiDir, "hardware-elements")); err == nil {
		summary = append(summary, "Installed RC Car & ESP32Calc hardware elements to "+filepath.Join(wokwiDir, "hardware-elements"))
	}

	// 2. Disable VS Code extension auto-update
	if err := disableVsCodeAutoUpdate(); err == nil {
		summary = append(summary, "Disabled VS Code extension auto-update in settings.json")
	}

	// 3. Extract .wpk bundle
	if bundlePath != "" {
		if n, err := extractWpkBundle(bundlePath, cacheDir); err == nil {
			summary = append(summary, fmt.Sprintf("Extracted %d files from bundle.wpk into %s", n, cacheDir))
		} else {
			summary = append(summary, "Bundle warning: "+err.Error())
		}
	}

	// 4. Save license
	if licenseInput != "" {
		if msg, err := saveLicenseToken(licenseInput); err == nil && msg != "" {
			summary = append(summary, msg)
		}
	}

	// 5. Run MCP installer if node is available
	if len(mcpTargets) > 0 {
		installerJs := filepath.Join(wokwiDir, "mcp", "install-mcp.js")
		args := append([]string{installerJs, "install"}, mcpTargets...)
		cmd := exec.Command("node", args...)
		if out, err := cmd.CombinedOutput(); err == nil {
			summary = append(summary, strings.TrimSpace(string(out)))
		}
	}

	return strings.Join(summary, " | "), nil
}

func generateProjectFromCounts(root, targetDir string, cat *Catalog, counts map[string]int, firmware, elf string, rfcPort, gdbPort, motorV int, autoWire bool) ([]string, error) {
	targetDir = expandHome(strings.TrimSpace(targetDir))
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return nil, err
	}

	var tomlLines []string
	tomlLines = append(tomlLines,
		"# Generated by Wokwi Offline Suite — RC Car & Hardware TOML Generator",
		"[wokwi]",
		"version = 1",
		fmt.Sprintf("firmware = %q", firmware),
		fmt.Sprintf("elf = %q", elf),
		fmt.Sprintf("rfc2217ServerPort = %d", rfcPort),
		fmt.Sprintf("gdbServerPort = %d", gdbPort),
	)

	if counts["microsd_card"] > 0 {
		tomlLines = append(tomlLines, "", "[[sdcard]]", `folder = "sdcard"`, `size = "8M"`, "writeback = true")
	}

	usedChips := map[string]CatalogElement{}
	var parts []map[string]interface{}
	var connections [][]interface{}

	mainMcuID := ""
	reg7vID := ""
	pmicID := ""
	mcuGpioPool := []string{"4", "5", "6", "7", "15", "16", "17", "18", "8", "9", "10", "11", "12", "13", "14", "1", "2", "38", "39", "40", "41", "42"}
	gpioIdx := 0
	col, row := 0, 0

	for _, el := range cat.Elements {
		n := counts[el.ID]
		if n <= 0 {
			continue
		}
		if el.ChipName != "" && el.ChipBinary != "" {
			usedChips[el.ChipName] = el
		}
		for i := 1; i <= n; i++ {
			partID := el.IDPrefix
			if n > 1 {
				partID = fmt.Sprintf("%s_%d", el.IDPrefix, i)
			}
			attrs := map[string]string{}
			for k, v := range el.Attrs {
				attrs[k] = v
			}
			if el.ID == "jgb37_520" {
				attrs["nominalVoltage"] = strconv.Itoa(motorV)
			}
			parts = append(parts, map[string]interface{}{
				"type":  el.WokwiType,
				"id":    partID,
				"top":   row * 150,
				"left":  col * 240,
				"attrs": attrs,
			})
			col++
			if col >= 4 {
				col = 0
				row++
			}
			if el.IsBoard && mainMcuID == "" {
				mainMcuID = partID
			}
			if el.ID == "reg_7v" && reg7vID == "" {
				reg7vID = partID
			}
			if el.ID == "ip5306" && pmicID == "" {
				pmicID = partID
			}
		}
	}

	if autoWire && mainMcuID != "" {
		for _, p := range parts {
			pid := p["id"].(string)
			ptype := p["type"].(string)
			if pid == mainMcuID {
				continue
			}
			var found *CatalogElement
			for i := range cat.Elements {
				if cat.Elements[i].WokwiType == ptype {
					found = &cat.Elements[i]
					break
				}
			}
			if found == nil {
				continue
			}
			if found.GndPin != "" {
				connections = append(connections, []interface{}{mainMcuID + ":GND.1", pid + ":" + found.GndPin, "black", []string{"v0"}})
			}
			if found.PowerRail == "7V" && reg7vID != "" && found.PowerPin != "" {
				connections = append(connections, []interface{}{reg7vID + ":VOUT_POS", pid + ":" + found.PowerPin, "orange", []string{"v0"}})
			} else if found.PowerRail == "5V" && pmicID != "" && found.PowerPin != "" {
				connections = append(connections, []interface{}{pmicID + ":VOUT", pid + ":" + found.PowerPin, "red", []string{"v0"}})
			} else if found.PowerPin != "" {
				connections = append(connections, []interface{}{mainMcuID + ":3V3.1", pid + ":" + found.PowerPin, "red", []string{"v0"}})
			}
			if found.SignalPin != "" && gpioIdx < len(mcuGpioPool) {
				gpio := mcuGpioPool[gpioIdx]
				gpioIdx++
				connections = append(connections, []interface{}{mainMcuID + ":" + gpio, pid + ":" + found.SignalPin, "green", []string{"v0"}})
			}
		}
	}

	var copiedChips []string
	hwDir := filepath.Join(root, "hardware")
	for chipName, el := range usedChips {
		tomlLines = append(tomlLines, "", "[[chip]]", fmt.Sprintf("name = %q", chipName), fmt.Sprintf("binary = %q", el.ChipBinary))
		for _, f := range []string{el.ChipBinary, el.ChipJSON} {
			if f == "" {
				continue
			}
			src := filepath.Join(hwDir, f)
			if _, err := os.Stat(src); err == nil {
				_ = copyFile(src, filepath.Join(targetDir, f))
				copiedChips = append(copiedChips, f)
			}
		}
	}

	tomlLines = append(tomlLines, "", "# Hardware Elements Bill of Materials & Electrical Ratings")
	for _, el := range cat.Elements {
		n := counts[el.ID]
		if n <= 0 {
			continue
		}
		tomlLines = append(tomlLines,
			"",
			"[[hardware.element]]",
			fmt.Sprintf("id = %q", el.ID),
			fmt.Sprintf("name = %q", el.Name),
			fmt.Sprintf("type = %q", el.WokwiType),
			fmt.Sprintf("count = %d", n),
			fmt.Sprintf("specs = %q", el.Specs.Notes),
		)
	}

	if err := os.WriteFile(filepath.Join(targetDir, "wokwi.toml"), []byte(strings.Join(tomlLines, "\n")+"\n"), 0644); err != nil {
		return nil, err
	}

	diagObj := map[string]interface{}{
		"version":       1,
		"author":        "Wokwi Offline Suite Generator",
		"editor":        "wokwi",
		"parts":         parts,
		"connections":   connections,
		"serialMonitor": map[string]string{"display": "always", "newline": "lf"},
	}
	diagBytes, _ := json.MarshalIndent(diagObj, "", "  ")
	if err := os.WriteFile(filepath.Join(targetDir, "diagram.json"), append(diagBytes, '\n'), 0644); err != nil {
		return nil, err
	}

	return copiedChips, nil
}

func openBrowser(urlStr string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", urlStr)
	case "darwin":
		cmd = exec.Command("open", urlStr)
	default:
		cmd = exec.Command("xdg-open", urlStr)
	}
	_ = cmd.Start()
}

func runGUIServer(root string, port int) error {
	cat, err := loadCatalog(root)
	if err != nil {
		return err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		htmlBytes, err := os.ReadFile(filepath.Join(root, "gui", "index.html"))
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		catJSON, _ := json.Marshal(cat)
		rendered := strings.Replace(string(htmlBytes), "__CATALOG_JSON_PLACEHOLDER__", string(catJSON), 1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte(rendered))
	})

	mux.HandleFunc("/api/catalog", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(cat)
	})

	mux.HandleFunc("/api/import-element", func(w http.ResponseWriter, r *http.Request) {
		var el CatalogElement
		if err := json.NewDecoder(r.Body).Decode(&el); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if el.ImportPath != "" {
			imp := expandHome(el.ImportPath)
			if _, err := os.Stat(imp); err == nil {
				base := filepath.Base(imp)
				_ = copyFile(imp, filepath.Join(root, "hardware", base))
			}
		}
		replaced := false
		for i := range cat.Elements {
			if cat.Elements[i].ID == el.ID {
				cat.Elements[i] = el
				replaced = true
				break
			}
		}
		if !replaced {
			cat.Elements = append(cat.Elements, el)
		}
		_ = saveCatalog(root, cat)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "element": el})
	})

	mux.HandleFunc("/api/generate-project", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			TargetDir string   `json:"targetDir"`
			Toml      string   `json:"toml"`
			Diagram   string   `json:"diagram"`
			UsedChips []string `json:"usedChips"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		target := expandHome(req.TargetDir)
		if !filepath.IsAbs(target) {
			target = filepath.Join(root, target)
		}
		if err := os.MkdirAll(target, 0755); err != nil {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		_ = os.WriteFile(filepath.Join(target, "wokwi.toml"), []byte(req.Toml), 0644)
		_ = os.WriteFile(filepath.Join(target, "diagram.json"), []byte(req.Diagram), 0644)

		var copied []string
		hwDir := filepath.Join(root, "hardware")
		for _, ch := range req.UsedChips {
			for _, ext := range []string{".chip.wasm", ".chip.json"} {
				fname := ch + ext
				src := filepath.Join(hwDir, fname)
				if _, err := os.Stat(src); err == nil {
					_ = copyFile(src, filepath.Join(target, fname))
					copied = append(copied, fname)
				}
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":          true,
			"targetDir":   target,
			"copiedChips": copied,
		})
	})

	mux.HandleFunc("/api/user-tok", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		home, _ := os.UserHomeDir()
		tokPath := filepath.Join(home, ".wokwi", "user.tok")
		if r.Method == http.MethodGet {
			raw, err := os.ReadFile(tokPath)
			if err != nil {
				_ = json.NewEncoder(w).Encode(map[string]interface{}{
					"ok":      true,
					"exists":  false,
					"path":    tokPath,
					"content": "",
				})
				return
			}
			meta := parseUserTokMetadata(string(raw))
			_ = json.NewEncoder(w).Encode(map[string]interface{}{
				"ok":       true,
				"exists":   true,
				"path":     tokPath,
				"content":  string(raw),
				"metadata": meta,
			})
			return
		}
		var req struct {
			FilePath string `json:"filePath"`
			Content  string `json:"content"`
			Backup   bool   `json:"backup"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		res, err := overwriteUserTok(req.FilePath, req.Content, req.Backup)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(res)
	})

	mux.HandleFunc("/api/run-setup", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			BundlePath   string   `json:"bundlePath"`
			LicenseInput string   `json:"licenseInput"`
			McpTargets   []string `json:"mcpTargets"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		msg, err := runFullEnvironmentSetup(root, req.BundlePath, req.LicenseInput, req.McpTargets)
		w.Header().Set("Content-Type", "application/json")
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "message": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": true, "message": msg})
	})

	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return err
		}
	}
	actualURL := "http://" + ln.Addr().String()
	fmt.Printf("==================================================================\n")
	fmt.Printf("  Wokwi Offline Suite GUI running at: %s\n", actualURL)
	fmt.Printf("  Press Ctrl+C to stop the GUI server.\n")
	fmt.Printf("==================================================================\n")
	openBrowser(actualURL)
	return http.Serve(ln, mux)
}

func promptLine(reader *bufio.Reader, label, def string) string {
	if def != "" {
		fmt.Printf("%s [%s]: ", label, def)
	} else {
		fmt.Printf("%s: ", label)
	}
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		return def
	}
	return line
}

func runTUI(root string) error {
	cat, err := loadCatalog(root)
	if err != nil {
		return err
	}
	reader := bufio.NewReader(os.Stdin)

	fmt.Println("╔══════════════════════════════════════════════════════════════════╗")
	fmt.Println("║  Wokwi Offline Suite — Interactive TUI (RC Car & Hardware Setup) ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝")
	fmt.Println("  1) Generate RC Car / Custom Hardware Project (wokwi.toml + diagram.json)")
	fmt.Println("  2) Run Full Offline Environment Setup (Extension + Bundle + License + MCP)")
	fmt.Println("  3) Run Both (Full Offline Setup + Hardware Project Generator)")
	fmt.Println("  4) Load & Overwrite your own user.tok (Manual, no LLM required)")
	choice := promptLine(reader, "Select action (1/2/3/4)", "3")

	if choice == "4" {
		fmt.Println("\n--- Manual user.tok Loader & Overwrite (No LLM) ---")
		home, _ := os.UserHomeDir()
		curTok := filepath.Join(home, ".wokwi", "user.tok")
		if raw, err := os.ReadFile(curTok); err == nil {
			meta := parseUserTokMetadata(string(raw))
			fmt.Printf("Current ~/.wokwi/user.tok: %s <%s> (Plan: %s, Expires: %s)\n", meta["name"], meta["email"], meta["plan"], meta["expiration"])
		}
		src := promptLine(reader, "Enter path to your custom .tok file OR paste raw key= / token string", "")
		if strings.TrimSpace(src) == "" {
			return fmt.Errorf("no user.tok path or content provided")
		}
		var res map[string]interface{}
		var err error
		resolved := expandHome(src)
		if info, statErr := os.Stat(resolved); statErr == nil && !info.IsDir() {
			res, err = overwriteUserTok(resolved, "", true)
		} else {
			res, err = overwriteUserTok("", src, true)
		}
		if err != nil {
			return err
		}
		fmt.Println("[+] " + res["message"].(string))
		return nil
	}

	if choice == "2" || choice == "3" {
		fmt.Println("\n--- Offline Environment & License Setup ---")
		bundle := promptLine(reader, "Path to offline bundle.wpk", "~/.wokwi/bundle.wpk")
		lic := promptLine(reader, "Valid Wokwi license key or path to user.tok", "~/.wokwi/user.tok")
		mcp := promptLine(reader, "MCP clients to install (t3 anthropic opencode codex antigravity vscode all none)", "t3 anthropic")
		var targets []string
		if mcp != "none" {
			targets = strings.Fields(mcp)
		}
		msg, _ := runFullEnvironmentSetup(root, bundle, lic, targets)
		fmt.Println("[+] " + msg)
	}

	if choice == "1" || choice == "3" {
		fmt.Println("\n--- Hardware & wokwi.toml Generator (RC Car / Custom) ---")
		preset := promptLine(reader, "Select base preset (rc-car / esp32calc / zero)", "rc-car")
		counts := map[string]int{}
		for _, el := range cat.Elements {
			if p, ok := cat.Presets[preset]; ok {
				counts[el.ID] = p.Counts[el.ID]
			} else if preset == "zero" {
				counts[el.ID] = 0
			} else {
				counts[el.ID] = el.DefaultCnt
			}
		}

		fmt.Println("\nConfigure quantity (N) for each element (press Enter to keep preset value):")
		for _, el := range cat.Elements {
			valStr := promptLine(reader, fmt.Sprintf("  %s (%s)", el.Name, el.WokwiType), strconv.Itoa(counts[el.ID]))
			if v, err := strconv.Atoi(valStr); err == nil && v >= 0 {
				counts[el.ID] = v
			}
		}

		impAns := promptLine(reader, "\nImport an additional custom element/chip? (y/N)", "N")
		if strings.HasPrefix(strings.ToLower(impAns), "y") {
			cid := promptLine(reader, "  Custom Element ID / Chip Name", "custom_part")
			cname := promptLine(reader, "  Display Name", cid)
			ctype := promptLine(reader, "  Wokwi Type (chip-<name> or wokwi-<part>)", "chip-"+cid)
			cpins := promptLine(reader, "  Pins (comma-separated)", "VCC,GND,SIG")
			ccntStr := promptLine(reader, "  Quantity (N)", "1")
			ccnt, _ := strconv.Atoi(ccntStr)
			if ccnt < 1 {
				ccnt = 1
			}
			cat.Elements = append(cat.Elements, CatalogElement{
				ID:        cid,
				Name:      cname,
				Category:  "Imported Custom",
				WokwiType: ctype,
				IDPrefix:  cid,
				Pins:      strings.Split(cpins, ","),
				Specs:     ElementSpecs{Notes: "Imported via TUI"},
			})
			counts[cid] = ccnt
		}

		outDir := promptLine(reader, "\nTarget project folder to write wokwi.toml & diagram.json", "./rc-car-wokwi")
		fw := promptLine(reader, "Firmware path", "build/firmware.bin")
		elf := promptLine(reader, "ELF path", "build/firmware.elf")
		copied, err := generateProjectFromCounts(root, outDir, cat, counts, fw, elf, 4000, 3333, 12, true)
		if err != nil {
			return err
		}
		fmt.Printf("\n[+] Generated wokwi.toml, diagram.json, and copied %v into %s\n", copied, outDir)
	}
	return nil
}

func main() {
	guiMode := flag.Bool("gui", false, "Launch interactive Browser/Desktop GUI")
	tuiMode := flag.Bool("tui", false, "Launch interactive Terminal UI (TUI)")
	cliMode := flag.Bool("cli", false, "Run in non-interactive CLI mode")
	port := flag.Int("port", 47130, "Port for GUI mode")
	preset := flag.String("preset", "rc-car", "Hardware preset for CLI mode (rc-car, esp32calc, zero)")
	countsArg := flag.String("counts", "", "Comma-separated id=N overrides (e.g. yb_p20m=2,jgb37_520=4,irf520_pwm=4)")
	outDir := flag.String("out", "", "Output project folder to generate wokwi.toml & diagram.json")
	firmware := flag.String("firmware", "build/firmware.bin", "Firmware path in wokwi.toml")
	elf := flag.String("elf", "build/firmware.elf", "ELF path in wokwi.toml")
	bundle := flag.String("bundle", "", "Path to offline bundle.wpk")
	license := flag.String("license", "", "Valid Wokwi license key or path to user.tok")
	loadTok := flag.String("load-user-tok", "", "Manually load and overwrite ~/.wokwi/user.tok from file path or raw token (no LLM)")
	overwriteTok := flag.String("overwrite-user-tok", "", "Alias for --load-user-tok: overwrite ~/.wokwi/user.tok from file path or raw token")
	mcp := flag.String("mcp", "", "Space/comma separated MCP targets to install")
	flag.Parse()

	root := resolveInstallerRoot()

	tokInput := strings.TrimSpace(*loadTok)
	if tokInput == "" {
		tokInput = strings.TrimSpace(*overwriteTok)
	}
	if tokInput != "" {
		var res map[string]interface{}
		var err error
		resolved := expandHome(tokInput)
		if info, statErr := os.Stat(resolved); statErr == nil && !info.IsDir() {
			res, err = overwriteUserTok(resolved, "", true)
		} else {
			res, err = overwriteUserTok("", tokInput, true)
		}
		if err != nil {
			fmt.Fprintf(os.Stderr, "user.tok overwrite error: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("[+] " + res["message"].(string))
		if *outDir == "" && *countsArg == "" && *bundle == "" && *license == "" && *mcp == "" && !*guiMode && !*tuiMode {
			return
		}
	}

	if *tuiMode {
		if err := runTUI(root); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if *cliMode || *outDir != "" || *countsArg != "" || *bundle != "" || *license != "" || *mcp != "" {
		if *bundle != "" || *license != "" || *mcp != "" {
			targets := strings.Fields(strings.ReplaceAll(*mcp, ",", " "))
			msg, err := runFullEnvironmentSetup(root, *bundle, *license, targets)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Setup error: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("[+] " + msg)
		}
		if *outDir != "" || *countsArg != "" {
			cat, err := loadCatalog(root)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Catalog error: %v\n", err)
				os.Exit(1)
			}
			counts := map[string]int{}
			if p, ok := cat.Presets[*preset]; ok {
				for k, v := range p.Counts {
					counts[k] = v
				}
			}
			if *countsArg != "" {
				for _, kv := range strings.Split(*countsArg, ",") {
					parts := strings.SplitN(strings.TrimSpace(kv), "=", 2)
					if len(parts) == 2 {
						if n, err := strconv.Atoi(parts[1]); err == nil {
							counts[parts[0]] = n
						}
					}
				}
			}
			target := *outDir
			if target == "" {
				target = "./rc-car-wokwi"
			}
			copied, err := generateProjectFromCounts(root, target, cat, counts, *firmware, *elf, 4000, 3333, 12, true)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Generate error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("[+] Generated wokwi.toml & diagram.json in %s (chips: %v)\n", target, copied)
		}
		return
	}

	// Default to GUI mode (or if --gui passed)
	_ = guiMode
	if err := runGUIServer(root, *port); err != nil {
		fmt.Fprintf(os.Stderr, "GUI error: %v\n", err)
		os.Exit(1)
	}
}
