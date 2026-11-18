package main

import (
	"context"
	"database/sql"
	"net/url"
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
