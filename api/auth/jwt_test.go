package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"github.com/golang-jwt/jwt/v5"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestJWTValidation(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/auth/v1/.well-known/jwks.json" {
			t.Errorf("unexpected JWKS path")
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{"kty": "EC", "crv": "P-256", "alg": "ES256", "kid": "current", "x": base64.RawURLEncoding.EncodeToString(key.X.FillBytes(make([]byte, 32))), "y": base64.RawURLEncoding.EncodeToString(key.Y.FillBytes(make([]byte, 32)))}}})
	}))
	defer server.Close()
	now := time.Now().Truncate(time.Second)
	base := func() jwt.MapClaims {
		return jwt.MapClaims{"iss": server.URL + "/auth/v1", "aud": "authenticated", "sub": "11111111-1111-4111-8111-111111111111", "session_id": "22222222-2222-4222-8222-222222222222", "role": "authenticated", "is_anonymous": false, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()}
	}
	cases := []struct {
		name   string
		mutate func(jwt.MapClaims)
		valid  bool
	}{
		{"valid", func(c jwt.MapClaims) {}, true},
		{"wrong issuer", func(c jwt.MapClaims) { c["iss"] = "https://other/auth/v1" }, false},
		{"wrong audience", func(c jwt.MapClaims) { c["aud"] = "anon" }, false},
		{"invalid subject", func(c jwt.MapClaims) { c["sub"] = "not-uuid" }, false},
		{"missing subject", func(c jwt.MapClaims) { delete(c, "sub") }, false},
		{"missing session", func(c jwt.MapClaims) { delete(c, "session_id") }, false},
		{"invalid session", func(c jwt.MapClaims) { c["session_id"] = "not-uuid" }, false},
		{"service role", func(c jwt.MapClaims) { c["role"] = "service_role" }, false},
		{"anonymous", func(c jwt.MapClaims) { c["is_anonymous"] = true }, false},
		{"missing anonymous", func(c jwt.MapClaims) { delete(c, "is_anonymous") }, false},
		{"expired", func(c jwt.MapClaims) { c["exp"] = now.Add(-31 * time.Second).Unix() }, false},
		{"expiry tolerance", func(c jwt.MapClaims) { c["exp"] = now.Add(-29 * time.Second).Unix() }, true},
		{"missing expiry", func(c jwt.MapClaims) { delete(c, "exp") }, false},
		{"invalid expiry", func(c jwt.MapClaims) { c["exp"] = "tomorrow" }, false},
		{"missing issued", func(c jwt.MapClaims) { delete(c, "iat") }, false},
		{"future issued", func(c jwt.MapClaims) { c["iat"] = now.Add(31 * time.Second).Unix() }, false},
		{"issued tolerance", func(c jwt.MapClaims) { c["iat"] = now.Add(29 * time.Second).Unix() }, true},
		{"future nbf", func(c jwt.MapClaims) { c["nbf"] = now.Add(31 * time.Second).Unix() }, false},
	}
	v, _ := NewVerifier(server.URL)
	v.now = func() time.Time { return now }
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := base()
			tc.mutate(c)
			token := jwt.NewWithClaims(jwt.SigningMethodES256, c)
			token.Header["kid"] = "current"
			raw, _ := token.SignedString(key)
			_, err := v.Verify(context.Background(), raw)
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v err=%v", tc.valid, err)
			}
		})
	}
	for _, alg := range []jwt.SigningMethod{jwt.SigningMethodHS256, jwt.SigningMethodNone, jwt.SigningMethodRS256} {
		t.Run(alg.Alg(), func(t *testing.T) {
			token := jwt.NewWithClaims(alg, base())
			token.Header["kid"] = "current"
			var signingKey any = []byte("not-a-trusted-key")
			if alg == jwt.SigningMethodNone {
				signingKey = jwt.UnsafeAllowNoneSignatureType
			}
			raw, err := token.SignedString(signingKey)
			if err != nil {
				raw = "eyJhbGciOiJSUzI1NiIsImtpZCI6ImN1cnJlbnQifQ.eyJzdWIiOiJhIn0.YQ"
			}
			if _, err = v.Verify(context.Background(), raw); !errors.Is(err, ErrInvalid) {
				t.Fatal("algorithm accepted")
			}
		})
	}
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	for _, kid := range []string{"current", "unknown", ""} {
		token := jwt.NewWithClaims(jwt.SigningMethodES256, base())
		token.Header["kid"] = kid
		raw, _ := token.SignedString(other)
		if _, err := v.Verify(context.Background(), raw); !errors.Is(err, ErrInvalid) {
			t.Fatal("untrusted signature or key accepted")
		}
	}
	if requests.Load() != 1 {
		t.Fatalf("cache did not coalesce: %d", requests.Load())
	}
}

func TestJWKSFailureRotationAndConcurrency(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	kid := "old"
	failure := false
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if failure {
			w.WriteHeader(503)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": []any{map[string]string{"kty": "EC", "crv": "P-256", "alg": "ES256", "kid": kid, "x": base64.RawURLEncoding.EncodeToString(key.X.FillBytes(make([]byte, 32))), "y": base64.RawURLEncoding.EncodeToString(key.Y.FillBytes(make([]byte, 32)))}}})
	}))
	defer server.Close()
	v, _ := NewVerifier(server.URL)
	now := time.Now()
	v.now = func() time.Time { return now }
	var wg sync.WaitGroup
	for range 20 {
		wg.Go(func() {
			if _, err := v.key(context.Background(), "old"); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	if hits.Load() != 1 {
		t.Fatal("concurrent fetches")
	}
	now = now.Add(31 * time.Second)
	kid = "new"
	if _, err := v.key(context.Background(), "new"); err != nil {
		t.Fatal("rotation failed")
	}
	if _, err := v.key(context.Background(), "old"); !errors.Is(err, ErrInvalid) {
		t.Fatal("removed key accepted")
	}
	now = now.Add(5 * time.Minute)
	failure = true
	if _, err := v.key(context.Background(), "new"); !errors.Is(err, ErrUnavailable) {
		t.Fatal("expired cache used during outage")
	}
}
func TestJWKSBoundaries(t *testing.T) {
	for _, body := range []string{"not json", strings.Repeat("x", (256<<10)+1), `{"keys":[{"kty":"EC","crv":"P-256","alg":"ES256","kid":"bad","x":"AA","y":"AA"}]}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
		v, _ := NewVerifier(server.URL)
		if _, err := v.key(context.Background(), "bad"); !errors.Is(err, ErrUnavailable) {
			t.Error("invalid response accepted")
		}
		server.Close()
	}
	for _, project := range []string{"http://external.invalid", "https://trusted.invalid/evil", "https://trusted.invalid?url=evil", "https://u:p@trusted.invalid", ""} {
		if _, err := NewVerifier(project); err == nil {
			t.Error("invalid trust project")
		}
	}
}
