// Package main builds a C shared library (.so/.dylib/.dll) exposing the Yaver SDK.
//
// Build:
//   go build -buildmode=c-shared -o libyaver.so ./sdk/go/clib/
//   go build -buildmode=c-shared -o libyaver.dylib ./sdk/go/clib/  (macOS)
//
// The generated header file (libyaver.h) can be used from C/C++.
// Python can load the .so via ctypes.
package main

// #include <stdlib.h>
import "C"
import (
	"encoding/json"
	"sync"
	"time"
	"unsafe"

	yaver "github.com/kivanccakmak/yaver.io/sdk/go/yaver"
)

var (
	clients   = map[int]*yaver.Client{}
	authClients = map[int]*yaver.AuthClient{}
	nextID    = 1
	mu        sync.Mutex
)

//export YaverNewClient
func YaverNewClient(baseURL, authToken *C.char) C.int {
	mu.Lock()
	defer mu.Unlock()
	id := nextID
	nextID++
	clients[id] = yaver.NewClient(C.GoString(baseURL), C.GoString(authToken))
	return C.int(id)
}

//export YaverFreeClient
func YaverFreeClient(id C.int) {
	mu.Lock()
	defer mu.Unlock()
	delete(clients, int(id))
}

//export YaverHealth
func YaverHealth(id C.int) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}
	if err := c.Health(); err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	return C.CString(`{"ok":true}`)
}

//export YaverPing
func YaverPing(id C.int) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}
	rtt, err := c.Ping()
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	return C.CString(`{"ok":true,"rtt_ms":` + itoa(rtt.Milliseconds()) + `}`)
}

//export YaverCreateTask
func YaverCreateTask(id C.int, prompt *C.char, optsJSON *C.char) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}

	var opts *yaver.CreateTaskOptions
	if optsJSON != nil {
		optStr := C.GoString(optsJSON)
		if optStr != "" {
			opts = &yaver.CreateTaskOptions{}
			json.Unmarshal([]byte(optStr), opts)
		}
	}

	task, err := c.CreateTask(C.GoString(prompt), opts)
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	data, _ := json.Marshal(task)
	return C.CString(string(data))
}

//export YaverGetTask
func YaverGetTask(id C.int, taskID *C.char) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}
	task, err := c.GetTask(C.GoString(taskID))
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	data, _ := json.Marshal(task)
	return C.CString(string(data))
}

//export YaverListTasks
func YaverListTasks(id C.int) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}
	tasks, err := c.ListTasks()
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	data, _ := json.Marshal(tasks)
	return C.CString(string(data))
}

//export YaverStopTask
func YaverStopTask(id C.int, taskID *C.char) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}
	if err := c.StopTask(C.GoString(taskID)); err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	return C.CString(`{"ok":true}`)
}

//export YaverDeleteTask
func YaverDeleteTask(id C.int, taskID *C.char) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}
	if err := c.DeleteTask(C.GoString(taskID)); err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	return C.CString(`{"ok":true}`)
}

//export YaverContinueTask
func YaverContinueTask(id C.int, taskID, message *C.char) *C.char {
	mu.Lock()
	c := clients[int(id)]
	mu.Unlock()
	if c == nil {
		return C.CString(`{"error":"invalid client"}`)
	}
	if err := c.ContinueTask(C.GoString(taskID), C.GoString(message), nil); err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	return C.CString(`{"ok":true}`)
}

// ── Auth ─────────────────────────────────────────────────────────────

//export YaverNewAuthClient
func YaverNewAuthClient(convexURL, authToken *C.char) C.int {
	mu.Lock()
	defer mu.Unlock()
	id := nextID
	nextID++
	authClients[id] = yaver.NewAuthClient(C.GoString(convexURL), C.GoString(authToken))
	return C.int(id)
}

//export YaverValidateToken
func YaverValidateToken(id C.int) *C.char {
	mu.Lock()
	a := authClients[int(id)]
	mu.Unlock()
	if a == nil {
		return C.CString(`{"error":"invalid auth client"}`)
	}
	user, err := a.ValidateToken()
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	data, _ := json.Marshal(user)
	return C.CString(string(data))
}

//export YaverListDevices
func YaverListDevices(id C.int) *C.char {
	mu.Lock()
	a := authClients[int(id)]
	mu.Unlock()
	if a == nil {
		return C.CString(`{"error":"invalid auth client"}`)
	}
	devices, err := a.ListDevices()
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	data, _ := json.Marshal(devices)
	return C.CString(string(data))
}

// ── Config ───────────────────────────────────────────────────────────

//export YaverLoadConfig
func YaverLoadConfig() *C.char {
	cfg, err := yaver.LoadConfig()
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	data, _ := json.Marshal(cfg)
	return C.CString(string(data))
}

// ── Speech ───────────────────────────────────────────────────────────

//export YaverTranscribe
func YaverTranscribe(audioPath, provider, apiKey *C.char) *C.char {
	cfg := &yaver.SpeechConfig{
		Provider: C.GoString(provider),
		APIKey:   C.GoString(apiKey),
	}
	tr := yaver.NewTranscriber(cfg)
	result, err := tr.Transcribe(C.GoString(audioPath))
	if err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	data, _ := json.Marshal(result)
	return C.CString(string(data))
}

//export YaverSpeak
func YaverSpeak(text *C.char) *C.char {
	if err := yaver.Speak(C.GoString(text)); err != nil {
		return C.CString(`{"error":"` + err.Error() + `"}`)
	}
	return C.CString(`{"ok":true}`)
}

// ── Helpers ──────────────────────────────────────────────────────────

//export YaverFreeString
func YaverFreeString(s *C.char) {
	C.free(unsafe.Pointer(s))
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	s := ""
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		s = string(rune('0'+n%10)) + s
		n /= 10
	}
	if neg {
		s = "-" + s
	}
	return s
}

// Keep _ to avoid unused import warnings
var _ = time.Now

func main() {}
