package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/joho/godotenv"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/lib/pq"
)

type authSession struct {
	Access  string `json:"access_token"`
	Refresh string `json:"refresh_token"`
	User    struct {
		ID string `json:"id"`
	} `json:"user"`
}

func uniqueSuffix() string { var b [8]byte; _, _ = rand.Read(b[:]); return hex.EncodeToString(b[:]) }
func TestStep1RealDBAuth(t *testing.T) {
	if os.Getenv("MJSTATS_INTEGRATION") != "1" {
		t.Skip("requires dedicated local Supabase; see setup-and-operations.md")
	}
	cfg, err := godotenv.Read("../.local/api.env")
	if err != nil {
		t.Fatal("local API configuration missing")
	}
	var status map[string]string
	raw, err := os.ReadFile("../.local/acceptance.json")
	if err != nil || json.Unmarshal(raw, &status) != nil {
		t.Fatal("local Auth configuration missing")
	}
	if status["API_URL"] != "http://127.0.0.1:55421" {
		t.Fatal("refusing nonlocal Auth")
	}
	for _, dsn := range []string{cfg["DATABASE_URL"], status["DB_URL"]} {
		u, e := url.Parse(dsn)
		if e != nil || u.Host != "127.0.0.1:55422" || u.Path != "/postgres" {
			t.Fatal("refusing nonlocal DB")
		}
	}
	db, e := sql.Open("postgres", cfg["DATABASE_URL"])
	if e != nil {
		t.Fatal("API database open")
	}
	defer db.Close()
	admin, e := sql.Open("postgres", status["DB_URL"])
	if e != nil {
		t.Fatal("admin database open")
	}
	defer admin.Close()
	verifier, e := auth.NewVerifier(status["API_URL"])
	if e != nil {
		t.Fatal(e)
	}
	api := httptest.NewServer(router(db, verifier, []string{"http://localhost:3000"}, nil, nil, nil))
	defer api.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	httpClient := &http.Client{Timeout: 10 * time.Second}
	call := func(method, path, token, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, method, api.URL+path, strings.NewReader(body))
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := httpClient.Do(req)
		if err != nil {
			t.Fatal("API request failed")
		}
		defer res.Body.Close()
		var data map[string]any
		_ = json.NewDecoder(res.Body).Decode(&data)
		return res.StatusCode, data
	}
	authCall := func(method, path, token string, body any) (int, []byte) {
		t.Helper()
		b, _ := json.Marshal(body)
		req, _ := http.NewRequestWithContext(ctx, method, status["API_URL"]+"/auth/v1"+path, bytes.NewReader(b))
		req.Header.Set("apikey", status["ANON_KEY"])
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		req.Header.Set("Content-Type", "application/json")
		res, err := httpClient.Do(req)
		if err != nil {
			t.Fatal("local Auth request failed")
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return res.StatusCode, data
	}
	create := func() (string, string, string) {
		t.Helper()
		email := "qa-" + uniqueSuffix() + "@example.test"
		password := "Qa-" + uniqueSuffix() + "-Password!"
		code, data := authCall("POST", "/admin/users", status["SERVICE_ROLE_KEY"], map[string]any{"email": email, "password": password, "email_confirm": true})
		var user struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(data, &user)
		if code != 200 || user.ID == "" {
			t.Fatalf("Auth create status=%d", code)
		}
		return email, password, user.ID
	}
	login := func(email, password string) authSession {
		t.Helper()
		code, data := authCall("POST", "/token?grant_type=password", "", map[string]string{"email": email, "password": password})
		var s authSession
		_ = json.Unmarshal(data, &s)
		if code != 200 || s.Access == "" {
			t.Fatalf("Auth login status=%d", code)
		}
		return s
	}
	fingerprint := func() string {
		t.Helper()
		var value string
		err := admin.QueryRowContext(ctx, `SELECT md5((SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY id)::text,'') FROM public.users u)||(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'') FROM public.matches m)||(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'') FROM public.match_results r))`).Scan(&value)
		if err != nil {
			t.Fatal("database fingerprint")
		}
		return value
	}
	calc := `{"players":[{"player_id":"p1","raw_score":40000},{"player_id":"p2","raw_score":30000},{"player_id":"p3","raw_score":20000},{"player_id":"p4","raw_score":10000}]}`
	paths := []struct{ method, path, body string }{{"GET", "/api/users/me", ""}, {"POST", "/api/matches/calculate", calc}, {"POST", "/api/matches", `{"rule_id":"99999999-9999-9999-9999-999999999999","season_id":null,"results":[{"player_id":"11111111-1111-1111-1111-111111111111","raw_score":40000,"point":50,"rank":1},{"player_id":"22222222-2222-2222-2222-222222222222","raw_score":30000,"point":10,"rank":2},{"player_id":"33333333-3333-3333-3333-333333333333","raw_score":20000,"point":-20,"rank":3},{"player_id":"44444444-4444-4444-4444-444444444444","raw_score":10000,"point":-40,"rank":4}]}`}, {"GET", "/api/matches", ""}, {"GET", "/api/leagues", ""}, {"GET", "/api/leagues/00000000-0000-0000-0000-000000000001/matches", ""}}
	before := fingerprint()
	for _, p := range paths {
		if code, _ := call(p.method, p.path, "", p.body); code != 401 {
			t.Fatalf("Q-06 %s status=%d", p.path, code)
		}
	}
	if code, _ := call("GET", "/api/health", "", ""); code != 200 {
		t.Fatal("health")
	}
	if before != fingerprint() {
		t.Fatal("Q-06 database changed")
	}
	t.Log("Q-06 PASS: 6 unauthenticated APIs=401; health=200; database unchanged")

	email, password, uid := create()
	a := login(email, password)
	b := login(email, password)
	// Sign negative fixtures with the same isolated ES256 key. Production never parses unverified claims.
	var keys []struct{ D, X, Y, Kid string }
	raw, _ = os.ReadFile("../supabase/signing_keys.json")
	if json.Unmarshal(raw, &keys) != nil || len(keys) == 0 {
		t.Fatal("local signing key")
	}
	d, _ := base64.RawURLEncoding.DecodeString(keys[0].D)
	x, _ := base64.RawURLEncoding.DecodeString(keys[0].X)
	y, _ := base64.RawURLEncoding.DecodeString(keys[0].Y)
	signingKey := &ecdsa.PrivateKey{PublicKey: ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}, D: new(big.Int).SetBytes(d)}
	sign := func(change func(jwt.MapClaims)) string {
		payload, _ := base64.RawURLEncoding.DecodeString(strings.Split(a.Access, ".")[1])
		var claims jwt.MapClaims
		_ = json.Unmarshal(payload, &claims)
		change(claims)
		token := jwt.NewWithClaims(jwt.SigningMethodES256, claims)
		token.Header["kid"] = keys[0].Kid
		raw, _ := token.SignedString(signingKey)
		return raw
	}
	invalid := map[string]string{"malformed": "bad.jwt.token", "bad-signature": a.Access[:len(a.Access)-12] + "AAAAAAAAAAAA", "issuer": sign(func(c jwt.MapClaims) { c["iss"] = "https://other.invalid/auth/v1" }), "audience": sign(func(c jwt.MapClaims) { c["aud"] = "anon" }), "subject": sign(func(c jwt.MapClaims) { c["sub"] = "invalid" }), "expiry": sign(func(c jwt.MapClaims) { c["exp"] = time.Now().Add(-time.Minute).Unix() }), "no-exp": sign(func(c jwt.MapClaims) { delete(c, "exp") }), "iat": sign(func(c jwt.MapClaims) { c["iat"] = time.Now().Add(time.Minute).Unix() }), "no-session": sign(func(c jwt.MapClaims) { delete(c, "session_id") }), "anonymous": sign(func(c jwt.MapClaims) { c["is_anonymous"] = true }), "role": sign(func(c jwt.MapClaims) { c["role"] = "service_role" }), "no-session-row": sign(func(c jwt.MapClaims) { c["session_id"] = "11111111-1111-4111-8111-111111111111" })}
	// A different valid subject paired with this session must fail at the DB function.
	otherEmail, otherPassword, otherUID := create()
	invalid["session-owner"] = sign(func(c jwt.MapClaims) { c["sub"] = otherUID })
	before = fingerprint()
	for name, token := range invalid {
		for _, p := range paths {
			code, data := call(p.method, p.path, token, p.body)
			if code != 401 {
				t.Fatalf("Q-07 %s %s status=%d", name, p.path, code)
			}
			if data["error"].(map[string]any)["code"] != "UNAUTHENTICATED" {
				t.Fatal("error contract")
			}
		}
	}
	if before != fingerprint() {
		t.Fatal("Q-07 database changed")
	}
	t.Logf("Q-07 PASS: %d invalid JWT/subject/session fixtures x 6 APIs; database unchanged", len(invalid))

	// Exercise Auth metadata states with a real session and real Admin API.
	var aClaims auth.Claims
	payloadA, _ := base64.RawURLEncoding.DecodeString(strings.Split(a.Access, ".")[1])
	_ = json.Unmarshal(payloadA, &aClaims)
	if _, err := admin.ExecContext(ctx, `UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 minute' WHERE id=$1`, aClaims.SessionID); err != nil {
		t.Fatal("session deadline fixture")
	}
	if code, _ := call("GET", "/api/users/me", a.Access, ""); code != 401 {
		t.Fatal("expired session accepted")
	}
	if _, err := admin.ExecContext(ctx, `UPDATE auth.sessions SET not_after=NULL WHERE id=$1`, aClaims.SessionID); err != nil {
		t.Fatal("restore session deadline fixture")
	}
	code, _ := authCall("PUT", "/admin/users/"+uid, status["SERVICE_ROLE_KEY"], map[string]string{"ban_duration": "24h"})
	if code != 200 {
		t.Fatal("ban fixture")
	}
	if code, _ := call("GET", "/api/users/me", a.Access, ""); code != 401 {
		t.Fatal("banned user accepted")
	}
	code, _ = authCall("PUT", "/admin/users/"+uid, status["SERVICE_ROLE_KEY"], map[string]string{"ban_duration": "none"})
	if code != 200 {
		t.Fatal("restore ban fixture")
	}
	if before != fingerprint() {
		t.Fatal("invalid Auth state created a participant")
	}
	// Lock timeout is a service error and cannot create a profile.
	blocked, err := admin.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("lock fixture transaction")
	}
	var lockedID string
	if err := blocked.QueryRowContext(ctx, `SELECT id FROM auth.users WHERE id=$1 FOR UPDATE`, uid).Scan(&lockedID); err != nil {
		t.Fatal("Auth row lock fixture")
	}
	code, _ = call("GET", "/api/users/me", a.Access, "")
	_ = blocked.Rollback()
	if code != 503 || before != fingerprint() {
		t.Fatal("lock timeout must fail without side effects")
	}
	t.Log("Q-07/Q-10 PASS: expired session, banned subject and 5-second Auth lock timeout rejected without profile creation")

	const creationProbe = `{"name":"未設定の拒否確認","client_request_id":"3a000000-0000-4000-8000-000000000001"}`
	if status, body := call("POST", "/api/leagues", a.Access, creationProbe); status != 403 || body["error"].(map[string]any)["code"] != "PROFILE_REQUIRED" {
		t.Fatal("league creation accepted with no participant")
	}

	// Concurrent first access must converge without overwriting a name.
	var wg sync.WaitGroup
	ids := make(chan string, 12)
	codes := make(chan int, 12)
	for range 12 {
		wg.Go(func() {
			code, data := call("GET", "/api/users/me", a.Access, "")
			codes <- code
			if id, ok := data["id"].(string); ok {
				ids <- id
			}
		})
	}
	wg.Wait()
	close(ids)
	close(codes)
	for code := range codes {
		if code != 200 {
			t.Fatalf("concurrent me=%d", code)
		}
	}
	participant := ""
	for id := range ids {
		if participant == "" {
			participant = id
		}
		if id != participant {
			t.Fatal("duplicate participant")
		}
	}
	if participant == "" || participant == uid {
		t.Fatal("participant ID not separated")
	}
	var count int
	if admin.QueryRowContext(ctx, `SELECT count(*) FROM public.users WHERE auth_id=$1`, uid).Scan(&count) != nil || count != 1 {
		t.Fatal("participant count")
	}
	for _, p := range paths[1:] {
		if code, _ := call(p.method, p.path, a.Access, p.body); code != 403 {
			t.Fatal("incomplete profile not denied")
		}
	}
	if status, body := call("POST", "/api/leagues", a.Access, creationProbe); status != 403 || body["error"].(map[string]any)["code"] != "PROFILE_INCOMPLETE" {
		t.Fatal("league creation accepted before name setup")
	}
	for _, body := range []string{`{"name":""}`, `{"name":"\n名前"}`, `{"name":"x","id":"other"}`, `{"name":"a","name":"b"}`, `{"name":null}`} {
		if code, _ := call("PATCH", "/api/users/me", a.Access, body); code != 400 {
			t.Fatal("invalid name/body accepted")
		}
	}
	code, profile := call("PATCH", "/api/users/me", a.Access, `{"name":"　Player　"}`)
	if code != 200 || profile["name"] != "Player" || profile["profile_completed_at"] == nil {
		t.Fatalf("profile setup=%d", code)
	}
	completed := profile["profile_completed_at"]
	code, profile = call("PATCH", "/api/users/me", a.Access, `{"name":"新しい😀名前"}`)
	if code != 200 || profile["id"] != participant || profile["profile_completed_at"] != completed {
		t.Fatal("rename changed identity/completion")
	}
	code, profile = call("GET", "/api/users/me", a.Access, "")
	if code != 200 || profile["name"] != "新しい😀名前" {
		t.Fatal("me overwrote name")
	}
	if admin.QueryRowContext(ctx, `SELECT count(*) FROM public.league_members WHERE user_id=$1`, participant).Scan(&count) != nil || count != 0 {
		t.Fatal("registration granted membership")
	}
	t.Log("Q-08 PASS: 12 concurrent me requests -> one distinct persistent participant; setup required; Unicode rename; no membership")
	other := login(otherEmail, otherPassword)
	if code, _ := call("GET", "/api/users/me", other.Access, ""); code != 200 {
		t.Fatal("second participant")
	}
	code, sameName := call("PATCH", "/api/users/me", other.Access, `{"name":"新しい😀名前"}`)
	if code != 200 || sameName["id"] == participant || sameName["name"] != "新しい😀名前" {
		t.Fatal("same name must preserve separate identities")
	}
	t.Log("Q-08 PASS: two real Auth users may choose the same name and keep distinct participant IDs")
	t.Run("LeagueCreation", func(t *testing.T) {
		testLeagueCreation(t, ctx, db, admin, verifier, call, a.Access, other.Access, participant, sameName["id"].(string))
	})
	t.Run("LeagueInvites", func(t *testing.T) {
		testLeagueInvites(t, ctx, db, admin, verifier, a.Access, other.Access, participant, sameName["id"].(string))
	})
	t.Run("LeagueParticipation", func(t *testing.T) {
		thirdEmail, thirdPassword, thirdAuthID := create()
		third := login(thirdEmail, thirdPassword)
		verifyStatus(t, call, "GET", "/api/users/me", third.Access, 200, "")
		apiStatus, body := call("PATCH", "/api/users/me", third.Access, `{"name":"共通招待の参加者"}`)
		thirdParticipant, ok := body["id"].(string)
		if apiStatus != 200 || !ok {
			t.Fatal("third participant profile")
		}
		t.Cleanup(func() {
			if _, err := admin.Exec("DELETE FROM public.users WHERE id=$1", thirdParticipant); err != nil {
				t.Error("cleanup shared invite participant")
			}
			if code, _ := authCall("DELETE", "/admin/users/"+thirdAuthID, status["SERVICE_ROLE_KEY"], nil); code != 200 {
				t.Error("cleanup shared invite Auth user")
			}
		})
		testLeagueParticipation(t, ctx, db, admin, verifier, a.Access, other.Access, third.Access, participant, sameName["id"].(string), thirdParticipant)
	})
	t.Run("LeagueReferences", func(t *testing.T) {
		testLeagueReferences(t, ctx, admin, call, a.Access, other.Access, participant, sameName["id"].(string))
	})

	t.Run("LeagueHistory", func(t *testing.T) {
		testLeagueHistory(t, ctx, admin, call, a.Access, other.Access, participant, sameName["id"].(string))
	})

	t.Run("LeagueMatches", func(t *testing.T) {
		testLeagueMatches(t, ctx, admin, call, a.Access, other.Access, participant, sameName["id"].(string))
	})

	before = fingerprint()
	for _, p := range paths[1:3] {
		code, body := call(p.method, p.path, a.Access, p.body)
		if code != 410 || body["error"].(map[string]any)["code"] != "API_RETIRED" {
			t.Fatal("old recording route is still active")
		}
	}
	verifyStatus(t, call, "GET", "/api/matches", a.Access, 400, "INVALID_INPUT")
	if before != fingerprint() {
		t.Fatal("stopped recording route changed the database")
	}
	t.Log("Q-14/Q-17 cutover PASS: old calculation/save refuse with no side effects; unscoped history closed")

	// Privilege assertions must use real sessions for the API role, never SET ROLE as owner.
	for _, query := range []string{`SELECT * FROM auth.users LIMIT 1`, `UPDATE auth.users SET id=id`, `DELETE FROM public.users WHERE false`} {
		if _, err = db.ExecContext(ctx, query); err == nil {
			t.Fatal("API role has excessive privileges")
		}
	}
	for _, role := range []string{"anon", "authenticated", "service_role"} {
		var allowed bool
		if admin.QueryRowContext(ctx, `SELECT has_function_privilege($1,'mjstats_private.valid_session(uuid,uuid)','EXECUTE')`, role).Scan(&allowed) != nil || allowed {
			t.Fatal("public function execute allowed")
		}
	}
	var limited bool
	if admin.QueryRowContext(ctx, `SELECT NOT has_schema_privilege('mjstats_auth_validator','auth','USAGE')
    AND NOT has_any_column_privilege('mjstats_auth_validator','auth.users','SELECT,UPDATE')
    AND NOT has_any_column_privilege('mjstats_auth_validator','auth.sessions','SELECT,UPDATE')
    AND NOT has_table_privilege('mjstats_api','mjstats_private.auth_subjects','SELECT,UPDATE')
    AND NOT has_table_privilege('mjstats_api','mjstats_private.auth_sessions','SELECT,UPDATE')
    AND NOT EXISTS(SELECT FROM pg_policy WHERE polrelid IN ('auth.users'::regclass,'auth.sessions'::regclass) AND polname LIKE 'mjstats_validator_%')`).Scan(&limited) != nil || !limited {
		t.Fatal("managed Auth validation has excessive or obsolete privileges")
	}
	// Even the NOLOGIN function owner cannot mutate the projected Auth metadata.
	privTx, err := admin.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("view privilege test transaction")
	}
	if _, err = privTx.ExecContext(ctx, `GRANT mjstats_auth_validator TO postgres; SET LOCAL ROLE mjstats_auth_validator;`); err != nil {
		t.Fatal("view privilege test role")
	}
	_, err = privTx.ExecContext(ctx, `UPDATE mjstats_private.auth_subjects SET id=id WHERE id=$1`, uid)
	var denied *pq.Error
	if !errors.As(err, &denied) || denied.Code != "42501" {
		_ = privTx.Rollback()
		t.Fatal("Auth metadata view allowed update")
	}
	_ = privTx.Rollback()
	t.Log("Q-25 Step 1 permissions PASS: no API direct Auth read/update or participant delete; no public function execution")
	t.Log("Q-25 local managed-compatible permissions PASS: NOLOGIN validator has no Auth schema/table access; private projection updates rejected; no custom Auth RLS policy required")

	// The local logout must wait behind an already-authorized write's shared locks.
	var ac auth.Claims
	payload, _ := base64.RawURLEncoding.DecodeString(strings.Split(a.Access, ".")[1])
	_ = json.Unmarshal(payload, &ac)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var valid bool
	if err = tx.QueryRowContext(ctx, `SELECT mjstats_private.valid_session($1::uuid,$2::uuid)`, uid, ac.SessionID).Scan(&valid); err != nil || !valid {
		t.Fatal("Auth shared lock")
	}
	finished := make(chan int, 1)
	go func() {
		code, _ := authCall("POST", "/logout?scope=local", a.Access, map[string]string{})
		finished <- code
	}()
	waitForBlockedAuth := func(held *sql.Tx) {
		t.Helper()
		var pid int
		if held.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid) != nil {
			t.Fatal("writer pid")
		}
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			var waiting int
			if admin.QueryRowContext(ctx, `SELECT count(*) FROM pg_locks w JOIN pg_locks h ON w.transactionid=h.transactionid WHERE NOT w.granted AND h.granted AND h.pid=$1`, pid).Scan(&waiting) != nil {
				t.Fatal("Auth lock observation")
			}
			if waiting > 0 {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("Auth operation did not block on the write transaction")
	}
	waitForBlockedAuth(tx)
	if _, err = tx.ExecContext(ctx, `UPDATE public.users SET name='並行処理確認' WHERE auth_id=$1`, uid); err != nil {
		t.Fatal("authorized write")
	}
	if tx.Commit() != nil {
		t.Fatal("commit")
	}
	select {
	case code = <-finished:
		if code != 204 {
			t.Fatalf("logout=%d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("logout blocked after commit")
	}
	before = fingerprint()
	for _, p := range paths {
		if code, _ := call(p.method, p.path, a.Access, p.body); code != 401 {
			t.Fatal("logged out token accepted")
		}
	}
	if before != fingerprint() {
		t.Fatal("logged out writes")
	}
	if code, _ := call("GET", "/api/users/me", b.Access, ""); code != 200 {
		t.Fatal("other browser session ended")
	}
	t.Log("Q-10 PASS: concurrent local logout ordered after write commit; old session=401; second session stays valid")

	// Deletion preserves participant ID and references and rejects the old JWT.
	// Give this participant real owned/recorded/result references in this isolated fixture.
	var league, match, legacyRule string
	if admin.QueryRowContext(ctx, `INSERT INTO public.leagues(name,owner_id) VALUES('QA preservation',$1) RETURNING id`, participant).Scan(&league) != nil {
		t.Fatal("owner fixture")
	}
	if _, err = admin.ExecContext(ctx, `INSERT INTO public.league_members(league_id,user_id,role,participant_kind) VALUES($1,$2,'owner','registered')`, league, participant); err != nil {
		t.Fatal("member fixture")
	}
	if admin.QueryRowContext(ctx, `INSERT INTO public.rules(name,uma_1,uma_2,uma_3,uma_4)
		VALUES('QA preservation rule',20,10,-10,-20) RETURNING id`).Scan(&legacyRule) != nil {
		t.Fatal("legacy rule fixture")
	}
	if admin.QueryRowContext(ctx, `INSERT INTO public.matches(recorded_by,rule_id) VALUES($1,$2) RETURNING id`, participant, legacyRule).Scan(&match) != nil {
		t.Fatal("recorder fixture")
	}
	if _, err = admin.ExecContext(ctx, `INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank,
		final_point_numerator,final_point_denominator) VALUES($1,$2,25000,0,1,0,1)`, match, participant); err != nil {
		t.Fatal("result fixture")
	}
	if _, err = admin.ExecContext(ctx, `WITH players AS (
		INSERT INTO public.users(name) SELECT 'QA legacy player' FROM generate_series(1,3) RETURNING id
	) INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank,
		final_point_numerator,final_point_denominator)
	  SELECT $1,id,25000,0,row_number() OVER (ORDER BY id)+1,0,1 FROM players`, match); err != nil {
		t.Fatal("four result fixture")
	}
	// The same lock boundary must order a concurrent hard Auth deletion.
	held, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("delete boundary transaction")
	}
	defer held.Rollback()
	var bClaims auth.Claims
	bPayload, _ := base64.RawURLEncoding.DecodeString(strings.Split(b.Access, ".")[1])
	_ = json.Unmarshal(bPayload, &bClaims)
	if err = held.QueryRowContext(ctx, `SELECT mjstats_private.valid_session($1::uuid,$2::uuid)`, uid, bClaims.SessionID).Scan(&valid); err != nil || !valid {
		t.Fatal("delete boundary Auth lock")
	}
	deleted := make(chan int, 1)
	go func() {
		code, _ := authCall("DELETE", "/admin/users/"+uid, status["SERVICE_ROLE_KEY"], map[string]any{})
		deleted <- code
	}()
	waitForBlockedAuth(held)
	if _, err = held.ExecContext(ctx, `UPDATE public.users SET name='削除前の書込み' WHERE id=$1`, participant); err != nil {
		t.Fatal("write before deletion")
	}
	if held.Commit() != nil {
		t.Fatal("commit before deletion")
	}
	select {
	case code = <-deleted:
	case <-time.After(5 * time.Second):
		t.Fatal("deletion blocked after commit")
	}
	if code != 200 {
		t.Fatalf("Auth delete=%d", code)
	}
	var linked sql.NullString
	var kind string
	if admin.QueryRowContext(ctx, `SELECT auth_id,participant_kind FROM public.users WHERE id=$1`, participant).Scan(&linked, &kind) != nil || linked.Valid || kind != "registered" {
		t.Fatal("Auth deletion removed participant")
	}
	for _, query := range []string{`SELECT count(*) FROM public.leagues WHERE owner_id=$1`, `SELECT count(*) FROM public.league_members WHERE user_id=$1`, `SELECT count(*) FROM public.matches WHERE recorded_by=$1`, `SELECT count(*) FROM public.match_results WHERE user_id=$1`} {
		if admin.QueryRowContext(ctx, query, participant).Scan(&count) != nil || count != 1 {
			t.Fatal("Auth deletion lost reference")
		}
	}
	before = fingerprint()
	for _, p := range paths {
		if code, _ := call(p.method, p.path, b.Access, p.body); code != 401 {
			t.Fatal("deleted subject accepted")
		}
	}
	if before != fingerprint() {
		t.Fatal("deleted subject recreated")
	}
	t.Log("Q-08/D-21 PASS: concurrent Auth deletion waits for writer commit; clears auth_id only; participant/kind/owner/member/recorder/results preserved; old JWT=401")

	// Confirm failures remain service errors with no SQL or credential disclosure.
	adminDown, _ := sql.Open("postgres", "postgres://unused:unused@127.0.0.1:1/postgres?sslmode=disable&connect_timeout=1")
	defer adminDown.Close()
	brokenAPI := httptest.NewServer(router(adminDown, verifier, []string{"http://localhost:3000"}, nil, nil, nil))
	defer brokenAPI.Close()
	req, _ := http.NewRequestWithContext(ctx, "GET", brokenAPI.URL+"/api/health", nil)
	res, err := httpClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = io.ReadAll(res.Body)
	res.Body.Close()
	if res.StatusCode != 503 || strings.Contains(string(raw), "unused") {
		t.Fatal("internal error disclosure")
	}
	t.Log("Q-06 service failure PASS: 503 common JSON without connection detail")
}
