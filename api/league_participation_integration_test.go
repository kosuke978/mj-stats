package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/controllers"
	"github.com/kosuke/mj-stats-api/invites"
)

func testLeagueParticipation(t *testing.T, ctx context.Context, db, admin *sql.DB, verifier *auth.Verifier, a, b, actor, other string) {
	t.Helper()
	newKey := func() string {
		var raw [32]byte
		if _, err := rand.Read(raw[:]); err != nil {
			t.Fatal("generate local trial key")
		}
		return base64.StdEncoding.EncodeToString(raw[:])
	}
	const origin = "http://localhost:3000"
	cfg, err := invites.NewConfig(origin, fmt.Sprintf(`{"1":%q}`, newKey()), "1")
	if err != nil {
		t.Fatal("invite config")
	}
	key := newKey()
	makeHTTP := func(key, search, league, ip string) func(string, string, string, any, int, string) (map[string]any, string) {
		limiter, err := controllers.NewAttemptLimiter(key, search, league, ip)
		if err != nil {
			t.Fatal("attempt limiter config")
		}
		handler := router(db, verifier, []string{origin}, cfg, limiter, nil)
		return func(method, path, token string, input any, want int, code string) (map[string]any, string) {
			t.Helper()
			raw, _ := json.Marshal(input)
			req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(string(raw)))
			req.RemoteAddr = "192.0.2.11:45678"
			req.Header.Set("X-Forwarded-For", "203.0.113."+strconv.Itoa(len(token)%255))
			req.Header.Set("Content-Type", "application/json")
			if token != "" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			var body map[string]any
			_ = json.Unmarshal(res.Body.Bytes(), &body)
			errData, _ := body["error"].(map[string]any)
			if want != 0 && (res.Code != want || (code != "" && errData["code"] != code)) {
				t.Errorf("%s %s status=%d error=%v; want %d %s", method, path, res.Code, errData["code"], want, code)
			}
			body["http_status"] = res.Code
			return body, res.Header().Get("Retry-After")
		}
	}
	get := makeHTTP(key, "", "15", "")
	f := createLeagueFixture(t, ctx, admin, actor, other)
	t.Cleanup(func() {
		tx, err := admin.Begin()
		if err != nil {
			t.Error("begin participant fixture cleanup")
			return
		}
		defer tx.Rollback()
		for _, table := range []string{"league_events", "league_invites"} {
			if _, err := tx.Exec("DELETE FROM public."+table+" WHERE league_id IN ($1,$2,$3,$4)", f.a, f.b, f.left, f.removed); err != nil {
				t.Error("delete trial fixture")
				return
			}
		}
		if tx.Commit() != nil {
			t.Error("commit trial fixture cleanup")
		}
	})
	query := func(dst any, sql string, args ...any) {
		t.Helper()
		if err := admin.QueryRowContext(ctx, sql, args...).Scan(dst); err != nil {
			t.Fatal("participation fixture query")
		}
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := admin.ExecContext(ctx, sql, args...); err != nil {
			t.Fatal("participation fixture statement")
		}
	}
	newID := func() string {
		var id string
		query(&id, `SELECT gen_random_uuid()`)
		return id
	}
	members := func() string {
		var result string
		query(&result, `SELECT jsonb_agg(to_jsonb(m) ORDER BY league_id,user_id)::text
			FROM public.league_members m WHERE league_id IN ($1,$2,$3,$4)`, f.a, f.b, f.left, f.removed)
		return result
	}
	root := func(league string) string { return "/api/leagues/" + league }
	issue := func(league, token string) map[string]any {
		t.Helper()
		body, _ := get("POST", root(league)+"/invites", token, map[string]string{"client_request_id": newID()}, 201, "")
		record, ok := body["invite"].(map[string]any)
		if !ok {
			t.Fatal("missing trial invitation")
		}
		return record
	}
	joinPayload := func(id, code string) map[string]string {
		return map[string]string{"client_request_id": id, "code": code}
	}
	checkMembership := func(response map[string]any, id, role, status string) {
		t.Helper()
		m, ok := response["membership"].(map[string]any)
		if !ok || m["user_id"] != id || m["kind"] != "registered" || m["status"] != status || m["role"] != role {
			t.Fatal("unexpected participation state or identity")
		}
	}

	exec(`UPDATE public.leagues SET name='ＦＩＸ_% League',search_listed=true WHERE id IN ($1,$2)`, f.a, f.b)
	exec(`UPDATE public.leagues SET name='FIX_% hidden' WHERE id=$1`, f.left)
	exec(`DELETE FROM public.league_members WHERE league_id=$1 AND user_id=$2`, f.a, other)
	var ga, gb string
	query(&ga, `SELECT group_number FROM public.leagues WHERE id=$1`, f.a)
	query(&gb, `SELECT group_number FROM public.leagues WHERE id=$1`, f.left)
	before := members()
	search := "/api/leagues/search?q=" + url.QueryEscape("ｆｉｘ_%") + "&limit=1"
	first, _ := get("GET", search, b, nil, 200, "")
	results, ok := first["leagues"].([]any)
	next, hasNext := first["next_cursor"].(string)
	if !ok || len(results) != 1 || !hasNext || len(results[0].(map[string]any)) != 3 {
		t.Fatal("search did not return minimum listed result or cursor")
	}
	second, _ := get("GET", search+"&cursor="+url.QueryEscape(next), b, nil, 200, "")
	results2, ok := second["leagues"].([]any)
	if !ok || len(results2) != 1 || second["next_cursor"] != nil {
		t.Fatal("search did not return second page")
	}
	id1, id2 := results[0].(map[string]any)["id"], results2[0].(map[string]any)["id"]
	if id1 == id2 || (id1 != f.a && id1 != f.b) || (id2 != f.a && id2 != f.b) {
		t.Fatal("search included a hidden or duplicated result")
	}
	get("GET", search+"&cursor="+url.QueryEscape(next), a, nil, 400, "INVALID_INPUT")
	get("GET", "/api/leagues/search?q=other&cursor="+url.QueryEscape(next), b, nil, 400, "INVALID_INPUT")
	hidden, _ := get("POST", "/api/leagues/resolve", b, map[string]string{"group_number": gb[:4] + "-" + gb[4:]}, 200, "")
	if l, ok := hidden["league"].(map[string]any); !ok || len(l) != 3 || l["id"] != f.left {
		t.Fatal("hidden league resolution returned wrong scope")
	}
	get("GET", search, "", nil, 401, "UNAUTHENTICATED")
	get("GET", root(f.a)+"/matches", b, nil, 403, "LEAGUE_ACCESS_DENIED")
	inv := issue(f.a, a)
	code, ok := inv["code"].(string)
	if !ok {
		t.Fatal("no invitation code in authorized fixture")
	}
	preview := map[string]string{"group_number": ga, "code": strings.ToLower(code)}
	shown, _ := get("POST", "/api/leagues/join-preview", b, preview, 200, "")
	if l, ok := shown["league"].(map[string]any); !ok || len(l) != 3 || l["id"] != f.a || shown["expires_at"] == nil {
		t.Fatal("valid preview returned more or less than intended")
	}
	if members() != before {
		t.Fatal("search, number or preview changed membership")
	}

	joinID := newID()
	payload := joinPayload(joinID, preview["code"])
	var wg sync.WaitGroup
	responses := make(chan map[string]any, 4)
	for range cap(responses) {
		wg.Go(func() {
			res, _ := get("POST", root(f.a)+"/join", b, payload, 200, "")
			responses <- res
		})
	}
	wg.Wait()
	close(responses)
	for res := range responses {
		checkMembership(res, other, "member", "active")
	}
	var recorded int
	query(&recorded, `SELECT count(*) FROM public.league_events WHERE operation='league.join' AND client_request_id=$1`, joinID)
	if recorded != 1 {
		t.Fatal("parallel replay appended more than one event")
	}
	get("GET", root(f.a)+"/matches", b, nil, 200, "")
	get("GET", root(f.a)+"/invites/current", b, nil, 403, "FORBIDDEN")
	owner, _ := get("POST", root(f.a)+"/join", a, joinPayload(newID(), code), 200, "")
	checkMembership(owner, actor, "owner", "active")
	get("POST", root(f.b)+"/join", b, payload, 409, "IDEMPOTENCY_CONFLICT")
	get("POST", root(f.a)+"/join", b, joinPayload(joinID, "wrong"), 409, "IDEMPOTENCY_CONFLICT")
	exec(`UPDATE public.league_members SET status='removed',ended_at=now(),version=version+1 WHERE league_id=$1 AND user_id=$2`, f.a, other)
	replay, _ := get("POST", root(f.a)+"/join", b, payload, 200, "")
	checkMembership(replay, other, "member", "removed")
	get("GET", root(f.a)+"/matches", b, nil, 403, "LEAGUE_ACCESS_DENIED")
	rejoined, _ := get("POST", root(f.a)+"/join", b, joinPayload(newID(), code), 200, "")
	checkMembership(rejoined, other, "member", "active")

	leftCode := issue(f.left, b)["code"].(string)
	left, _ := get("POST", root(f.left)+"/join", a, joinPayload(newID(), leftCode), 200, "")
	checkMembership(left, actor, "member", "active")
	adminCode := issue(f.b, b)["code"].(string)
	adminJoin, _ := get("POST", root(f.b)+"/join", a, joinPayload(newID(), adminCode), 200, "")
	checkMembership(adminJoin, actor, "admin", "active")

	// Count checks below use a separate key to avoid crossing test groups.
	limitKey := newKey()
	limit1, limit2 := makeHTTP(limitKey, "2", "2", "60"), makeHTTP(limitKey, "2", "2", "60")
	// Avoid relying on wall-clock timing near the end of the fixed window.
	var seconds int
	query(&seconds, `SELECT extract(second FROM clock_timestamp())::integer`)
	if seconds >= 58 {
		time.Sleep(time.Duration(61-seconds) * time.Second)
	}
	bad := map[string]string{"group_number": ga, "code": "invalid"}
	limit1("POST", "/api/leagues/join-preview", b, bad, 404, "INVALID_INVITE")
	limit2("POST", root(f.a)+"/join", b, joinPayload(newID(), "invalid"), 404, "INVALID_INVITE")
	_, wait := limit1("POST", "/api/leagues/join-preview", b, preview, 429, "RATE_LIMITED")
	if retry, err := strconv.Atoi(wait); err != nil || retry < 1 || retry > 60 {
		t.Fatal("missing Retry-After")
	}
	limit1("GET", search, a, nil, 200, "")
	limit2("GET", search, a, nil, 200, "")
	limit1("GET", search, a, nil, 429, "RATE_LIMITED")
	ip := makeHTTP(newKey(), "", "10", "1")
	ip("POST", "/api/leagues/join-preview", a, bad, 404, "INVALID_INVITE")
	ip("POST", "/api/leagues/join-preview", b, bad, 429, "RATE_LIMITED")

	rotated := issue(f.a, a)
	get("POST", "/api/leagues/join-preview", b, preview, 404, "INVALID_INVITE")
	replay, _ = get("POST", root(f.a)+"/join", b, payload, 200, "")
	checkMembership(replay, other, "member", "active")
	exec(`WITH stamp AS (SELECT clock_timestamp() AS t) UPDATE public.league_invites
		SET issued_at=t-interval '168 hours',expires_at=t FROM stamp WHERE id=$1`, rotated["id"])
	get("POST", root(f.a)+"/join", b, joinPayload(newID(), rotated["code"].(string)), 404, "INVALID_INVITE")

	raceInvite := issue(f.removed, b)
	raceID := newID()
	newIssue := map[string]string{"client_request_id": newID()}
	var race map[string]any
	wg.Go(func() {
		race, _ = get("POST", root(f.removed)+"/join", a, joinPayload(raceID, raceInvite["code"].(string)), 0, "")
	})
	wg.Go(func() { get("POST", root(f.removed)+"/invites", b, newIssue, 201, "") })
	wg.Wait()
	var storedStatus string
	query(&storedStatus, `SELECT status FROM public.league_members WHERE league_id=$1 AND user_id=$2`, f.removed, actor)
	if (race["http_status"] != 200 || storedStatus != "active") && (race["http_status"] != 404 || storedStatus != "removed") {
		t.Fatal("reissue and join did not serialize")
	}
	t.Log("Q-14/Q-26 PASS: listed search/normalized cursor, hidden number/preview without membership, shared invitations, join/rejoin, active roles, replay/rotation/expiry/competition, shared limit and Retry-After")
}
