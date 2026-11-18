package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kosuke/mj-stats-api/auth"
	"github.com/lib/pq"
)

// The comprehensive signed-negative fixtures run locally. This test verifies
// the same Go router, real hosted Auth, runtime role and lock semantics on QA.
func TestStep1ManagedSupabase(t *testing.T) {
	if os.Getenv("MJSTATS_MANAGED_INTEGRATION") != "1" {
		t.Skip("requires explicitly prepared mj-stats-step1-qa; see setup-and-operations.md")
	}
	var config map[string]string
	raw, err := os.ReadFile("../.local/managed-acceptance.json")
	if err != nil || json.Unmarshal(raw, &config) != nil {
		t.Fatal("managed QA configuration missing")
	}
	ref := config["PROJECT_REF"]
	u, err := url.Parse(config["DB_URL"])
	if err != nil || len(ref) != 20 || ref == "ijvoezfsyvchvgbfjlji" ||
		config["PROJECT_NAME"] != "mj-stats-step1-qa" ||
		config["API_URL"] != "https://"+ref+".supabase.co" ||
		u.User == nil || u.User.Username() != "mjstats_api."+ref || !strings.HasSuffix(u.Hostname(), ".pooler.supabase.com") ||
		u.Query().Get("sslmode") != "verify-full" {
		t.Fatal("refusing unexpected managed target")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	database, err := sql.Open("postgres", config["DB_URL"])
	if err != nil {
		t.Fatal("QA database open")
	}
	defer database.Close()
	if err = database.PingContext(ctx); err != nil {
		var pg *pq.Error
		if errors.As(err, &pg) {
			t.Fatalf("QA API role connection SQLSTATE=%s; details withheld", pg.Code)
		}
		t.Fatalf("QA API role connection failed (%T); details withheld", err)
	}
	var current string
	if database.QueryRowContext(ctx, `SELECT current_user`).Scan(&current) != nil || current != "mjstats_api" {
		t.Fatal("QA runtime role mismatch")
	}
	verifier, err := auth.NewVerifier(config["API_URL"])
	if err != nil {
		t.Fatal("QA verifier configuration")
	}
	api := httptest.NewServer(router(database, verifier, []string{"http://localhost:3001"}, nil, nil, nil))
	defer api.Close()
	cli, _ := filepath.Abs("../node_modules/.bin/supabase")
	workdir, _ := filepath.Abs("..")
	queryFile := filepath.Join(t.TempDir(), "qa.sql")
	manage := func(query string, readOnly bool) []map[string]any {
		t.Helper()
		if os.WriteFile(queryFile, []byte(query), 0o600) != nil {
			t.Fatal("QA SQL fixture file")
		}
		args := []string{"db", "query", "--remote=" + ref, "--file", queryFile, "--output-format", "json"}
		if readOnly {
			args = append(args, "--read-only")
		} else {
			args = append(args, "--yes")
		}
		cmd := exec.CommandContext(ctx, cli, args...)
		cmd.Dir = workdir
		out, e := cmd.Output()
		if e != nil {
			t.Fatal("QA management query failed; SQL and credentials withheld")
		}
		var result struct {
			Rows  []map[string]any `json:"rows"`
			Error json.RawMessage  `json:"error"`
		}
		if json.Unmarshal(out, &result) != nil || len(result.Error) > 0 {
			t.Fatal("QA management result")
		}
		return result.Rows
	}
	fingerprint := func() string {
		t.Helper()
		return manage(`SELECT md5((SELECT COALESCE(jsonb_agg(to_jsonb(u) ORDER BY id)::text,'') FROM public.users u)||(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id)::text,'') FROM public.matches m)||(SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY id)::text,'') FROM public.match_results r)) AS value`, true)[0]["value"].(string)
	}
	client := &http.Client{Timeout: 20 * time.Second}
	authCall := func(method, path, token string, body any) (int, []byte) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequestWithContext(ctx, method, config["API_URL"]+"/auth/v1"+path, bytes.NewReader(b))
		req.Header.Set("apikey", config["ANON_KEY"])
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, e := client.Do(req)
		if e != nil {
			return 0, nil
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return res.StatusCode, data
	}
	call := func(method, path, token, body string) (int, map[string]any) {
		req, _ := http.NewRequestWithContext(ctx, method, api.URL+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		res, e := client.Do(req)
		if e != nil {
			return 0, nil
		}
		defer res.Body.Close()
		var data map[string]any
		_ = json.NewDecoder(res.Body).Decode(&data)
		return res.StatusCode, data
	}
	email, password := "managed-"+uniqueSuffix()+"@example.test", "Managed-"+uniqueSuffix()+"-Password!"
	code, raw := authCall("POST", "/admin/users", config["SERVICE_ROLE_KEY"], map[string]any{"email": email, "password": password, "email_confirm": true})
	var subject struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &subject)
	if code != 200 || subject.ID == "" {
		t.Fatalf("QA Auth fixture status=%d", code)
	}
	defer authCall("DELETE", "/admin/users/"+subject.ID, config["SERVICE_ROLE_KEY"], map[string]any{})
	login := func() authSession {
		t.Helper()
		code, data := authCall("POST", "/token?grant_type=password", "", map[string]string{"email": email, "password": password})
		var session authSession
		_ = json.Unmarshal(data, &session)
		if code != 200 || session.Access == "" {
			t.Fatal("QA Auth login")
		}
		return session
	}
	a, b := login(), login()
	claims, err := verifier.Verify(ctx, a.Access)
	if err != nil || claims.Subject != subject.ID {
		t.Fatal("QA ES256/JWKS verification")
	}
	paths := []struct{ method, path, body string }{{"GET", "/api/users/me", ""}, {"POST", "/api/matches/calculate", `{"players":[]}`}, {"POST", "/api/matches", `{}`}, {"GET", "/api/matches", ""}}
	before := fingerprint()
	for _, token := range []string{"", "bad.jwt.token", a.Access[:len(a.Access)-12] + "AAAAAAAAAAAA"} {
		for _, p := range paths {
			if code, _ := call(p.method, p.path, token, p.body); code != 401 {
				t.Fatal("QA invalid authentication accepted")
			}
		}
	}
	if code, _ := call("GET", "/api/health", "", ""); code != 200 || before != fingerprint() {
		t.Fatal("QA health or unauthenticated side effect")
	}
	t.Log("Q-06/Q-07 hosted PASS: ES256/JWKS, 3 negative inputs x 4 APIs=401, public health=200, row fingerprints unchanged")

	var wg sync.WaitGroup
	ids := make(chan string, 12)
	for range 12 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, data := call("GET", "/api/users/me", a.Access, "")
			id, _ := data["id"].(string)
			if code != 200 {
				id = ""
			}
			ids <- id
		}()
	}
	wg.Wait()
	close(ids)
	participant := ""
	for id := range ids {
		if id == "" || (participant != "" && id != participant) || id == subject.ID {
			t.Fatal("QA concurrent identity")
		}
		participant = id
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	row := manage("SELECT id::text,auth_id::text,(SELECT count(*) FROM public.users WHERE auth_id="+quote(subject.ID)+") AS count FROM public.users WHERE id="+quote(participant), true)[0]
	if row["auth_id"] != subject.ID || row["count"] != float64(1) {
		t.Fatal("QA real UID mapping")
	}
	for _, p := range paths[1:] {
		if code, _ := call(p.method, p.path, a.Access, p.body); code != 403 {
			t.Fatal("QA profile requirement bypass")
		}
	}
	code, profile := call("PATCH", "/api/users/me", a.Access, `{"name":"管理環境😀"}`)
	if code != 200 || profile["id"] != participant || profile["profile_completed_at"] == nil {
		t.Fatal("QA name setup")
	}
	completed := profile["profile_completed_at"]
	code, profile = call("PATCH", "/api/users/me", a.Access, `{"name":"管理環境の変更"}`)
	if code != 200 || profile["id"] != participant || profile["profile_completed_at"] != completed {
		t.Fatal("QA name change")
	}
	t.Log("Q-08 hosted PASS: 12 concurrent me -> one persistent ID, real auth_id checked, incomplete profile blocked, name setup/change preserves ID and completion")

	for _, query := range []string{`SELECT * FROM auth.users LIMIT 1`, `UPDATE auth.users SET id=id`, `SELECT * FROM mjstats_private.auth_subjects`, `DELETE FROM public.users WHERE false`} {
		_, e := database.ExecContext(ctx, query)
		var denied *pq.Error
		if !errors.As(e, &denied) || denied.Code != "42501" {
			t.Fatal("QA API excessive permissions")
		}
	}
	permissions := manage(`SELECT
    NOT has_schema_privilege('mjstats_auth_validator','auth','USAGE')
    AND NOT has_any_column_privilege('mjstats_auth_validator','auth.users','SELECT,UPDATE')
    AND NOT has_any_column_privilege('mjstats_auth_validator','auth.sessions','SELECT,UPDATE')
    AND NOT EXISTS(SELECT FROM pg_roles WHERE rolname IN ('mjstats_api','mjstats_auth_validator') AND (rolbypassrls OR rolsuper))
    AND EXISTS(SELECT FROM pg_roles WHERE rolname='mjstats_auth_validator' AND NOT rolcanlogin AND NOT rolinherit)
    AND EXISTS(SELECT FROM pg_proc WHERE oid='mjstats_private.valid_session(uuid,uuid)'::regprocedure
      AND proowner='mjstats_auth_validator'::regrole AND prosecdef
      AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp'])
    AND NOT EXISTS(SELECT FROM pg_policy WHERE polrelid IN ('auth.users'::regclass,'auth.sessions'::regclass) AND polname LIKE 'mjstats_validator_%')
    AND NOT has_function_privilege('anon','mjstats_private.valid_session(uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('authenticated','mjstats_private.valid_session(uuid,uuid)','EXECUTE')
    AND NOT has_function_privilege('service_role','mjstats_private.valid_session(uuid,uuid)','EXECUTE') AS limited`, true)
	if permissions[0]["limited"] != true {
		t.Fatal("QA function owner or public permissions")
	}
	manage(`BEGIN; GRANT mjstats_auth_validator TO postgres; SET LOCAL ROLE mjstats_auth_validator;
    DO $$ BEGIN
      BEGIN UPDATE mjstats_private.auth_subjects SET id=id WHERE id=`+quote(subject.ID)+`;
        RAISE EXCEPTION 'Auth update unexpectedly allowed';
      EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    END $$; ROLLBACK;`, false)
	t.Log("Q-25 hosted PASS: real mjstats_api denied direct Auth/view access and participant delete; NOLOGIN validator needs no direct Auth grants; projected updates and public execution denied")

	// Create only this test's references; preserve the recorded participant on Auth deletion.
	manage(`WITH l AS (INSERT INTO public.leagues(name,owner_id) VALUES('Managed QA preservation',`+quote(participant)+`) RETURNING id)
    INSERT INTO public.league_members(league_id,user_id,role,participant_kind) SELECT id,`+quote(participant)+`,'owner','registered' FROM l;
    WITH r AS (INSERT INTO public.rules(name,uma_1,uma_2,uma_3,uma_4) VALUES('Managed QA rule',20,10,-10,-20) RETURNING id),
    m AS (INSERT INTO public.matches(recorded_by,rule_id) SELECT `+quote(participant)+`,id FROM r RETURNING id)
    INSERT INTO public.match_results(match_id,user_id,raw_score,final_point,rank) SELECT id,`+quote(participant)+`,25000,0,1 FROM m;`, false)
	if code, _ := call("GET", "/api/matches", a.Access, ""); code != 400 {
		t.Fatal("unscoped QA history was not closed")
	}
	ordered := func(session authSession, method, path, credential string, expected int) {
		t.Helper()
		c, e := verifier.Verify(ctx, session.Access)
		if e != nil {
			t.Fatal("QA transaction claims")
		}
		tx, e := database.BeginTx(ctx, nil)
		if e != nil {
			t.Fatal("QA write transaction")
		}
		defer tx.Rollback()
		var valid bool
		var pid int
		if tx.QueryRowContext(ctx, `SELECT mjstats_private.valid_session($1::uuid,$2::uuid)`, c.Subject, c.SessionID).Scan(&valid) != nil || !valid || tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid) != nil {
			t.Fatal("QA Auth shared locks")
		}
		finished := make(chan int, 1)
		go func() { code, _ := authCall(method, path, credential, map[string]any{}); finished <- code }()
		waiting := false
		for range 5 {
			rows := manage(fmt.Sprintf(`SELECT count(*) AS count FROM pg_locks w JOIN pg_locks h ON w.transactionid=h.transactionid WHERE NOT w.granted AND h.granted AND h.pid=%d`, pid), true)
			if rows[0]["count"].(float64) > 0 {
				waiting = true
				break
			}
		}
		if !waiting {
			t.Fatal("QA concurrent Auth operation did not wait")
		}
		if _, e = tx.ExecContext(ctx, `UPDATE public.users SET name='管理環境の並行書込み' WHERE id=$1`, participant); e != nil || tx.Commit() != nil {
			t.Fatal("QA commit before Auth completion")
		}
		if code := <-finished; code != expected {
			t.Fatalf("QA concurrent Auth result=%d", code)
		}
	}
	ordered(a, "POST", "/logout?scope=local", a.Access, 204)
	before = fingerprint()
	for _, p := range paths {
		if code, _ := call(p.method, p.path, a.Access, p.body); code != 401 {
			t.Fatal("QA logged out token accepted")
		}
	}
	if before != fingerprint() {
		t.Fatal("QA logout side effects")
	}
	if code, _ := call("GET", "/api/users/me", b.Access, ""); code != 200 {
		t.Fatal("QA second browser session ended")
	}
	t.Log("Q-10 hosted PASS: Auth logout blocked by writer (pg_locks), commit precedes logout completion, old token=401/no writes, second session=200")

	ordered(b, "DELETE", "/admin/users/"+subject.ID, config["SERVICE_ROLE_KEY"], 200)
	row = manage(`SELECT auth_id IS NULL AS detached,participant_kind,
    (SELECT count(*) FROM public.leagues WHERE owner_id=`+quote(participant)+`) AS owned,
    (SELECT count(*) FROM public.league_members WHERE user_id=`+quote(participant)+`) AS memberships,
    (SELECT count(*) FROM public.matches WHERE recorded_by=`+quote(participant)+`) AS recorded,
    (SELECT count(*) FROM public.match_results WHERE user_id=`+quote(participant)+`) AS results
    FROM public.users WHERE id=`+quote(participant), true)[0]
	if row["detached"] != true || row["participant_kind"] != "registered" || row["owned"] != float64(1) || row["memberships"] != float64(1) || row["recorded"] != float64(1) || row["results"] != float64(1) {
		t.Fatal("QA Auth deletion lost participant references")
	}
	before = fingerprint()
	for _, p := range paths {
		if code, _ := call(p.method, p.path, b.Access, p.body); code != 401 {
			t.Fatal("QA deleted subject accepted")
		}
	}
	if before != fingerprint() {
		t.Fatal("QA deleted subject recreated")
	}
	t.Log("Q-08/Q-10 hosted PASS: concurrent deletion waits for writer; auth_id alone detached; participant/owner/member/recorder/result retained; old token=401/no recreation")
}
