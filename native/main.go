// Native Cloud Code transport. Credentials travel only over inherited pipes;
// the helper has no listening socket and never logs request headers or bodies.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"
)

const protocolVersion = 1
const maxCommandBytes = 256 << 20

func capturedMetadataPath(path string) bool {
	switch path {
	case "/v1internal:fetchAvailableModels", "/v1internal:retrieveUserQuotaSummary",
		"/v1internal:loadCodeAssist", "/v1internal:fetchUserInfo",
		"/v1internal:fetchAdminControls", "/v1internal:listExperiments":
		return true
	default:
		return false
	}
}

type command struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	URL     string            `json:"url"`
	Method  string            `json:"method"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type event struct {
	Type       string              `json:"type"`
	ID         string              `json:"id,omitempty"`
	Protocol   int                 `json:"protocol,omitempty"`
	GoVersion  string              `json:"goVersion,omitempty"`
	Status     int                 `json:"status,omitempty"`
	StatusText string              `json:"statusText,omitempty"`
	Headers    map[string][]string `json:"headers,omitempty"`
	Data       string              `json:"data,omitempty"`
	Code       string              `json:"code,omitempty"`
	Error      string              `json:"error,omitempty"`
}

type activeRequest struct {
	cancel context.CancelFunc
	credit chan struct{}
}

type bridge struct {
	client *http.Client
	writer io.Writer
	output sync.Mutex
	mu     sync.Mutex
	active map[string]*activeRequest
	wg     sync.WaitGroup
}

func certificatePool() (*x509.CertPool, error) {
	// Respect process-scoped extra CAs without turning off certificate checks or
	// changing system trust. Normal execution uses the OS root store.
	files := []string{os.Getenv("NODE_EXTRA_CA_CERTS"), os.Getenv("SSL_CERT_FILE")}
	var pool *x509.CertPool
	for _, file := range files {
		if file == "" {
			continue
		}
		if pool == nil {
			var err error
			pool, err = x509.SystemCertPool()
			if err != nil {
				pool = x509.NewCertPool()
			}
		}
		pem, err := os.ReadFile(file)
		if err != nil || !pool.AppendCertsFromPEM(pem) {
			return nil, errors.New("unable to load configured CA certificates")
		}
	}
	return pool, nil
}

func newClient() (*http.Client, error) {
	roots, err := certificatePool()
	if err != nil {
		return nil, err
	}
	// agy 1.4.2 captures: HTTP/1.1, no ALPN, Go cipher/extension ordering,
	// hybrid ML-KEM groups and no client session ticket cache. Do not clone
	// http.DefaultTransport: it enables HTTP/2 and changes the ClientHello.
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSClientConfig:       &tls.Config{RootCAs: roots},
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 300 * time.Second,
		IdleConnTimeout:       90 * time.Second,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   8,
		ForceAttemptHTTP2:     false,
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			// Never forward an account's authorization to an unexpected origin.
			return http.ErrUseLastResponse
		},
	}, nil
}

func (b *bridge) emit(e event) {
	b.output.Lock()
	defer b.output.Unlock()
	_ = json.NewEncoder(b.writer).Encode(e)
}

func (b *bridge) finish(id string) {
	b.mu.Lock()
	delete(b.active, id)
	b.mu.Unlock()
}

func (b *bridge) start(c command) {
	parsed, err := url.Parse(c.URL)
	if err != nil || parsed.Hostname() == "" || parsed.User != nil ||
		(parsed.Scheme != "https" && parsed.Scheme != "http") {
		b.emit(event{Type: "error", ID: c.ID, Code: "invalid_url", Error: "invalid upstream URL"})
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	a := &activeRequest{cancel: cancel, credit: make(chan struct{}, 1)}
	b.mu.Lock()
	if _, exists := b.active[c.ID]; exists {
		b.mu.Unlock()
		cancel()
		b.emit(event{Type: "error", ID: c.ID, Code: "duplicate_id", Error: "duplicate transport request identifier"})
		return
	}
	b.active[c.ID] = a
	b.mu.Unlock()
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		defer cancel()
		defer b.finish(c.ID)
		method := c.Method
		if method == "" {
			method = http.MethodGet
		}
		var body io.Reader
		if c.Body != "" {
			reader := bytes.NewReader([]byte(c.Body))
			if method == http.MethodPost && capturedMetadataPath(parsed.Path) {
				// Raw agy captures distinguish metadata RPCs (Content-Length)
				// from generation (one HTTP data chunk). A known-length Reader
				// lets net/http emit the captured header order and byte length.
				body = reader
			} else {
				// Preserve the observed generation framing and the existing
				// fallback for paths whose native wire shape is still unknown.
				body = io.NopCloser(reader)
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, c.URL, body)
		if err != nil {
			b.emit(event{Type: "error", ID: c.ID, Code: "invalid_request", Error: "invalid upstream request"})
			return
		}
		for key, value := range c.Headers {
			req.Header.Set(key, value)
		}
		resp, err := b.client.Do(req)
		if err != nil {
			code, message := "upstream_network_error", "native upstream connection failed"
			if errors.Is(err, context.Canceled) {
				code, message = "request_aborted", "upstream request cancelled"
			} else {
				var certificateError *tls.CertificateVerificationError
				var networkError net.Error
				if errors.As(err, &certificateError) {
					code, message = "certificate_verification_failed", "upstream certificate verification failed"
				} else if errors.As(err, &networkError) && networkError.Timeout() {
					code, message = "upstream_timeout", "upstream connection timed out"
				}
			}
			b.emit(event{Type: "error", ID: c.ID, Code: code, Error: message})
			return
		}
		defer resp.Body.Close()
		b.emit(event{Type: "headers", ID: c.ID, Status: resp.StatusCode,
			StatusText: http.StatusText(resp.StatusCode), Headers: resp.Header})
		buf := make([]byte, 32*1024)
		for {
			// At most one response chunk in flight per request. The Node reader
			// grants credit as its consumer reads, including downstream backpressure.
			select {
			case <-ctx.Done():
				b.emit(event{Type: "error", ID: c.ID, Code: "request_aborted", Error: "upstream request cancelled"})
				return
			case <-a.credit:
			}
			n, err := resp.Body.Read(buf)
			if n > 0 {
				b.emit(event{Type: "data", ID: c.ID, Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err == io.EOF {
				b.emit(event{Type: "end", ID: c.ID})
				return
			}
			if err != nil {
				b.emit(event{Type: "error", ID: c.ID, Code: "upstream_read_error", Error: "upstream response read failed"})
				return
			}
		}
	}()
}

func (b *bridge) control(c command) {
	b.mu.Lock()
	a := b.active[c.ID]
	b.mu.Unlock()
	if a == nil {
		return
	}
	if c.Type == "cancel" {
		a.cancel()
	} else if c.Type == "credit" {
		select {
		case a.credit <- struct{}{}:
		default:
		}
	}
}

func run(input io.Reader, output io.Writer, client *http.Client) error {
	b := &bridge{client: client, writer: output, active: make(map[string]*activeRequest)}
	defer func() {
		b.mu.Lock()
		for _, a := range b.active {
			a.cancel()
		}
		b.mu.Unlock()
		b.wg.Wait()
		client.CloseIdleConnections()
	}()
	b.emit(event{Type: "ready", Protocol: protocolVersion, GoVersion: runtime.Version()})
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), maxCommandBytes)
	for scanner.Scan() {
		var c command
		if json.Unmarshal(scanner.Bytes(), &c) != nil || c.ID == "" || len(c.ID) > 128 {
			return errors.New("invalid transport command")
		}
		switch c.Type {
		case "request":
			b.start(c)
		case "credit", "cancel":
			b.control(c)
		default:
			return errors.New("unknown transport command")
		}
	}
	return scanner.Err()
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("antigravity-native/%d %s %s/%s\n", protocolVersion, runtime.Version(), runtime.GOOS, runtime.GOARCH)
		return
	}
	client, err := newClient()
	if err == nil {
		err = run(os.Stdin, os.Stdout, client)
	}
	if err != nil {
		// Error strings above are deliberately static: no URL query, headers,
		// cookies, credentials, or request text is written to stderr.
		fmt.Fprintln(os.Stderr, strings.TrimSpace(err.Error()))
		os.Exit(1)
	}
}
