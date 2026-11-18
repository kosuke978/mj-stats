package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/controllers"
	"github.com/kosuke/mj-stats-api/httpx"
)

func leagueRequest(id, name string) string {
	return fmt.Sprintf(`{"name":%q,"client_request_id":%q}`, name, id)
}

func testLeagueCreation(t *testing.T, ctx context.Context, db, admin *sql.DB, verifier *auth.Verifier, call apiCall, a, b, actor, other string) {
	t.Helper()
	const createPath = "/api/leagues"
	const firstID = "3a000000-0000-4000-8000-00000000000a"
	const burstID = "3a000000-0000-4000-8000-00000000000b"
	const droppedID = "3a000000-0000-4000-8000-00000000000c"
	const collisionID = "3a000000-0000-4000-8000-00000000000d"
	const exhaustedID = "3a000000-0000-4000-8000-00000000000e"
	const rollbackID = "3a000000-0000-4000-8000-00000000000f"
	prefix := "作成試験-" + uniqueSuffix()
	label := func(s string) string { return prefix + "-" + s }

	// Remove only this subtest's ordinary leagues before the Auth-removal
	// regression checks that follow in the parent test.
	t.Cleanup(func() {
		tx, err := admin.Begin()
		if err != nil {
			t.Errorf("creation cleanup transaction: %v", err)
			return
		}
		defer tx.Rollback()
		for _, table := range []string{"league_events", "rules", "league_members", "leagues"} {
			column := "league_id"
			if table == "leagues" {
				column = "id"
			}
			_, err := tx.Exec(`DELETE FROM public.`+table+` WHERE `+column+` IN
				(SELECT id FROM public.leagues WHERE owner_id IN ($1,$2) AND name LIKE $3)`, actor, other, prefix+"-%")
			if err != nil {
				t.Errorf("cleanup creation %s: %v", table, err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			t.Errorf("commit creation cleanup: %v", err)
		}
	})

	type counts struct{ leagues, members, rules, events, seasons int }
	tally := func() counts {
		t.Helper()
		var result counts
		err := admin.QueryRowContext(ctx, `WITH owned AS (SELECT id FROM public.leagues WHERE owner_id IN ($1,$2))
			SELECT (SELECT count(*) FROM owned),
				(SELECT count(*) FROM public.league_members m JOIN owned l ON l.id=m.league_id),
				(SELECT count(*) FROM public.rules r JOIN owned l ON l.id=r.league_id),
				(SELECT count(*) FROM public.league_events WHERE actor_id IN ($1,$2)),
				(SELECT count(*) FROM public.seasons s JOIN owned l ON l.id=s.league_id)`, actor, other).
			Scan(&result.leagues, &result.members, &result.rules, &result.events, &result.seasons)
		if err != nil {
			t.Fatalf("creation counts: %v", err)
		}
		return result
	}
	checkBundle := func(result map[string]any, owner, requestID, name string) string {
		t.Helper()
		l, ok := result["league"].(map[string]any)
		r, okRule := result["rule"].(map[string]any)
		if !ok || !okRule || len(result) != 2 || l["name"] != name || l["my_role"] != "owner" ||
			r["default_points"] != float64(25000) || r["return_points"] != float64(30000) ||
			!reflect.DeepEqual(r["uma"], []any{float64(20), float64(10), float64(-10), float64(-20)}) ||
			r["calculation_version"] != "exact_v1" || r["available"] != true || r["version"] != "1" {
			t.Fatal("wrong creation response")
		}
		number, _ := l["group_number"].(string)
		if len(number) != 12 || strings.Trim(number, "0123456789") != "" {
			t.Fatal("non-string or invalid group number")
		}
		var valid bool
		err := admin.QueryRowContext(ctx, `SELECT
			EXISTS (SELECT 1 FROM public.leagues WHERE id=$1 AND owner_id=$2 AND group_number=$5 AND NOT search_listed)
			AND (SELECT count(*) FROM public.league_members WHERE league_id=$1)=1
			AND EXISTS (SELECT 1 FROM public.league_members WHERE league_id=$1 AND user_id=$2
			  AND role='owner' AND status='active' AND participant_kind='registered')
			AND (SELECT count(*) FROM public.rules WHERE league_id=$1)=1
			AND EXISTS (SELECT 1 FROM public.rules WHERE league_id=$1 AND id=$3
			  AND default_points=25000 AND return_points=30000 AND (uma_1,uma_2,uma_3,uma_4)=(20,10,-10,-20)
			  AND calculation_version='exact_v1' AND available)
			AND (SELECT count(*) FROM public.league_events WHERE league_id=$1)=1
			AND EXISTS (SELECT 1 FROM public.league_events WHERE league_id=$1 AND target=$1 AND actor_id=$2
			  AND initial_rule_id=$3 AND client_request_id=$4 AND operation='league.create')
			AND NOT EXISTS (SELECT 1 FROM public.seasons WHERE league_id=$1)`, l["id"], owner, r["id"], requestID, number).Scan(&valid)
		if err != nil || !valid {
			t.Fatalf("incomplete or duplicate creation bundle: %v", err)
		}
		return l["id"].(string)
	}
	assert := func(do apiCall, token, input string, status int, code string) map[string]any {
		t.Helper()
		got, response := do("POST", createPath, token, input)
		if got != status {
			t.Fatalf("create: got %d want %d (%v)", got, status, response["error"])
		}
		if code != "" {
			gotError, _ := response["error"].(map[string]any)
			if gotError["code"] != code {
				t.Fatalf("create error: got %v want %s", gotError["code"], code)
			}
		}
		return response
	}

	if tally() != (counts{}) {
		t.Fatal("creation fixture users must have no leagues or operations")
	}
	assert(call, "", leagueRequest(firstID, label("初回")), 401, "UNAUTHENTICATED")
	for _, input := range []string{
		`{"name":"name","client_request_id":"bad"}`, `{"name":"name"}`,
		`{"name":null,"client_request_id":"` + firstID + `"}`,
		`{"name":"name","name":"other","client_request_id":"` + firstID + `"}`,
		`{"name":"name","client_request_id":"` + firstID + `","owner_id":"` + other + `"}`,
		`{"name":"name","client_request_id":"` + firstID + `","role":"owner"}`,
		leagueRequest(firstID, "　 "), leagueRequest(firstID, "改\n行"), leagueRequest(firstID, strings.Repeat("雀", 101)),
	} {
		assert(call, a, input, 400, "INVALID_INPUT")
	}
	if tally() != (counts{}) {
		t.Fatal("invalid input altered creation rows")
	}

	firstName := label("初回")
	first := assert(call, a, leagueRequest(firstID, "　"+firstName+"　"), 201, "")
	id := checkBundle(first, actor, firstID, firstName)
	root := createPath + "/" + id
	leagues := verifyStatus(t, call, "GET", createPath, a, 200, "")["leagues"].([]any)
	if len(leagues) != 1 || !reflect.DeepEqual(leagues[0], first["league"]) {
		t.Fatal("new league and role missing from list")
	}
	if detail := verifyStatus(t, call, "GET", root, a, 200, "")["league"]; !reflect.DeepEqual(detail, first["league"]) {
		t.Fatal("detail disagrees with create")
	}
	rules := verifyStatus(t, call, "GET", root+"/rules", a, 200, "")["rules"].([]any)
	if len(rules) != 1 || !reflect.DeepEqual(rules[0], first["rule"]) {
		t.Fatal("initial rule missing from scoped rules")
	}
	for _, path := range []string{root, root + "/members", root + "/rules", root + "/matches"} {
		verifyStatus(t, call, "GET", path, b, 403, "LEAGUE_ACCESS_DENIED")
	}
	if reflect.DeepEqual(first["league"], assert(call, b, leagueRequest(firstID, label("別の本人")), 201, "")["league"]) {
		t.Fatal("operation identity was not scoped by actor")
	}

	if replay := assert(call, a, leagueRequest(strings.ToUpper(firstID), firstName), 200, ""); !reflect.DeepEqual(first, replay) {
		t.Fatal("normalized sequential replay disagrees")
	}
	beforeConflict := tally()
	assert(call, a, leagueRequest(firstID, label("内容違い")), 409, "IDEMPOTENCY_CONFLICT")
	if tally() != beforeConflict || beforeConflict != (counts{2, 2, 2, 2, 0}) {
		t.Fatal("replay/conflict created extra rows")
	}

	type attempt struct {
		status   int
		response map[string]any
	}
	const workers = 8
	results := make(chan attempt, workers)
	start := make(chan struct{})
	var group sync.WaitGroup
	burstName := label("並行")
	for range workers {
		group.Go(func() {
			<-start
			status, body := call("POST", createPath, a, leagueRequest(burstID, burstName))
			results <- attempt{status, body}
		})
	}
	close(start)
	group.Wait()
	close(results)
	firstCount, total := 0, 0
	var burst map[string]any
	for item := range results {
		total++
		switch item.status {
		case 201:
			firstCount++
		case 200:
		default:
			t.Fatalf("parallel replay status %d", item.status)
		}
		if burst == nil {
			burst = item.response
		} else if !reflect.DeepEqual(burst, item.response) {
			t.Fatal("parallel replay returned different IDs")
		}
	}
	if total != workers || firstCount != 1 || tally() != (counts{3, 3, 3, 3, 0}) {
		t.Fatal("parallel replay did not create exactly one result")
	}
	checkBundle(burst, actor, burstID, burstName)

	// Let the real handler commit, then discard its complete response by
	// closing the connection before writing any HTTP bytes to the client.
	var committed map[string]any
	committedResult := make(chan map[string]any, 1)
	handler := router(db, verifier, []string{"http://localhost:3000"})
	dropper := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, r)
		if rec.Code != 201 {
			w.WriteHeader(rec.Code)
			return
		}
		var value map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &value)
		committedResult <- value
		conn, _, err := http.NewResponseController(w).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}))
	defer dropper.Close()
	droppedName := label("応答切断")
	req, _ := http.NewRequestWithContext(ctx, "POST", dropper.URL+createPath, strings.NewReader(leagueRequest(droppedID, droppedName)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+a)
	reply, err := dropper.Client().Do(req)
	if reply != nil {
		reply.Body.Close()
	}
	if err == nil {
		t.Fatal("test did not drop the HTTP response")
	}
	select {
	case committed = <-committedResult:
	default:
		t.Fatal("test did not commit before dropping response")
	}
	if recovered := assert(call, a, leagueRequest(droppedID, droppedName), 200, ""); !reflect.DeepEqual(committed, recovered) {
		t.Fatal("lost-response retry changed the result")
	}
	checkBundle(committed, actor, droppedID, droppedName)

	var freshNumber string
	err = admin.QueryRowContext(ctx, `SELECT candidate FROM
		(SELECT lpad(i::text,12,'0') AS candidate FROM generate_series(1,100) i) numbers
		WHERE NOT EXISTS (SELECT 1 FROM public.leagues WHERE group_number=candidate) ORDER BY candidate LIMIT 1`).Scan(&freshNumber)
	if err != nil {
		t.Fatal("no free number in test fixtures")
	}
	var draws atomic.Int32
	var exhaust atomic.Bool
	guard := &auth.Guard{DB: db, Verifier: verifier}
	creator := &controllers.LeagueCreator{Auth: guard, NextGroupNumber: func() (string, error) {
		if draws.Add(1) == 1 || exhaust.Load() {
			return first["league"].(map[string]any)["group_number"].(string), nil
		}
		return freshNumber, nil
	}}
	collisionRouter := gin.New()
	collisionRouter.Use(httpx.RequestMetadata(), guard.Middleware(), guard.RequireProfile())
	collisionRouter.POST(createPath, creator.Create)
	collisionCall := func(method, path, token, input string) (int, map[string]any) {
		req := httptest.NewRequest(method, path, strings.NewReader(input)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		collisionRouter.ServeHTTP(rec, req)
		var value map[string]any
		_ = json.Unmarshal(rec.Body.Bytes(), &value)
		return rec.Code, value
	}
	collisionName := label("番号再生成")
	retry := assert(collisionCall, a, leagueRequest(collisionID, collisionName), 201, "")
	if retry["league"].(map[string]any)["group_number"] != freshNumber || draws.Load() != 2 {
		t.Fatal("number conflict did not regenerate or lost leading zeros")
	}
	checkBundle(retry, actor, collisionID, collisionName)
	beforeExhaust := tally()
	exhaust.Store(true)
	draws.Store(0)
	assert(collisionCall, a, leagueRequest(exhaustedID, label("上限")), 503, "TEMPORARILY_UNAVAILABLE")
	if draws.Load() != 6 || tally() != beforeExhaust {
		t.Fatal("number exhaustion must stop after five regenerations with no rows")
	}

	rollbackName := label("後段失敗")
	func() {
		// The final statement fails under the actual Go DB role after league,
		// membership and rule inserts. Restore this exact local column grant.
		if _, err := admin.Exec(`REVOKE INSERT (after) ON public.league_events FROM mjstats_api`); err != nil {
			t.Fatal("inject creation event failure")
		}
		defer func() {
			if _, err := admin.Exec(`GRANT INSERT (after) ON public.league_events TO mjstats_api`); err != nil {
				t.Errorf("restore local creation event grant: %v", err)
			}
		}()
		assert(call, a, leagueRequest(rollbackID, rollbackName), 503, "TEMPORARILY_UNAVAILABLE")
		if tally() != beforeExhaust {
			t.Fatal("event failure left partial league, member, rule or operation rows")
		}
	}()
	recovered := assert(call, a, leagueRequest(rollbackID, rollbackName), 201, "")
	checkBundle(recovered, actor, rollbackID, rollbackName)
	if tally() != (counts{6, 6, 6, 6, 0}) {
		t.Fatal("unexpected number of created rows")
	}
	t.Log("Q-14/Q-25/Q-26 PASS: real Auth creation + scoped reads, rejection, zero-padded collision retry/exhaustion, sequential/parallel/lost-response replay, and atomic rollback")
}
