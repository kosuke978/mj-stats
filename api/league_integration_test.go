package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"net/url"
	"strings"
	"testing"
)

type leagueFixture struct {
	a, b, left, removed, legacy, missing, rule, season, guest string
}

type apiCall func(string, string, string, string) (int, map[string]any)

func verifyStatus(t *testing.T, call apiCall, method, path, token string, want int, code string) map[string]any {
	t.Helper()
	got, body := call(method, path, token, "")
	if got != want {
		t.Fatalf("%s %s: got %d, want %d, error=%v", method, path, got, want, body["error"])
	}
	if code != "" {
		response, _ := body["error"].(map[string]any)
		if response["code"] != code {
			t.Fatalf("%s %s: expected %s, got %v", method, path, code, response["code"])
		}
	}
	return body
}

func createLeagueFixture(t *testing.T, ctx context.Context, db *sql.DB, a, b string) leagueFixture {
	t.Helper()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal("begin league fixture")
	}
	defer tx.Rollback()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := tx.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("league fixture statement: %v", err)
		}
	}
	create := func(name, owner string, legacy bool) string {
		t.Helper()
		var id string
		if err := tx.QueryRowContext(ctx, `
			INSERT INTO public.leagues(name,owner_id,group_number)
			VALUES($1,$2,CASE WHEN $3::boolean THEN NULL ELSE substring(lpad((random()*999999999999)::bigint::text,12,'0'),1,12) END)
			RETURNING id`, name, owner, legacy).Scan(&id); err != nil {
			t.Fatalf("create fixture league: %v", err)
		}
		if !legacy {
			exec(`INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
				VALUES($1,$2,'registered','owner','active')`, id, owner)
		}
		return id
	}
	f := leagueFixture{missing: "00000000-0000-0000-0000-000000000001"}
	f.a = create("参照リーグA", a, false)
	f.b = create("参照リーグB", b, false)
	f.left = create("脱退したリーグ", b, false)
	f.removed = create("除名されたリーグ", b, false)
	f.legacy = create("旧リーグ", b, true)
	exec(`INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status,ended_at) VALUES
		($1,$4,'registered','admin','active',NULL),
		($2,$4,'registered','member','left',now()),
		($3,$4,'registered','member','removed',now()),
		($5,$4,'registered','member','legacy',NULL)`, f.b, f.left, f.removed, a, f.legacy)
	exec(`INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status,ended_at) VALUES
		($1,$2,'registered','member','left',now())`, f.a, b)
	if err := tx.QueryRowContext(ctx, `INSERT INTO public.users(name,participant_kind)
		VALUES('参照ゲスト','guest') RETURNING id`).Scan(&f.guest); err != nil {
		t.Fatal("create fixture guest")
	}
	exec(`INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
		VALUES($1,$2,'guest','member','active')`, f.a, f.guest)
	if err := tx.QueryRowContext(ctx, `INSERT INTO public.rules(league_id,name,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
		VALUES($1,'現行A',20,10,-10,-20,'exact_v1',true) RETURNING id`, f.a).Scan(&f.rule); err != nil {
		t.Fatal("create fixture rule")
	}
	exec(`INSERT INTO public.rules(league_id,name,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
		VALUES($1,'停止A',20,10,-10,-20,'exact_v1',false),
		($1,'旧A',20,10,-10,-20,'legacy_unverified',false),
		($2,'現行B',20,10,-10,-20,'exact_v1',true)`, f.a, f.b)
	if err := tx.QueryRowContext(ctx, `INSERT INTO public.seasons(league_id,name,end_date)
		VALUES($1,'シーズンA','2026-11-30') RETURNING id`, f.a).Scan(&f.season); err != nil {
		t.Fatal("create fixture season")
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit league fixture: %v", err)
	}

	t.Cleanup(func() {
		cleanup, err := db.Begin()
		if err != nil {
			t.Errorf("begin fixture cleanup: %v", err)
			return
		}
		defer cleanup.Rollback()
		targets := []string{f.a, f.b, f.left, f.removed, f.legacy}
		// All targets were created by this test. Deferred owner checks see
		// the final state after both the leagues and memberships are removed.
		for _, table := range []string{"match_results", "matches", "seasons", "rules", "league_members", "leagues"} {
			column := "league_id"
			if table == "leagues" {
				column = "id"
			}
			_, err = cleanup.Exec(`DELETE FROM public.`+table+` WHERE `+column+` IN ($1,$2,$3,$4,$5)`,
				targets[0], targets[1], targets[2], targets[3], targets[4])
			if err != nil {
				t.Errorf("cleanup league fixture %s: %v", table, err)
				return
			}
		}
		if _, err := cleanup.Exec(`DELETE FROM public.users WHERE id=$1`, f.guest); err != nil {
			t.Errorf("cleanup guest: %v", err)
			return
		}
		if err := cleanup.Commit(); err != nil {
			t.Errorf("commit fixture cleanup: %v", err)
		}
	})
	return f
}

func testLeagueReferences(t *testing.T, ctx context.Context, admin *sql.DB, call apiCall, a, b, participant, other string) {
	f := createLeagueFixture(t, ctx, admin, participant, other)
	root := "/api/leagues/"
	body := verifyStatus(t, call, "GET", "/api/leagues", a, 200, "")
	leagues := body["leagues"].([]any)
	roles := map[any]any{}
	for _, v := range leagues {
		l := v.(map[string]any)
		roles[l["id"]] = l["my_role"]
	}
	if len(roles) != 2 || roles[f.a] != "owner" || roles[f.b] != "admin" {
		t.Fatal("wrong league scope or leaked role")
	}
	detail := verifyStatus(t, call, "GET", root+f.b, a, 200, "")["league"].(map[string]any)
	if detail["my_role"] != "admin" {
		t.Fatal("wrong detail role")
	}
	for _, suffix := range []string{"", "/participants", "/members", "/rules", "/seasons"} {
		verifyStatus(t, call, "GET", root+f.a+suffix, "", 401, "UNAUTHENTICATED")
		verifyStatus(t, call, "GET", root+f.a+suffix, b, 403, "LEAGUE_ACCESS_DENIED")
		for _, id := range []string{f.left, f.removed, f.legacy, f.missing} {
			verifyStatus(t, call, "GET", root+id+suffix, a, 403, "LEAGUE_ACCESS_DENIED")
		}
	}
	participants := verifyStatus(t, call, "GET", root+f.a+"/participants", a, 200, "")["participants"].([]any)
	members := verifyStatus(t, call, "GET", root+f.a+"/members", a, 200, "")["members"].([]any)
	if len(participants) != 2 || len(members) != 3 {
		t.Fatal("participant eligibility or member visibility wrong")
	}
	for _, v := range participants {
		p := v.(map[string]any)
		if len(p) != 4 || (p["id"] == f.guest && p["kind"] != "guest") || p["id"] == other {
			t.Fatal("wrong participant shape or access")
		}
	}
	for _, v := range members {
		m := v.(map[string]any)
		if len(m) != 6 || (m["user_id"] == other && m["status"] != "left") {
			t.Fatal("wrong member shape or state")
		}
	}
	rules := root + f.a + "/rules"
	for filter, want := range map[string]int{"": 1, "?available=false": 1, "?available=all": 2} {
		got := verifyStatus(t, call, "GET", rules+filter, a, 200, "")["rules"].([]any)
		if len(got) != want {
			t.Fatal("rule availability or league filtering")
		}
	}
	path := rules + "?available=all&limit=1"
	first := verifyStatus(t, call, "GET", path, a, 200, "")
	cursor := url.QueryEscape(first["next_cursor"].(string))
	second := verifyStatus(t, call, "GET", path+"&cursor="+cursor, a, 200, "")
	if second["next_cursor"] != nil || second["rules"].([]any)[0].(map[string]any)["id"] == first["rules"].([]any)[0].(map[string]any)["id"] {
		t.Fatal("reference cursor skipped or duplicated rule")
	}
	for _, invalid := range []string{rules + "?available=true&cursor=" + cursor, root + f.b + "/rules?available=all&cursor=" + cursor,
		root + f.a + "/seasons?cursor=" + cursor, rules + "?cursor=garbage", rules + "?limit=101", rules + "?limit=1&limit=2",
		rules + "?role=owner"} {
		verifyStatus(t, call, "GET", invalid, a, 400, "INVALID_INPUT")
	}
	seasons := verifyStatus(t, call, "GET", root+f.a+"/seasons", a, 200, "")["seasons"].([]any)
	if len(seasons) != 1 || seasons[0].(map[string]any)["id"] != f.season || seasons[0].(map[string]any)["start_date"] != nil {
		t.Fatal("season UUID/NULL or scope")
	}
	t.Log("Q-14/Q-16/Q-26 PASS: Auth, active membership and per-league role; filtered refs and scoped cursor")
}

func testLeagueHistory(t *testing.T, ctx context.Context, admin *sql.DB, call apiCall, a, b, participant, other string) {
	f := createLeagueFixture(t, ctx, admin, participant, other)
	const first = "e2a00000-0000-4000-8000-000000000002"
	const second = "e2a00000-0000-4000-8000-000000000001"
	const foreign = "e2a00000-0000-4000-8000-000000000003"
	const old = "e2a00000-0000-4000-8000-000000000004"
	insert := func(query string, args ...any) {
		t.Helper()
		if _, err := admin.ExecContext(ctx, query, args...); err != nil {
			t.Fatalf("history fixture: %v", err)
		}
	}
	var seasonB string
	if err := admin.QueryRowContext(ctx, `INSERT INTO public.seasons(league_id,name) VALUES($1,'シーズンB') RETURNING id`, f.b).Scan(&seasonB); err != nil {
		t.Fatal("foreign season fixture")
	}
	insert(`INSERT INTO public.matches(id,league_id,rule_id,season_id,recorded_by,match_date,created_at,data_origin) VALUES
		($1,$5,$6,$7,$8,'2026-11-01T00:00:00+09',NULL,'app'),
		($2,$5,$6,NULL,$8,'2026-11-01T00:00:00+09',NULL,'app'),
		($3,$9,(SELECT id FROM rules WHERE league_id=$9),$11,$10,'2026-11-02T00:00:00+09',NULL,'app'),
		($4,NULL,$6,$7,NULL,NULL,NULL,'legacy')`, first, second, foreign, old, f.a, f.rule, f.season, participant, f.b, other, seasonB)
	// Old fixture shares a rule and season with A, but has no known league.
	t.Cleanup(func() {
		if _, err := admin.Exec(`DELETE FROM public.matches WHERE id=$1`, old); err != nil {
			t.Errorf("cleanup legacy history fixture: %v", err)
		}
	})
	insert(`INSERT INTO public.match_results(league_id,match_id,user_id,raw_score,final_point,rank)
		VALUES($1,$2,$4,-100,-16.7,4),($1,$2,$5,35000,24.1,1),($3,$6,$7,29000,1.1,2)`,
		f.a, first, f.b, participant, f.guest, foreign, other)

	path := "/api/leagues/" + f.a + "/matches"
	foreignPath := "/api/leagues/" + f.b + "/matches"
	for _, id := range []string{f.left, f.removed, f.legacy, f.missing} {
		verifyStatus(t, call, "GET", "/api/leagues/"+id+"/matches", a, 403, "LEAGUE_ACCESS_DENIED")
	}
	verifyStatus(t, call, "GET", path, b, 403, "LEAGUE_ACCESS_DENIED")
	verifyStatus(t, call, "GET", path+"?season="+seasonB, b, 403, "LEAGUE_ACCESS_DENIED")
	verifyStatus(t, call, "GET", path+"?season="+seasonB, a, 404, "NOT_FOUND")
	verifyStatus(t, call, "GET", path+"?season="+f.missing, a, 404, "NOT_FOUND")
	verifyStatus(t, call, "GET", path+"?season=1", a, 400, "INVALID_INPUT")
	verifyStatus(t, call, "GET", "/api/matches", a, 400, "INVALID_INPUT")
	verifyStatus(t, call, "GET", "/api/matches?league_id="+f.a, b, 403, "LEAGUE_ACCESS_DENIED")
	verifyStatus(t, call, "GET", "/api/matches?league_id="+f.a+"&league_id="+f.b, a, 400, "INVALID_INPUT")
	for suffix, ids := range map[string][]string{
		"": {first, second}, "?season=all&status=valid": {first, second}, "?season=" + f.season: {first},
		"?season=unassigned": {second}, "?status=cancelled": {},
	} {
		items := verifyStatus(t, call, "GET", path+suffix, a, 200, "")["matches"].([]any)
		if len(items) != len(ids) {
			t.Fatalf("history scope %s: wrong number of records", suffix)
		}
		for i, item := range items {
			if item.(map[string]any)["id"] != ids[i] {
				t.Fatal("wrong history ordering or cross-league result")
			}
		}
	}

	page := verifyStatus(t, call, "GET", path+"?limit=1", a, 200, "")
	cursor := url.QueryEscape(page["next_cursor"].(string))
	decoded, err := base64.RawURLEncoding.DecodeString(page["next_cursor"].(string))
	if err != nil {
		t.Fatal("history cursor encoding")
	}
	// A string can parse as a Go date but still be invalid for timestamptz.
	badDate := strings.Replace(string(decoded), "2026-", "0000-", 1)
	badCursor := base64.RawURLEncoding.EncodeToString([]byte(badDate))
	verifyStatus(t, call, "GET", path+"?cursor="+badCursor, a, 400, "INVALID_INPUT")

	next := verifyStatus(t, call, "GET", path+"?limit=1&cursor="+cursor, a, 200, "")
	if next["next_cursor"] != nil || next["matches"].([]any)[0].(map[string]any)["id"] != second {
		t.Fatal("timestamp ties must paginate by ID with NULL created_at")
	}
	for _, target := range []string{foreignPath + "?cursor=" + cursor, path + "?season=unassigned&cursor=" + cursor, path + "?status=valid&cursor=" + cursor} {
		verifyStatus(t, call, "GET", target, a, 400, "INVALID_INPUT")
	}
	foreignPage := verifyStatus(t, call, "GET", foreignPath, b, 200, "")
	if len(foreignPage["matches"].([]any)) != 1 || foreignPage["matches"].([]any)[0].(map[string]any)["id"] != foreign {
		t.Fatal("second user received another league's history")
	}
	// Same bearer must observe the new membership state on the next request.
	insert(`UPDATE public.league_members SET status='active',ended_at=NULL WHERE league_id=$1 AND user_id=$2`, f.a, other)
	verifyStatus(t, call, "GET", path+"?cursor="+cursor, b, 400, "INVALID_INPUT")
	verifyStatus(t, call, "GET", path, b, 200, "")
	insert(`UPDATE public.league_members SET status='removed',ended_at=now() WHERE league_id=$1 AND user_id=$2`, f.a, other)
	verifyStatus(t, call, "GET", path, b, 403, "LEAGUE_ACCESS_DENIED")

	if code, _ := call("PATCH", "/api/users/me", a, `{"name":"履歴に表示する現在名"}`); code != 200 {
		t.Fatal("history rename")
	}
	item := verifyStatus(t, call, "GET", "/api/matches?league_id="+f.a, a, 200, "")["matches"].([]any)[0].(map[string]any)
	result := item["results"].([]any)[1].(map[string]any)
	if item["id"] != first || item["league_id"] != f.a || item["rule_id"] != f.rule || item["created_at"] != nil ||
		item["match_date"] != "2026-10-31T15:00:00.000000Z" || result["user_id"] != participant ||
		result["display_name"] != "履歴に表示する現在名" || result["rank"] != float64(4) ||
		result["raw_score"] != float64(-100) || result["point"] != -16.7 {
		t.Fatal("history must preserve timestamps, original ID and stored score, rank and numeric points")
	}
	t.Log("Q-14/Q-16/Q-22/Q-26 PASS: two users, app-only scoped history, 403/404, season modes, cursor scope/ties, rename and original result values")
}
