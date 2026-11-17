package auth

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var ErrInvalid = errors.New("invalid authentication")
var ErrUnavailable = errors.New("authentication unavailable")
var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

func validUUID(s string) bool {
	return uuid.MatchString(s) && s != "00000000-0000-0000-0000-000000000000"
}

type Claims struct {
	jwt.RegisteredClaims
	SessionID string `json:"session_id"`
	Role      string `json:"role"`
	Anonymous *bool  `json:"is_anonymous"`
}

type Verifier struct {
	issuer    string
	client    *http.Client
	mu        sync.Mutex
	keys      map[string]*ecdsa.PublicKey
	fetched   time.Time
	attempted time.Time
	fetchErr  error
	now       func() time.Time
}

func NewVerifier(project string) (*Verifier, error) {
	u, err := url.Parse(project)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("invalid SUPABASE_URL")
	}
	local := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1"
	if u.Scheme != "https" && !(u.Scheme == "http" && local) {
		return nil, errors.New("SUPABASE_URL requires HTTPS (except loopback development)")
	}
	return &Verifier{issuer: strings.TrimRight(project, "/") + "/auth/v1", client: &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, now: time.Now}, nil
}

func (v *Verifier) Verify(ctx context.Context, raw string) (*Claims, error) {
	if len(raw) == 0 || len(raw) > 16<<10 {
		return nil, ErrInvalid
	}
	claims := new(Claims)
	var keyErr error
	token, err := jwt.ParseWithClaims(raw, claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodES256 {
			return nil, ErrInvalid
		}
		kid, ok := t.Header["kid"].(string)
		if !ok || kid == "" || len(kid) > 256 {
			return nil, ErrInvalid
		}
		key, err := v.key(ctx, kid)
		keyErr = err
		return key, err
	}, jwt.WithValidMethods([]string{"ES256"}), jwt.WithIssuer(v.issuer), jwt.WithAudience("authenticated"), jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithLeeway(30*time.Second), jwt.WithTimeFunc(v.now))
	if errors.Is(keyErr, ErrUnavailable) {
		return nil, ErrUnavailable
	}
	if err != nil || !token.Valid || claims.IssuedAt == nil || !validUUID(claims.Subject) || !validUUID(claims.SessionID) || claims.Role != "authenticated" || claims.Anonymous == nil || *claims.Anonymous {
		return nil, ErrInvalid
	}
	return claims, nil
}

// Recheck time immediately before writing, after potentially waiting for locks.
func (v *Verifier) Current(c *Claims) bool {
	now := v.now()
	return c.ExpiresAt != nil && now.Before(c.ExpiresAt.Add(30*time.Second)) && c.IssuedAt != nil && !c.IssuedAt.After(now.Add(30*time.Second)) && (c.NotBefore == nil || !c.NotBefore.After(now.Add(30*time.Second)))
}

func (v *Verifier) key(ctx context.Context, kid string) (*ecdsa.PublicKey, error) {
	// Bounded HTTP timeout plus one mutex coalesces concurrent refreshes.
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	if now.Sub(v.fetched) < 5*time.Minute && v.keys[kid] != nil {
		return v.keys[kid], nil
	}
	if !v.attempted.IsZero() && now.Sub(v.attempted) < 30*time.Second {
		if v.fetchErr != nil || now.Sub(v.fetched) >= 5*time.Minute {
			return nil, ErrUnavailable
		}
		return nil, ErrInvalid
	}
	v.attempted = now
	keys, err := v.fetch(ctx)
	v.fetchErr = err
	if err != nil {
		return nil, ErrUnavailable
	}
	v.keys, v.fetched = keys, now
	if keys[kid] == nil {
		return nil, ErrInvalid
	}
	return keys[kid], nil
}

func (v *Verifier) fetch(ctx context.Context) (map[string]*ecdsa.PublicKey, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, v.issuer+"/.well-known/jwks.json", nil)
	if err != nil {
		return nil, ErrUnavailable
	}
	res, err := v.client.Do(req)
	if err != nil {
		return nil, ErrUnavailable
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, ErrUnavailable
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, (256<<10)+1))
	if err != nil || len(body) > 256<<10 {
		return nil, ErrUnavailable
	}
	var doc struct {
		Keys []struct {
			Kty, Crv, Kid, Alg, Use, X, Y string
			KeyOps                        []string `json:"key_ops"`
		}
	}
	if json.Unmarshal(body, &doc) != nil {
		return nil, ErrUnavailable
	}
	keys := map[string]*ecdsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "EC" || k.Crv != "P-256" || k.Alg != "ES256" || k.Kid == "" || (k.Use != "" && k.Use != "sig") {
			continue
		}
		if len(k.KeyOps) > 0 && !(len(k.KeyOps) == 1 && k.KeyOps[0] == "verify") {
			continue
		}
		x, ex := base64.RawURLEncoding.DecodeString(k.X)
		y, ey := base64.RawURLEncoding.DecodeString(k.Y)
		if ex != nil || ey != nil || len(x) != 32 || len(y) != 32 {
			return nil, ErrUnavailable
		}
		key := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		if !key.Curve.IsOnCurve(key.X, key.Y) || keys[k.Kid] != nil {
			return nil, ErrUnavailable
		}
		keys[k.Kid] = key
	}
	return keys, nil
}
