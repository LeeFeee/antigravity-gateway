package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type harness struct {
	t      *testing.T
	input  *io.PipeWriter
	events chan event
	done   chan error
	mu     sync.Mutex
}

func newHarness(t *testing.T, client *http.Client) *harness {
	t.Helper()
	in, iw := io.Pipe()
	out, ow := io.Pipe()
	h := &harness{t: t, input: iw, events: make(chan event, 128), done: make(chan error, 1)}
	go func() {
		h.done <- run(in, ow, client)
		ow.Close()
	}()
	go func() {
		defer close(h.events)
		s := bufio.NewScanner(out)
		for s.Scan() {
			var e event
			if json.Unmarshal(s.Bytes(), &e) == nil {
				h.events <- e
			}
		}
	}()
	if e := h.next(); e.Type != "ready" || e.Protocol != 1 {
		t.Fatalf("invalid startup: %#v", e)
	}
	t.Cleanup(func() {
		iw.Close()
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
			t.Error("helper failed to terminate after stdin EOF")
		}
	})
	return h
}

func (h *harness) send(c command) {
	h.t.Helper()
	h.mu.Lock()
	defer h.mu.Unlock()
	if err := json.NewEncoder(h.input).Encode(c); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) next() event {
	h.t.Helper()
	select {
	case e, ok := <-h.events:
		if !ok {
			h.t.Fatal("transport exited unexpectedly")
		}
		return e
	case <-time.After(5 * time.Second):
		h.t.Fatal("transport event timeout")
		return event{}
	}
}

func TestChunkedRequestAndCreditBoundedResponse(t *testing.T) {
	observed := make(chan *http.Request, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"test":true}` {
			t.Errorf("incorrect body: %q", body)
		}
		observed <- r
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, strings.Repeat("x", 100000))
	}))
	defer server.Close()
	client, err := newClient()
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, client)
	h.send(command{Type: "request", ID: "stream", URL: server.URL, Method: "POST",
		Headers: map[string]string{"User-Agent": "agy-test", "Content-Type": "application/json"}, Body: `{"test":true}`})
	if e := h.next(); e.Type != "headers" || e.Status != 200 {
		t.Fatalf("invalid headers: %#v", e)
	}
	r := <-observed
	if r.Proto != "HTTP/1.1" || len(r.TransferEncoding) != 1 || r.TransferEncoding[0] != "chunked" || r.ContentLength != -1 {
		t.Fatalf("not the observed agy request framing: %#v", r)
	}
	if r.Header.Get("Accept-Encoding") != "gzip" || r.Header.Get("Accept") != "" {
		t.Fatal("unexpected automatic request headers")
	}
	select {
	case e := <-h.events:
		t.Fatalf("body sent without credit: %#v", e)
	case <-time.After(20 * time.Millisecond):
	}
	chunks := 0
	for {
		h.send(command{Type: "credit", ID: "stream"})
		e := h.next()
		if e.Type == "end" {
			break
		}
		if e.Type != "data" {
			t.Fatalf("unexpected stream event: %#v", e)
		}
		chunks++
	}
	if chunks < 3 {
		t.Fatal("response was buffered instead of streamed")
	}
}

func TestCancellationUnblocksActiveRequest(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	client, _ := newClient()
	h := newHarness(t, client)
	h.send(command{Type: "request", ID: "cancel", URL: server.URL})
	<-started
	h.send(command{Type: "cancel", ID: "cancel"})
	if e := h.next(); e.Type != "error" || e.Code != "request_aborted" {
		t.Fatalf("unexpected cancellation: %#v", e)
	}
}

func TestCapturedMetadataHasContentLengthInsteadOfGenerationChunks(t *testing.T) {
	for _, endpoint := range []string{"fetchAvailableModels", "retrieveUserQuotaSummary", "loadCodeAssist", "fetchUserInfo", "fetchAdminControls", "listExperiments"} {
		t.Run(endpoint, func(t *testing.T) {
			const body = `{"project":"测试-project"}`
			observed := make(chan *http.Request, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				data, _ := io.ReadAll(r.Body)
				if string(data) != body {
					t.Errorf("metadata bytes changed: %q", data)
				}
				observed <- r
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()
			client, err := newClient()
			if err != nil {
				t.Fatal(err)
			}
			h := newHarness(t, client)
			h.send(command{Type: "request", ID: "metadata", URL: server.URL + "/v1internal:" + endpoint, Method: "POST", Body: body})
			if e := h.next(); e.Type != "headers" || e.Status != 204 {
				t.Fatalf("unexpected response: %#v", e)
			}
			r := <-observed
			if len(r.TransferEncoding) != 0 || r.ContentLength != int64(len(body)) {
				t.Fatalf("metadata framing differs from real agy capture: length=%d encoding=%v", r.ContentLength, r.TransferEncoding)
			}
			h.send(command{Type: "cancel", ID: "metadata"})
		})
	}
}

func TestRedirectDoesNotForwardAuthorization(t *testing.T) {
	visited := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { visited = true }))
	defer target.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer source.Close()
	client, _ := newClient()
	h := newHarness(t, client)
	h.send(command{Type: "request", ID: "redirect", URL: source.URL, Headers: map[string]string{"Authorization": "Bearer secret"}})
	if e := h.next(); e.Status != 302 {
		t.Fatalf("redirect was followed: %#v", e)
	}
	h.send(command{Type: "cancel", ID: "redirect"})
	if visited {
		t.Fatal("authorization reached another origin")
	}
}
