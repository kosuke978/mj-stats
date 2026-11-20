package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"sort"
	"testing"
)

func testStep5(t *testing.T, ctx context.Context, admin *sql.DB, call apiCall, ownerToken, adminToken, memberToken, owner, manager, member string) {
	f := createLeagueFixture(t, ctx, admin, owner, manager)
	root, other := "/api/leagues/"+f.a, "/api/leagues/"+f.b
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := admin.ExecContext(ctx, q, args...); err != nil {
			t.Fatal(err)
		}
	}
	row := func(q string, args ...any) string {
		t.Helper()
		var result string
		if err := admin.QueryRowContext(ctx, q, args...).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	uid := func() string {
		return fmt.Sprintf("%s-0000-4000-8000-%s", uniqueSuffix()[:8], uniqueSuffix()[:12])
	}
	send := func(method, path, token string, body any) (int, map[string]any) {
		data, _ := json.Marshal(body)
		return call(method, path, token, string(data))
	}
	verify := func(method, path, token string, body any, status int, errorCode string) map[string]any {
		t.Helper()
		got, data := send(method, path, token, body)
		if problem, _ := data["error"].(map[string]any); got != status || (errorCode != "" && problem["code"] != errorCode) {
			t.Fatalf("%s %s got %d %v, want %d %s", method, path, got, problem, status, errorCode)
		}
		return data
	}
	var guests []string
	t.Cleanup(func() {
		tx, err := admin.Begin()
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback()
		for _, table := range []string{"match_revisions", "match_results", "matches", "participant_links", "league_events", "owner_transfers", "league_invites"} {
			if _, err = tx.Exec("DELETE FROM public."+table+" WHERE league_id IN ($1,$2)", f.a, f.b); err != nil {
				t.Error(err)
				return
			}
		}
		for _, id := range guests {
			if _, err = tx.Exec("DELETE FROM public.league_members WHERE user_id=$1", id); err != nil {
				t.Error(err)
				return
			}
			if _, err = tx.Exec("DELETE FROM public.users WHERE id=$1", id); err != nil {
				t.Error(err)
				return
			}
		}
		if err = tx.Commit(); err != nil {
			t.Error(err)
		}
	})
	exec(`UPDATE public.league_members SET status='active',ended_at=NULL,role='admin' WHERE league_id=$1 AND user_id=$2`, f.a, manager)
	exec(`INSERT INTO public.league_members(league_id,user_id,participant_kind,role,status)
		VALUES ($1,$3,'registered','member','active'),($2,$3,'registered','member','active')`, f.a, f.b, member)
	// League B is owned by the third actor; the same manager is admin in A and member in B.
	tx, err := admin.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, q := range []string{
		`UPDATE public.league_members SET role='member' WHERE league_id=$1 AND user_id=$2 AND $3::uuid IS NOT NULL`,
		`UPDATE public.league_members SET role='owner' WHERE league_id=$1 AND user_id=$3 AND $2::uuid IS NOT NULL`,
		`UPDATE public.leagues SET owner_id=$3 WHERE id=$1 AND owner_id=$2`,
	} {
		if _, err := tx.ExecContext(ctx, q, f.b, manager, member); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	verify("GET", root+"/settings", adminToken, nil, 200, "")
	verify("GET", other+"/settings", adminToken, nil, 403, "FORBIDDEN")
	verify("GET", root+"/settings", memberToken, nil, 403, "FORBIDDEN")
	verify("GET", root+"/ranking", "", nil, 401, "UNAUTHENTICATED")
	verify("GET", "/api/leagues/"+f.left+"/ranking", ownerToken, nil, 403, "LEAGUE_ACCESS_DENIED")
	verify("GET", root+"/ranking?season=all&season=unassigned", ownerToken, nil, 400, "INVALID_INPUT")
	if entries := verify("GET", other+"/ranking", adminToken, nil, 200, "")["entries"].([]any); len(entries) != 0 {
		t.Fatal("empty league")
	}
	setting := map[string]any{"name": "Q18 Step 5", "search_listed": true, "version": "1", "client_request_id": uid()}
	verify("PATCH", other+"/settings", adminToken, setting, 403, "FORBIDDEN")
	verify("PATCH", root+"/settings", adminToken, setting, 200, "")
	verify("PATCH", root+"/settings", adminToken, setting, 200, "")
	if data := verify("GET", root+"/settings", ownerToken, nil, 200, "")["settings"].(map[string]any); data["search_listed"] != true || data["version"] != "2" {
		t.Fatal("settings version")
	}
	role := map[string]any{"role": "admin", "version": "1", "client_request_id": uid()}
	verify("PATCH", root+"/members/"+member, adminToken, role, 403, "FORBIDDEN")
	verify("PATCH", root+"/members/"+owner, ownerToken, role, 409, "STATE_CONFLICT")
	reason := func(version, reason string) map[string]any {
		return map[string]any{"version": version, "reason": reason, "client_request_id": uid()}
	}
	verify("POST", root+"/members/"+manager+"/remove", adminToken, reason("1", "除名"), 403, "FORBIDDEN")
	verify("POST", root+"/leave", ownerToken, map[string]any{"client_request_id": uid()}, 409, "STATE_CONFLICT")
	verify("POST", root+"/owner-transfers", adminToken, map[string]any{"client_request_id": uid(), "to_user_id": member}, 403, "FORBIDDEN")

	newSeason := func(name string) string {
		return verify("POST", root+"/seasons", adminToken, map[string]any{"client_request_id": uid(), "name": name}, 201, "")["id"].(string)
	}
	s2 := newSeason("Q20 season 2")
	empty := newSeason("Q20 empty season")
	verify("GET", other+"/ranking?season="+s2, adminToken, nil, 404, "NOT_FOUND")
	if entries := verify("GET", root+"/ranking?season="+empty, memberToken, nil, 200, "")["entries"].([]any); len(entries) != 0 {
		t.Fatal("empty season")
	}
	seasonChange := map[string]any{"client_request_id": uid(), "name": "Q20 season empty (edited)", "version": "1", "start_date": "2020-01-01"}
	verify("PATCH", root+"/seasons/"+empty, adminToken, seasonChange, 200, "")
	seasonPath := root + "/seasons/" + empty
	seasonRange := func(id string) string {
		return row(`SELECT name||'|'||COALESCE(start_date::text,'-')||'|'||COALESCE(end_date::text,'-')
			FROM public.seasons WHERE id=$1`, id)
	}
	endOnly := map[string]any{"client_request_id": uid(), "version": "2", "end_date": "2019-12-31"}
	verify("PATCH", seasonPath, adminToken, endOnly, 400, "INVALID_INPUT")
	endOnly["end_date"] = "2020-12-31"
	verify("PATCH", seasonPath, adminToken, endOnly, 200, "")
	startOnly := map[string]any{"client_request_id": uid(), "version": "3", "start_date": "2021-01-01"}
	verify("PATCH", seasonPath, adminToken, startOnly, 400, "INVALID_INPUT")
	if got := seasonRange(empty); got != "Q20 season empty (edited)|2020-01-01|2020-12-31" {
		t.Fatalf("one-sided season date patch: %s", got)
	}
	startOnly["start_date"] = nil
	verify("PATCH", seasonPath, adminToken, startOnly, 200, "")
	if got := seasonRange(empty); got != "Q20 season empty (edited)|-|2020-12-31" {
		t.Fatalf("explicit null must clear only the supplied date: %s", got)
	}
	if result := verify("PATCH", seasonPath, adminToken, endOnly, 200, ""); result["version"] != "3" {
		t.Fatal("replay should return the originally applied version")
	}
	endOnly["start_date"] = nil
	verify("PATCH", seasonPath, adminToken, endOnly, 409, "IDEMPOTENCY_CONFLICT")
	// Simulate a pre-fix audit event whose hash did not distinguish omission and null.
	legacyID := seasonChange["client_request_id"]
	legacyBody, err := json.Marshal([]any{f.a, empty, "1", "", []any{seasonChange["name"], "2020-01-01", nil}})
	if err != nil {
		t.Fatal(err)
	}
	exec(`UPDATE public.league_events SET request_hash=$2 WHERE client_request_id=$1`, legacyID, fmt.Sprintf("%x", sha256.Sum256(legacyBody)))
	if result := verify("PATCH", seasonPath, adminToken, seasonChange, 200, ""); result["version"] != "2" {
		t.Fatal("pre-fix season replay must preserve the applied version")
	}
	if got := seasonRange(empty); got != "Q20 season empty (edited)|-|2020-12-31" {
		t.Fatalf("replay must leave the latest season period intact: %s", got)
	}
	rule := verify("POST", root+"/rules", adminToken, map[string]any{"client_request_id": uid(), "name": "Q18 new rule", "default_points": 25000,
		"return_points": 30000, "uma": []int{20, 10, -10, -20}}, 201, "")["id"].(string)
	verify("PATCH", root+"/rules/"+rule, adminToken, map[string]any{"client_request_id": uid(), "available": false, "version": "1"}, 200, "")

	for i := 0; i < 5; i++ {
		id := verify("POST", root+"/guests", ownerToken, map[string]any{"name": fmt.Sprintf("Q20 guest %d", i), "client_request_id": uid()}, 201, "")["participant"].(map[string]any)["id"].(string)
		guests = append(guests, id)
	}
	verify("PATCH", root+"/guests/"+guests[4], adminToken, map[string]any{"client_request_id": uid(), "name": "新しいゲスト名", "version": "1"}, 200, "")
	makeMatch := func(ids []string, scores []int, season any) map[string]any {
		players := make([]map[string]any, len(ids))
		for i, id := range ids {
			players[i] = map[string]any{"user_id": id, "raw_score": scores[i]}
		}
		return map[string]any{"client_request_id": uid(), "match_date": "2024-11-01T09:00:00+09:00", "season_id": season, "rule_id": f.rule, "players": players}
	}
	save := func(ids []string, scores []int, season any) map[string]any {
		return verify("POST", root+"/matches", memberToken, makeMatch(ids, scores, season), 201, "")
	}
	m1 := save(guests[:4], []int{40000, 30000, 20000, 10000}, f.season)
	m1Path := root + "/matches/" + m1["id"].(string)
	save(guests[:4], []int{10000, 20000, 30000, 40000}, nil)
	m3 := save(guests[:4], []int{33300, 33300, 33300, 100}, s2)
	save(guests[:4], []int{33300, 33300, 33300, 100}, s2)
	cancelPath := root + "/matches/" + m3["id"].(string) + "/cancel"
	cancel := reason("1", "重複対局")
	verify("POST", cancelPath, memberToken, cancel, 403, "FORBIDDEN")
	verify("POST", cancelPath, adminToken, cancel, 200, "")
	verify("POST", cancelPath, adminToken, cancel, 200, "")
	cancel["reason"] = "別の取消理由"
	verify("POST", cancelPath, adminToken, cancel, 409, "IDEMPOTENCY_CONFLICT")
	cancelled := verify("GET", root+"/matches?status=cancelled", memberToken, nil, 200, "")["matches"].([]any)
	if len(cancelled) != 1 || !reflect.DeepEqual(cancelled[0].(map[string]any)["results"], m3["results"]) {
		t.Fatal("cancelled results changed")
	}
	lookup := func(season string) map[string]map[string]any {
		t.Helper()
		out := map[string]map[string]any{}
		for _, v := range verify("GET", root+"/ranking?season="+season, memberToken, nil, 200, "")["entries"].([]any) {
			e := v.(map[string]any)
			out[e["user_id"].(string)] = e
		}
		return out
	}
	assertRank := func(entries map[string]map[string]any, id, n, d string, matches, rank float64) {
		t.Helper()
		e := entries[id]
		point, _ := e["total_point"].(map[string]any)
		if point["numerator"] != n || point["denominator"] != d || e["match_count"] != matches || e["rank"] != rank {
			t.Fatalf("ranking wanted %s/%s, %.0f matches, rank %.0f: %v", n, d, matches, rank, e)
		}
	}
	all := lookup("all")
	assertRank(all, guests[0], "799", "30", 3, 1)
	assertRank(all, guests[1], "199", "30", 3, 2)
	assertRank(all, guests[2], "199", "30", 3, 2)
	assertRank(all, guests[3], "-399", "10", 3, 4)
	assertRank(lookup(f.season), guests[0], "50", "1", 1, 1)
	assertRank(lookup(s2), guests[2], "499", "30", 1, 1)
	assertRank(lookup("unassigned"), guests[3], "50", "1", 1, 1)
	seasonChange["version"] = "1"
	seasonChange["client_request_id"] = uid()
	verify("PATCH", root+"/seasons/"+f.season, adminToken, seasonChange, 409, "STATE_CONFLICT")
	usedPath := root + "/seasons/" + f.season
	usedDates := row(`SELECT COALESCE(start_date::text,'-')||'|'||end_date::text FROM public.seasons WHERE id=$1`, f.season)
	rename := map[string]any{"client_request_id": uid(), "name": "対局に使用したシーズン", "version": "1"}
	verify("PATCH", usedPath, adminToken, rename, 200, "")
	verify("PATCH", usedPath, adminToken, rename, 200, "")
	if got := seasonRange(f.season); got != "対局に使用したシーズン|"+usedDates {
		t.Fatalf("rename must keep the used range: %s", got)
	}
	verify("PATCH", usedPath, adminToken, map[string]any{"client_request_id": uid(), "version": "1", "name": "旧版"}, 409, "VERSION_CONFLICT")
	verify("PATCH", usedPath, adminToken, map[string]any{"client_request_id": uid(), "version": "2", "end_date": nil}, 409, "STATE_CONFLICT")
	t.Log("Season PATCH: partial dates, null, name-only on a used season, used-date conflict, stale version, replay and legacy operation hash")
	t.Log("Q-20 exact fixtures: all=799/30,199/30,199/30,-399/10 (3 each); S1, S2 and unassigned verified; cancelled results retained")

	edit := makeMatch(guests[:4], []int{35000, 35000, 20000, 10000}, f.season)
	edit["version"], edit["reason"] = "1", "得点訂正"
	verify("PATCH", m1Path, memberToken, edit, 403, "FORBIDDEN")
	verify("PATCH", other+"/matches/"+m1["id"].(string), adminToken, edit, 403, "FORBIDDEN")
	verify("PATCH", other+"/matches/"+m1["id"].(string), memberToken, edit, 404, "NOT_FOUND")
	before := verify("GET", m1Path, memberToken, nil, 200, "")
	failName := "step5_" + uniqueSuffix()
	exec(`CREATE FUNCTION public.` + failName + `() RETURNS trigger LANGUAGE plpgsql AS $body$
		BEGIN IF NEW.match_id='` + m1["id"].(string) + `' AND NEW.operation='update' THEN
		  RAISE EXCEPTION 'fixture forces rollback after results update'; END IF; RETURN NEW; END $body$;
		CREATE TRIGGER ` + failName + ` BEFORE INSERT ON public.match_revisions FOR EACH ROW EXECUTE FUNCTION public.` + failName + `()`)
	t.Cleanup(func() {
		_, _ = admin.Exec("DROP TRIGGER IF EXISTS " + failName + " ON public.match_revisions; DROP FUNCTION IF EXISTS public." + failName + "()")
	})
	verify("PATCH", m1Path, adminToken, edit, 503, "TEMPORARILY_UNAVAILABLE")
	if want := verify("GET", m1Path, memberToken, nil, 200, ""); !reflect.DeepEqual(before, want) {
		t.Fatal("rolled-back update persisted")
	}
	if value := row(`SELECT count(*)::text FROM public.match_revisions WHERE match_id=$1`, m1["id"]); value != "1" {
		t.Fatal("rolled-back revision persisted")
	}
	exec("DROP TRIGGER " + failName + " ON public.match_revisions; DROP FUNCTION public." + failName + "()")
	concurrent := makeMatch(guests[:4], []int{35000, 35000, 20000, 10000}, f.season)
	concurrent["version"], concurrent["reason"] = "1", "並行訂正"
	type response struct {
		code    int
		command map[string]any
	}
	responses := make(chan response, 2)
	for _, command := range []map[string]any{edit, concurrent} {
		go func(body map[string]any) {
			code, _ := send("PATCH", m1Path, adminToken, body)
			responses <- response{code, body}
		}(command)
	}
	first, second := <-responses, <-responses
	if first.code != 200 {
		first, second = second, first
	}
	if first.code != 200 || second.code != 409 {
		t.Fatalf("concurrent correct %d/%d", first.code, second.code)
	}
	if replay := verify("PATCH", m1Path, adminToken, first.command, 200, ""); replay["applied_version"] != "2" {
		t.Fatal("wrong replay version")
	}
	reused := reason("2", "再利用")
	reused["client_request_id"] = first.command["client_request_id"]
	verify("POST", m1Path+"/cancel", adminToken, reused, 409, "IDEMPOTENCY_CONFLICT")
	updated := verify("GET", m1Path, memberToken, nil, 200, "")
	for _, field := range []string{"id", "created_at", "recorded_by"} {
		if before[field] != updated[field] {
			t.Fatalf("correct changed %s", field)
		}
	}
	afterCorrection := lookup(f.season)
	assertRank(afterCorrection, guests[0], "30", "1", 1, 1)
	assertRank(afterCorrection, guests[1], "30", "1", 1, 1)
	assertRank(afterCorrection, guests[2], "-20", "1", 1, 3)
	verify("GET", m1Path+"/revisions", memberToken, nil, 403, "FORBIDDEN")
	revisions := verify("GET", m1Path+"/revisions?limit=1", adminToken, nil, 200, "")
	change := revisions["revisions"].([]any)[0].(map[string]any)
	if change["actor_id"] != manager || !reflect.DeepEqual(change["before"], before) || !reflect.DeepEqual(change["after"], updated) {
		t.Fatal("revision missing before/after or actor")
	}
	cursor := url.QueryEscape(revisions["next_cursor"].(string))
	verify("GET", m1Path+"/revisions?cursor="+cursor, adminToken, nil, 200, "")
	verify("GET", root+"/matches/"+m3["id"].(string)+"/revisions?cursor="+cursor, adminToken, nil, 400, "INVALID_INPUT")
	t.Log("Q-24: member recorder denied, late audit fault rolled back 4 results and match; 200/409 parallel, replay and scope; correction retained identity and 1/1/3 ranks")

	originalResults := func() string {
		return row(`SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id)::text FROM public.match_results r WHERE league_id=$1`, f.a)
	}
	save([]string{member, guests[1], guests[2], guests[3]}, []int{40000, 30000, 20000, 10000}, nil)
	raw := originalResults()
	unlinked := lookup("all")
	assertRank(unlinked, guests[0], "199", "30", 3, 3)
	assertRank(unlinked, member, "50", "1", 1, 1)
	link := verify("POST", root+"/participant-links", memberToken, map[string]any{"guest_user_id": guests[0], "client_request_id": uid()}, 201, "")["participant_link"].(map[string]any)["id"].(string)
	approve := map[string]any{"version": "1", "confirmation_note": "本人を確認", "client_request_id": uid()}
	verify("POST", root+"/participant-links/"+link+"/approve", adminToken, approve, 200, "")
	linked := lookup("all")
	assertRank(linked, member, "1699", "30", 4, 1)
	if linked[guests[0]] != nil || originalResults() != raw {
		t.Fatal("link altered original scores")
	}
	verify("PATCH", root+"/guests/"+guests[0], adminToken, map[string]any{"client_request_id": uid(), "name": "紐付け済み", "version": "1"}, 409, "STATE_CONFLICT")
	revoke := reason("2", "紐付け先の訂正")
	verify("POST", root+"/participant-links/"+link+"/revoke", adminToken, revoke, 403, "FORBIDDEN")
	verify("POST", root+"/participant-links/"+link+"/revoke", ownerToken, revoke, 200, "")
	verify("POST", root+"/participant-links/"+link+"/revoke", ownerToken, revoke, 200, "")
	if got := lookup("all"); !reflect.DeepEqual(got, unlinked) || originalResults() != raw {
		t.Fatal("revoke failed to restore ranking or changed results")
	}
	t.Log("Q-15/Q-20: guest 199/30 in 3 matches + registered 50 in 1 → 1699/30 in 4; revoke restores both and all original result rows byte-for-byte")

	invitation := verify("POST", root+"/invites", ownerToken, map[string]any{"client_request_id": uid()}, 201, "")["invite"].(map[string]any)
	remove := reason("1", "有効なメンバーを除名")
	verify("POST", root+"/members/"+member+"/remove", adminToken, remove, 200, "")
	verify("GET", root+"/ranking", memberToken, nil, 403, "LEAGUE_ACCESS_DENIED")
	removedRanks := verify("GET", root+"/ranking", ownerToken, nil, 200, "")["entries"].([]any)
	var removedFound bool
	for _, entry := range removedRanks {
		line := entry.(map[string]any)
		if line["user_id"] == member {
			removedFound = line["membership_status"] == "removed" && line["match_count"] == float64(1)
		}
	}
	if !removedFound {
		t.Fatal("removed participant's points were dropped")
	}
	rejoin := map[string]any{"code": invitation["code"], "client_request_id": uid()}
	if result := verify("POST", root+"/join", memberToken, rejoin, 200, "")["membership"].(map[string]any); result["role"] != "member" || result["user_id"] != member || result["version"] != "3" {
		t.Fatal("invalid rejoin state")
	}
	if got := lookup("all"); !reflect.DeepEqual(got, unlinked) || originalResults() != raw {
		t.Fatal("removal or rejoin changed original results")
	}
	// A scored owner remains in the ranking after handing over and leaving.
	save([]string{owner, guests[1], guests[2], guests[3]}, []int{40000, 30000, 20000, 10000}, nil)

	issue := func() string {
		return verify("POST", root+"/owner-transfers", ownerToken, map[string]any{"to_user_id": member, "client_request_id": uid()}, 201, "")["id"].(string)
	}
	accept := func(id, token string, status int, code string) {
		verify("POST", root+"/owner-transfers/"+id+"/accept", token, map[string]any{"version": "1", "client_request_id": uid()}, status, code)
	}
	transfer := issue()
	if got := row(`SELECT owner_id::text FROM public.leagues WHERE id=$1`, f.a); got != owner {
		t.Fatal("proposal changed owner")
	}
	verify("POST", root+"/owner-transfers", ownerToken, map[string]any{"to_user_id": manager, "client_request_id": uid()}, 409, "STATE_CONFLICT")
	accept(transfer, adminToken, 403, "FORBIDDEN")
	role["client_request_id"], role["version"] = uid(), "3"
	verify("PATCH", root+"/members/"+member, ownerToken, role, 200, "")
	accept(transfer, memberToken, 409, "STATE_CONFLICT")
	verify("POST", root+"/owner-transfers/"+transfer+"/cancel", ownerToken, map[string]any{"version": "1", "client_request_id": uid()}, 200, "")
	transfer = issue()
	exec(`UPDATE public.owner_transfers SET expires_at=created_at+interval '1 microsecond' WHERE id=$1`, transfer)
	accept(transfer, memberToken, 409, "STATE_CONFLICT")
	transfer = issue()
	responses2 := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			code, _ := send("POST", root+"/owner-transfers/"+transfer+"/accept", memberToken, map[string]any{"version": "1", "client_request_id": uid()})
			responses2 <- code
		}()
	}
	codes := []int{<-responses2, <-responses2}
	sort.Ints(codes)
	if !reflect.DeepEqual(codes, []int{200, 409}) {
		t.Fatalf("parallel transfer: %v", codes)
	}
	if got := row(`SELECT l.owner_id::text||':'||previous.role||':'||next.role FROM public.leagues l
		JOIN public.league_members previous ON previous.league_id=l.id AND previous.user_id=$2
		JOIN public.league_members next ON next.league_id=l.id AND next.user_id=$3 WHERE l.id=$1`, f.a, owner, member); got != member+":admin:owner" {
		t.Fatal("owner references diverged")
	}
	leave := map[string]any{"client_request_id": uid()}
	verify("POST", root+"/leave", ownerToken, leave, 200, "")
	verify("POST", root+"/leave", ownerToken, leave, 200, "")
	verify("GET", root+"/ranking", ownerToken, nil, 403, "LEAGUE_ACCESS_DENIED")
	if entry := lookup("all")[owner]; entry["membership_status"] != "left" || entry["match_count"] != float64(1) {
		t.Fatal("departed participant's points were dropped")
	}

	verify("POST", root+"/members/"+manager+"/remove", memberToken, reason("1", "所属の整理"), 200, "")
	verify("GET", root+"/events", adminToken, nil, 403, "LEAGUE_ACCESS_DENIED")
	audit := verify("GET", root+"/events?limit=1", memberToken, nil, 200, "")
	verify("GET", root+"/events?cursor="+url.QueryEscape(audit["next_cursor"].(string)), memberToken, nil, 200, "")
	t.Log("Q-18/Q-26: admin A/member B, settings and audit isolation, owner-only operations, consent/version/expiry/parallel handover, scored removed/left participation, invite rejoin and former owner leave/replay")
}
