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

	home, _ := os.UserHomeDir()
	wokwiBin := filepath.Join(home, ".wokwi", "bin")
	pioWin := filepath.Join(home, ".platformio", "penv", "Scripts")
	pioUnix := filepath.Join(home, ".platformio", "penv", "bin")

	settings["terminal.integrated.env.windows"] = map[string]string{
		"PATH": fmt.Sprintf("%s;%s;${env:PATH}", wokwiBin, pioWin),
	}
	settings["terminal.integrated.env.osx"] = map[string]string{
		"PATH": fmt.Sprintf("%s:%s:${env:PATH}", wokwiBin, pioUnix),
	}
	settings["terminal.integrated.env.linux"] = map[string]string{
		"PATH": fmt.Sprintf("%s:%s:${env:PATH}", wokwiBin, pioUnix),
	}

	out, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(sPath, append(out, '\n'), 0644)
}

func installPioWrapperAndFallbacks(root string) error {
	home, _ := os.UserHomeDir()
	wokwiDir := filepath.Join(home, ".wokwi")
	fbDst := filepath.Join(wokwiDir, "firmware-fallbacks")
	binDir := filepath.Join(wokwiDir, "bin")
	_ = os.MkdirAll(fbDst, 0755)
	_ = os.MkdirAll(binDir, 0755)

	srcFb := filepath.Join(root, "firmware-fallbacks")
	if info, err := os.Stat(srcFb); err == nil && info.IsDir() {
		_ = copyDirRecursive(srcFb, fbDst)
	}

	unixScript := "#!/usr/bin/env sh\nexec node \"$HOME/.wokwi/firmware-fallbacks/pio-fallback.js\" \"$@\"\n"
	winScript := "@echo off\r\nnode \"%USERPROFILE%\\.wokwi\\firmware-fallbacks\\pio-fallback.js\" %*\r\n"

	for _, name := range []string{"pio", "platformio"} {
		uPath := filepath.Join(binDir, name)
		_ = os.WriteFile(uPath, []byte(unixScript), 0755)
		_ = os.Chmod(uPath, 0755)
		wPath := filepath.Join(binDir, name+".cmd")
		_ = os.WriteFile(wPath, []byte(winScript), 0644)
	}
	return nil
}

func provisionFirmwareFallbacksToProject(root, targetDir string) ([]string, error) {
	home, _ := os.UserHomeDir()
	fbDir := filepath.Join(root, "firmware-fallbacks")
	if _, err := os.Stat(filepath.Join(fbDir, "firmware.bin")); err != nil {
		fbDir = filepath.Join(home, ".wokwi", "firmware-fallbacks")
	}
	var provisioned []string
	binFiles := []string{"bootloader.bin", "partitions.bin", "firmware.bin"}
	destDirs := []string{
		filepath.Join(targetDir, "build"),
		filepath.Join(targetDir, ".pio", "build", "esp32-s3-wokwi"),
		filepath.Join(targetDir, ".pio", "build", "esp32-s3-n16r16"),
	}
	for _, d := range destDirs {
		_ = os.MkdirAll(d, 0755)
		for _, bf := range binFiles {
			src := filepath.Join(fbDir, bf)
			dst := filepath.Join(d, bf)
			if _, err := os.Stat(src); err == nil {
				if _, dstErr := os.Stat(dst); dstErr != nil {
					if copyFile(src, dst) == nil {
						rel, _ := filepath.Rel(targetDir, dst)
						provisioned = append(provisioned, rel)
					}
				}
			}
		}
	}
	flasherSrc := filepath.Join(fbDir, "flasher_args.json")
	flasherDst := filepath.Join(targetDir, "flasher_args.json")
	if _, err := os.Stat(flasherSrc); err == nil {
		if _, dstErr := os.Stat(flasherDst); dstErr != nil {
			if copyFile(flasherSrc, flasherDst) == nil {
				provisioned = append(provisioned, "flasher_args.json")
			}
		}
	}
	batDst := filepath.Join(targetDir, "build_wokwi.bat")
	if _, err := os.Stat(batDst); err != nil {
		batContent := "@echo off\r\ncd /d \"%~dp0\"\r\nnode \"%USERPROFILE%\\.wokwi\\firmware-fallbacks\\pio-fallback.js\" run -e esp32-s3-wokwi %*\r\n"
		_ = os.WriteFile(batDst, []byte(batContent), 0644)
	}
	shDst := filepath.Join(targetDir, "build_wokwi.sh")
	if _, err := os.Stat(shDst); err != nil {
		shContent := "#!/usr/bin/env sh\nset -eu\ncd \"$(dirname \"$0\")\"\nnode \"$HOME/.wokwi/firmware-fallbacks/pio-fallback.js\" run -e esp32-s3-wokwi \"$@\"\n"
		_ = os.WriteFile(shDst, []byte(shContent), 0755)
		_ = os.Chmod(shDst, 0755)
	}
	return provisioned, nil
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

const defaultInternalTestingUserTok = `# Wokwi License
# User: user@wokwi.com
# Email: user@wokwi.com

key=JnU9MSZuPXVzZXIlNDB3b2t3aS5jb20mZT11c2VyJTQwd29rd2kuY29tJng9OTk5OTEyMzEmZj02JnA9cHJvAH6_SOgpZf71EV65AdppzsQTPQnKyNl62O6aant4anVZrtWxMWERtlCXJeT4u8ohffAs2vFgVE7OEji4BrsCv1Ghqe0y0_SfFgDkJRBHAOjs8_S_PXyBF48eJIoNilR9mYzMV0gc9T23LkMfCw924GX2KZsmYmonNqqxlBoYvcCQE4XzyJ5XRc6KdS19cUOqOCN8_PT0i_SXigM_Sc7Icv4mZ2n9sirnhkL532gLDuE7KQXOiZQROY8x6aPTlj8pRJ_PvkmNGMgs_S8NWoR0S_PdUwRFjMz11d596Wykap8qNxGwlysPu39dZngSvg8Px1UwEBNXq904J_SkglXXkR4wqL21QCoD64=
ts=1779483231117
`

func ensureDefaultTestingAssets(root string) {
	home, _ := os.UserHomeDir()
	wokwiDir := filepath.Join(home, ".wokwi")
	_ = os.MkdirAll(wokwiDir, 0755)
	_ = installPioWrapperAndFallbacks(root)

	destBundle := filepath.Join(wokwiDir, "bundle.wpk")
	if _, err := os.Stat(destBundle); err != nil {
		for _, cand := range []string{
			filepath.Join(root, "files", "bundle.wpk"),
			filepath.Join(wokwiDir, "files", "bundle.wpk"),
		} {
			if info, err := os.Stat(cand); err == nil && !info.IsDir() {
				_ = copyFile(cand, destBundle)
				break
			}
		}
	}

	destTok := filepath.Join(wokwiDir, "user.tok")
	if raw, err := os.ReadFile(destTok); err != nil || len(bytes.TrimSpace(raw)) == 0 {
		for _, cand := range []string{
			filepath.Join(root, "files", "user.tok"),
			filepath.Join(wokwiDir, "files", "user.tok"),
		} {
			if b, err := os.ReadFile(cand); err == nil && len(bytes.TrimSpace(b)) > 0 {
				_ = os.WriteFile(destTok, b, 0600)
				return
			}
		}
		_ = os.WriteFile(destTok, []byte(defaultInternalTestingUserTok), 0600)
	}
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

func updateVsCodeExtensionsManifest(extensionsRoot, version string) {
	manifestPath := filepath.Join(extensionsRoot, "extensions.json")
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return
	}
	var entries []map[string]interface{}
	if err := json.Unmarshal(raw, &entries); err != nil {
		return
	}
	relLoc := "wokwi.wokwi-vscode-" + version
	fullPath := filepath.Join(extensionsRoot, relLoc)
	found := false
	for i := range entries {
		if idObj, ok := entries[i]["identifier"].(map[string]interface{}); ok {
			if strings.EqualFold(fmt.Sprint(idObj["id"]), "wokwi.wokwi-vscode") {
				entries[i]["version"] = version
				entries[i]["relativeLocation"] = relLoc
				if locObj, ok := entries[i]["location"].(map[string]interface{}); ok {
					locObj["path"] = filepath.ToSlash(fullPath)
					locObj["fsPath"] = fullPath
				}
				found = true
			}
		}
	}
	if !found {
		entries = append(entries, map[string]interface{}{
			"identifier": map[string]interface{}{"id": "wokwi.wokwi-vscode"},
			"version":    version,
			"location": map[string]interface{}{
				"$mid":   1,
				"fsPath": fullPath,
				"path":   filepath.ToSlash(fullPath),
				"scheme": "file",
			},
			"relativeLocation": relLoc,
			"metadata": map[string]interface{}{
				"installedTimestamp": time.Now().UnixMilli(),
				"pinned":             true,
				"source":             "vsix",
			},
		})
	}
	if out, err := json.Marshal(entries); err == nil {
		_ = os.WriteFile(manifestPath, out, 0644)
	}
}

func runFullEnvironmentSetup(root, extVersion, bundlePath, licenseInput string, mcpTargets []string) (string, error) {
	if extVersion != "4.1.0" {
		extVersion = "3.7.0"
	}
	ensureDefaultTestingAssets(root)
	home, _ := os.UserHomeDir()
	wokwiDir := filepath.Join(home, ".wokwi")
	extensionsRoot := filepath.Join(home, ".vscode", "extensions")
	extDir := filepath.Join(extensionsRoot, "wokwi.wokwi-vscode-"+extVersion)
	otherVer := "4.1.0"
	if extVersion == "4.1.0" {
		otherVer = "3.7.0"
	}
	otherExtDir := filepath.Join(extensionsRoot, "wokwi.wokwi-vscode-"+otherVer)
	cacheDir := filepath.Join(extDir, ".cache")

	var summary []string

	// Remove other version folder so VS Code loads the selected version cleanly
	_ = os.RemoveAll(otherExtDir)

	// 1. Copy selected extension & hardware & MCP
	srcExtDir := filepath.Join(root, "extension-"+extVersion)
	if _, err := os.Stat(srcExtDir); err != nil {
		srcExtDir = filepath.Join(root, "extension")
	}
	if err := copyDirRecursive(srcExtDir, extDir); err == nil {
		updateVsCodeExtensionsManifest(extensionsRoot, extVersion)
		summary = append(summary, fmt.Sprintf("Installed offline-first Wokwi v%s extension to %s", extVersion, extDir))
	}
	if err := copyDirRecursive(filepath.Join(root, "mcp"), filepath.Join(wokwiDir, "mcp")); err == nil {
		summary = append(summary, "Installed Wokwi Offline MCP to "+filepath.Join(wokwiDir, "mcp"))
	}
	if err := copyDirRecursive(filepath.Join(root, "hardware"), filepath.Join(wokwiDir, "hardware-elements")); err == nil {
		summary = append(summary, "Installed RC Car & ESP32Calc hardware elements to "+filepath.Join(wokwiDir, "hardware-elements"))
	}
	if err := installPioWrapperAndFallbacks(root); err == nil {
		summary = append(summary, "Installed cross-platform pio wrapper (~/.wokwi/bin) & ESP32-S3 .bin fallbacks (~/.wokwi/firmware-fallbacks)")
	}

	// 2. Disable VS Code extension auto-update
	if err := disableVsCodeAutoUpdate(); err == nil {
		summary = append(summary, "Disabled VS Code extension auto-update in settings.json")
	}

	// 3. Extract .wpk bundle (auto-fallback to ~/.wokwi/bundle.wpk, root/files/bundle.wpk, or ~/.wokwi/files/bundle.wpk)
	resolvedBundle := expandHome(strings.TrimSpace(bundlePath))
	if resolvedBundle == "" {
		for _, cand := range []string{
			filepath.Join(wokwiDir, "bundle.wpk"),
			filepath.Join(root, "files", "bundle.wpk"),
			filepath.Join(wokwiDir, "files", "bundle.wpk"),
		} {
			if _, err := os.Stat(cand); err == nil {
				resolvedBundle = cand
				break
			}
		}
	}
	if resolvedBundle != "" {
		destBundle := filepath.Join(wokwiDir, "bundle.wpk")
		if filepath.Clean(resolvedBundle) != filepath.Clean(destBundle) {
			_ = copyFile(resolvedBundle, destBundle)
		}
		if n, err := extractWpkBundle(resolvedBundle, cacheDir); err == nil {
			summary = append(summary, fmt.Sprintf("Extracted %d files from bundle.wpk into %s", n, cacheDir))
		} else {
			summary = append(summary, "Bundle warning: "+err.Error())
		}
	}

	// 4. Save license (auto-fallback to ~/.wokwi/user.tok, root/files/user.tok, or built-in internal testing token)
	resolvedLic := strings.TrimSpace(licenseInput)
	if resolvedLic == "" {
		for _, cand := range []string{
			filepath.Join(wokwiDir, "user.tok"),
			filepath.Join(root, "files", "user.tok"),
			filepath.Join(wokwiDir, "files", "user.tok"),
		} {
			if _, err := os.Stat(cand); err == nil {
				resolvedLic = cand
				break
			}
		}
	}
	if resolvedLic == "" {
		resolvedLic = defaultInternalTestingUserTok
	}
	if resolvedLic != "" {
		if msg, err := saveLicenseToken(resolvedLic); err == nil && msg != "" {
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

	if prov, err := provisionFirmwareFallbacksToProject(root, targetDir); err == nil {
		copiedChips = append(copiedChips, prov...)
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

func runGUIServer(root string, port int, noBrowser bool) error {
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
		if prov, err := provisionFirmwareFallbacksToProject(root, target); err == nil {
			copied = append(copied, prov...)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":          true,
			"targetDir":   target,
			"copiedChips": copied,
		})
	})

	mux.HandleFunc("/api/fix-project", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		var req struct {
			TargetDir string `json:"targetDir"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		target := expandHome(strings.TrimSpace(req.TargetDir))
		if target == "" {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "empty project directory"})
			return
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(root, target)
		}
		prov, err := provisionFirmwareFallbacksToProject(root, target)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":          true,
			"targetDir":   target,
			"provisioned": prov,
			"message":     fmt.Sprintf("Provisioned pre-built ESP32-S3 .bin files + cross-platform pio scripts in %s", target),
		})
	})

	mux.HandleFunc("/api/user-tok", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		ensureDefaultTestingAssets(root)
		home, _ := os.UserHomeDir()
		tokPath := filepath.Join(home, ".wokwi", "user.tok")
		if r.Method == http.MethodGet {
			raw, err := os.ReadFile(tokPath)
			if err != nil {
				raw = []byte(defaultInternalTestingUserTok)
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
			FilePath       string `json:"filePath"`
			Content        string `json:"content"`
			Backup         bool   `json:"backup"`
			RestoreDefault bool   `json:"restoreDefault"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		if req.RestoreDefault {
			req.FilePath = ""
			req.Content = defaultInternalTestingUserTok
		}
		res, err := overwriteUserTok(req.FilePath, req.Content, req.Backup)
		if err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(res)
	})

	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		ensureDefaultTestingAssets(root)
		home, _ := os.UserHomeDir()
		wokwiDir := filepath.Join(home, ".wokwi")
		extRoot := filepath.Join(home, ".vscode", "extensions")

		installedVer := ""
		cacheReady := false
		for _, v := range []string{"3.7.0", "4.1.0"} {
			dir := filepath.Join(extRoot, "wokwi.wokwi-vscode-"+v)
			if info, err := os.Stat(dir); err == nil && info.IsDir() {
				installedVer = v
				if _, err := os.Stat(filepath.Join(dir, ".cache", "entry.js")); err == nil {
					cacheReady = true
				}
				break
			}
		}

		detectedBundle := ""
		var bundleSize int64
		for _, cand := range []string{
			filepath.Join(wokwiDir, "bundle.wpk"),
			filepath.Join(root, "files", "bundle.wpk"),
			filepath.Join(wokwiDir, "files", "bundle.wpk"),
		} {
			if info, err := os.Stat(cand); err == nil && !info.IsDir() {
				detectedBundle = cand
				bundleSize = info.Size()
				break
			}
		}

		detectedTok := ""
		var tokContent string
		tokMeta := map[string]string{}
		for _, cand := range []string{
			filepath.Join(wokwiDir, "user.tok"),
			filepath.Join(root, "files", "user.tok"),
			filepath.Join(wokwiDir, "files", "user.tok"),
		} {
			if raw, err := os.ReadFile(cand); err == nil && len(bytes.TrimSpace(raw)) > 0 {
				detectedTok = cand
				tokContent = string(raw)
				tokMeta = parseUserTokMetadata(tokContent)
				break
			}
		}

		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":             true,
			"installedVer":   installedVer,
			"cacheReady":     cacheReady,
			"detectedBundle": detectedBundle,
			"bundleSize":     bundleSize,
			"detectedTok":    detectedTok,
			"tokMetadata":    tokMeta,
		})
	})

	mux.HandleFunc("/api/upload-bundle", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		home, _ := os.UserHomeDir()
		wokwiDir := filepath.Join(home, ".wokwi")
		_ = os.MkdirAll(wokwiDir, 0755)
		dest := filepath.Join(wokwiDir, "bundle.wpk")

		data, err := io.ReadAll(io.LimitReader(r.Body, 256*1024*1024))
		if err != nil || len(data) == 0 {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": "empty or invalid bundle.wpk upload"})
			return
		}
		if err := os.WriteFile(dest, data, 0644); err != nil {
			_ = json.NewEncoder(w).Encode(map[string]interface{}{"ok": false, "error": err.Error()})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"ok":         true,
			"bundlePath": dest,
			"size":       len(data),
		})
	})

	mux.HandleFunc("/api/run-setup", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ExtVersion   string   `json:"extVersion"`
			BundlePath   string   `json:"bundlePath"`
			LicenseInput string   `json:"licenseInput"`
			McpTargets   []string `json:"mcpTargets"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		msg, err := runFullEnvironmentSetup(root, req.ExtVersion, req.BundlePath, req.LicenseInput, req.McpTargets)
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
	if !noBrowser {
		openBrowser(actualURL)
	}
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
	fmt.Println("║  Wokwi Offline Suite — Guided Step-by-Step TUI                   ║")
	fmt.Println("╚══════════════════════════════════════════════════════════════════╝")
	fmt.Println("  1) Guided 3-Step Flow (Step 1: Install Extension & Bundle -> Step 2: Load user.tok -> Step 3: Build wokwi.toml)")
	fmt.Println("  2) Only Step 1: Install Extension (v3.7.0 / v4.1.0), Load bundle.wpk & MCP")
	fmt.Println("  3) Only Step 2: Load & Overwrite user.tok (Manual, no LLM required)")
	fmt.Println("  4) Only Step 3: Choose Hardware Elements & Generate wokwi.toml + diagram.json")
	choice := promptLine(reader, "Select option (1/2/3/4)", "1")

	if choice == "1" || choice == "2" {
		fmt.Println("\n=== STEP 1: Install Wokwi Extension & Load Offline Bundle (bundle.wpk) ===")
		extVer := promptLine(reader, "Select Wokwi VS Code Extension Version to install (3.7.0 / 4.1.0)", "3.7.0")
		bundle := promptLine(reader, "Path to offline bundle.wpk", "~/.wokwi/bundle.wpk")
		mcp := promptLine(reader, "MCP clients to install (t3 anthropic opencode codex antigravity vscode all none)", "t3 anthropic")
		var targets []string
		if mcp != "none" {
			targets = strings.Fields(mcp)
		}
		msg, _ := runFullEnvironmentSetup(root, extVer, bundle, "", targets)
		fmt.Println("[+] " + msg)
	}

	if choice == "1" || choice == "3" {
		fmt.Println("\n=== STEP 2: Load & Overwrite user.tok License (If Needed) ===")
		home, _ := os.UserHomeDir()
		curTok := filepath.Join(home, ".wokwi", "user.tok")
		hasExisting := false
		if raw, err := os.ReadFile(curTok); err == nil && len(bytes.TrimSpace(raw)) > 0 {
			hasExisting = true
			meta := parseUserTokMetadata(string(raw))
			fmt.Printf("Current ~/.wokwi/user.tok detected: %s <%s> (Plan: %s, Expires: %s)\n", meta["name"], meta["email"], meta["plan"], meta["expiration"])
		}
		promptMsg := "Enter path to custom .tok file OR paste raw key= string"
		defVal := ""
		if hasExisting && choice == "1" {
			promptMsg = "Enter path/key to overwrite user.tok, or press Enter to keep existing user.tok"
			defVal = "keep"
		}
		src := promptLine(reader, promptMsg, defVal)
		if strings.TrimSpace(src) != "" && src != "keep" {
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
		} else if hasExisting {
			fmt.Println("[+] Keeping existing ~/.wokwi/user.tok")
		}
	}

	if choice == "1" || choice == "4" {
		fmt.Println("\n=== STEP 3: Choose Hardware Elements & Generate wokwi.toml + diagram.json ===")
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
	noBrowser := flag.Bool("no-browser", false, "Do not auto-open browser window when starting GUI server")
	tuiMode := flag.Bool("tui", false, "Launch interactive Terminal UI (TUI)")
	cliMode := flag.Bool("cli", false, "Run in non-interactive CLI mode")
	port := flag.Int("port", 47130, "Port for GUI mode")
	preset := flag.String("preset", "rc-car", "Hardware preset for CLI mode (rc-car, esp32calc, zero)")
	countsArg := flag.String("counts", "", "Comma-separated id=N overrides (e.g. yb_p20m=2,jgb37_520=4,irf520_pwm=4)")
	outDir := flag.String("out", "", "Output project folder to generate wokwi.toml & diagram.json")
	firmware := flag.String("firmware", "build/firmware.bin", "Firmware path in wokwi.toml")
	elf := flag.String("elf", "build/firmware.elf", "ELF path in wokwi.toml")
	extVer := flag.String("ext-version", "3.7.0", "Wokwi VS Code extension version to install (3.7.0 or 4.1.0)")
	bundle := flag.String("bundle", "", "Path to offline bundle.wpk")
	license := flag.String("license", "", "Valid Wokwi license key or path to user.tok")
	loadTok := flag.String("load-user-tok", "", "Manually load and overwrite ~/.wokwi/user.tok from file path or raw token (no LLM)")
	overwriteTok := flag.String("overwrite-user-tok", "", "Alias for --load-user-tok: overwrite ~/.wokwi/user.tok from file path or raw token")
	fixProj := flag.String("fix-project", "", "Populate pre-built ESP32-S3 .bin files + cross-platform pio fallback scripts in existing project (e.g. XCasFW)")
	mcp := flag.String("mcp", "", "Space/comma separated MCP targets to install")
	flag.Parse()

	root := resolveInstallerRoot()

	if strings.TrimSpace(*fixProj) != "" {
		target := expandHome(strings.TrimSpace(*fixProj))
		prov, err := provisionFirmwareFallbacksToProject(root, target)
		if err != nil {
			fmt.Fprintf(os.Stderr, "fix-project error: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("[+] Provisioned pre-built .bin firmware & cross-platform pio scripts in %s: %v\n", target, prov)
		if *outDir == "" && *countsArg == "" && *bundle == "" && *license == "" && *mcp == "" && !*guiMode && !*tuiMode {
			return
		}
	}

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
		if *bundle != "" || *license != "" || *mcp != "" || (*cliMode && *outDir == "" && *countsArg == "") {
			targets := strings.Fields(strings.ReplaceAll(*mcp, ",", " "))
			msg, err := runFullEnvironmentSetup(root, *extVer, *bundle, *license, targets)
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
	if err := runGUIServer(root, *port, *noBrowser); err != nil {
		fmt.Fprintf(os.Stderr, "GUI error: %v\n", err)
		os.Exit(1)
	}
}
