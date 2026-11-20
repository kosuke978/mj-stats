package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func testLeagueMatches(t *testing.T, ctx context.Context, admin *sql.DB, call apiCall, ownerToken, memberToken, owner, member string) {
	f := createLeagueFixture(t, ctx, admin, owner, member)
	root := "/api/leagues/" + f.a
	otherRoot := "/api/leagues/" + f.b
	exec := func(statement string, args ...any) {
		t.Helper()
		if _, err := admin.ExecContext(ctx, statement, args...); err != nil {
			t.Fatalf("Step 3 fixture: %v", err)
		}
	}
	verify := func(method, path, token string, input any, want int, code string) map[string]any {
		t.Helper()
		payload, _ := json.Marshal(input)
		actual, data := call(method, path, token, string(payload))
		if actual != want || (code != "" && data["error"].(map[string]any)["code"] != code) {
			t.Fatalf("%s %s status %d (want %d), %v", method, path, actual, want, data["error"])
		}
		return data
	}
	uid := func() string {
		return fmt.Sprintf("%s-0000-4000-8000-%s", uniqueSuffix()[:8], uniqueSuffix()[:12])
	}
	request := func(name, id string) map[string]any {
		return map[string]any{"name": name, "client_request_id": id}
	}
	exec(`UPDATE public.league_members SET status='active',ended_at=NULL WHERE league_id=$1 AND user_id=$2`, f.a, member)
	exec(`UPDATE public.seasons SET start_date='2024-11-01',end_date='2024-11-01' WHERE id=$1`, f.season)
	var createdGuests []string
	t.Cleanup(func() {
		tx, err := admin.Begin()
		if err != nil {
			t.Error(err)
			return
		}
		defer tx.Rollback()
		for _, table := range []string{"match_revisions", "match_results", "matches", "participant_links", "league_events"} {
			if _, err := tx.Exec(`DELETE FROM public.`+table+` WHERE league_id IN ($1,$2)`, f.a, f.b); err != nil {
				t.Error(err)
				return
			}
		}
		for _, id := range createdGuests {
			if _, err := tx.Exec(`DELETE FROM public.league_members WHERE user_id=$1`, id); err != nil {
				t.Error(err)
				return
			}
			if _, err := tx.Exec(`DELETE FROM public.users WHERE id=$1`, id); err != nil {
				t.Error(err)
				return
			}
		}
		if err := tx.Commit(); err != nil {
			t.Error(err)
		}
	})

	verify("POST", root+"/guests", "", request("同名", uid()), 401, "UNAUTHENTICATED")
	verify("POST", "/api/leagues/"+f.left+"/guests", ownerToken, request("同名", uid()), 403, "LEAGUE_ACCESS_DENIED")
	verify("POST", root+"/guests", ownerToken, request("改行\n不可", uid()), 400, "INVALID_INPUT")
	addGuest := func(path, token, name, key string) string {
		t.Helper()
		p := verify("POST", path+"/guests", token, request(name, key), 201, "")["participant"].(map[string]any)
		id := p["id"].(string)
		createdGuests = append(createdGuests, id)
		if p["name"] != name || p["kind"] != "guest" {
			t.Fatalf("invalid guest response: %v", p)
		}
		return id
	}
	key := uid()
	g1 := addGuest(root, memberToken, "同名", key)
	g2 := addGuest(root, memberToken, "同名", uid())
	g3 := addGuest(root, ownerToken, "ゲスト3", uid())
	g4 := addGuest(root, ownerToken, "ゲスト4", uid())
	foreign := addGuest(otherRoot, memberToken, "別リーグ", uid())
	replayed := verify("POST", root+"/guests", memberToken, request(" 同名 ", key), 200, "")["participant"].(map[string]any)
	if replayed["id"] != g1 || g1 == g2 {
		t.Fatal("guest replay or same-name separation")
	}
	verify("POST", root+"/guests", memberToken, request("違う名", key), 409, "IDEMPOTENCY_CONFLICT")
	t.Log("Q-14/Q-15: member guest creation, same names distinct, normalized guest replay, unauthorized and invalid names rejected")

	makePlayers := func(ids []string, scores []int) []map[string]any {
		result := make([]map[string]any, len(ids))
		for i, id := range ids {
			result[i] = map[string]any{"user_id": id, "raw_score": scores[i]}
		}
		return result
	}
	ids := []string{g1, g2, g3, g4}
	scores := []int{33300, 33300, 33300, 100}
	calc := func(players []map[string]any, rule string) map[string]any {
		return map[string]any{"players": players, "rule_id": rule}
	}
	save := func(date string, season any, players []map[string]any) map[string]any {
		body := calc(players, f.rule)
		body["match_date"], body["season_id"], body["client_request_id"] = date, season, uid()
		return body
	}
	counts := func() [3]int {
		t.Helper()
		var result [3]int
		err := admin.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM public.matches WHERE league_id=$1),
			(SELECT count(*) FROM public.match_results WHERE league_id=$1),
			(SELECT count(*) FROM public.match_revisions WHERE league_id=$1)`, f.a).
			Scan(&result[0], &result[1], &result[2])
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	for _, fixture := range []struct {
		scores     []int
		ranks      []int
		numerators []string
	}{
		{[]int{40000, 30000, 20000, 10000}, []int{1, 2, 3, 4}, []string{"50", "10", "-20", "-40"}},
		{[]int{35000, 35000, 20000, 10000}, []int{1, 1, 3, 4}, []string{"30", "30", "-20", "-40"}},
		{[]int{25000, 25000, 25000, 25000}, []int{1, 1, 1, 1}, []string{"0", "0", "0", "0"}},
		{[]int{60000, 30000, 15000, -5000}, []int{1, 2, 3, 4}, []string{"70", "10", "-25", "-55"}},
	} {
		result := verify("POST", root+"/matches/calculate", memberToken, calc(makePlayers(ids, fixture.scores), f.rule), 200, "")
		for i, raw := range result["results"].([]any) {
			r := raw.(map[string]any)
			point := r["point"].(map[string]any)
			if r["rank"] != float64(fixture.ranks[i]) || r["raw_score"] != float64(fixture.scores[i]) ||
				point["numerator"] != fixture.numerators[i] || point["denominator"] != "1" {
				t.Fatalf("incorrect calculation for %v: %v", fixture.scores, r)
			}
		}
	}
	calculation := verify("POST", root+"/matches/calculate", memberToken, calc(makePlayers(ids, scores), f.rule), 200, "")
	results := calculation["results"].([]any)
	for i, result := range results {
		r := result.(map[string]any)
		point := r["point"].(map[string]any)
		n, d, rank := "499", "30", float64(1)
		if i == 3 {
			n, d, rank = "-499", "10", 4
		}
		if point["numerator"] != n || point["denominator"] != d || r["rank"] != rank {
			t.Fatalf("wrong rational/rank: %v", r)
		}
	}
	if counts() != [3]int{} {
		t.Fatal("calculation wrote data")
	}

	var customRule, foreignRule, foreignSeason string
	for _, query := range []struct {
		sql string
		key string
		out *string
	}{
		{`INSERT INTO public.rules(league_id,name,default_points,return_points,uma_1,uma_2,uma_3,uma_4,calculation_version,available)
		VALUES($1,'変更された開始点',30000,30000,12,8,-8,-12,'exact_v1',true) RETURNING id`, f.a, &customRule},
		{`SELECT id FROM public.rules WHERE league_id=$1`, f.b, &foreignRule},
		{`INSERT INTO public.seasons(league_id,name) VALUES($1,'別期間') RETURNING id`, f.b, &foreignSeason},
	} {
		if err := admin.QueryRowContext(ctx, query.sql, query.key).Scan(query.out); err != nil {
			t.Fatal(err)
		}
	}
	negative := makePlayers(ids, []int{60000, 50000, 20000, -10000})
	negativeResults := verify("POST", root+"/matches/calculate", memberToken, calc(negative, customRule), 200, "")["results"].([]any)
	if point := negativeResults[3].(map[string]any)["point"].(map[string]any); point["numerator"] != "-52" || point["denominator"] != "1" {
		t.Fatalf("negative/non-default rule: %v", point)
	}
	for _, invalid := range [][]map[string]any{
		makePlayers(ids[:3], scores),
		makePlayers(append(append([]string{}, ids...), f.guest), append(append([]int{}, scores...), 0)),
		makePlayers([]string{"", g2, g3, g4}, scores),
		makePlayers([]string{g1, g1, g3, g4}, scores),
		makePlayers(ids, []int{33300, 33300, 33299, 101}),
		makePlayers(ids, []int{33300, 33300, 33300, 0}),
	} {
		verify("POST", root+"/matches/calculate", memberToken, calc(invalid, f.rule), 400, "INVALID_INPUT")
	}
	missing := makePlayers(ids, scores)
	delete(missing[3], "raw_score")
	verify("POST", root+"/matches/calculate", memberToken, calc(missing, f.rule), 400, "INVALID_INPUT")
	for _, value := range []any{nil, 1.5, int64(2147483700), int64(-2147483700)} {
		invalid := makePlayers(ids, scores)
		invalid[3]["raw_score"] = value
		verify("POST", root+"/matches/calculate", memberToken, calc(invalid, f.rule), 400, "INVALID_INPUT")
		verify("POST", root+"/matches", memberToken, save("2024-11-01T00:00:00+09:00", nil, invalid), 400, "INVALID_INPUT")
	}
	if code, _ := call("POST", root+"/matches/calculate", memberToken, "{"); code != 400 {
		t.Fatal("malformed calculation JSON accepted")
	}
	zeroScores := makePlayers(ids, []int{50000, 30000, 20000, 0})
	verify("POST", root+"/matches/calculate", memberToken, calc(zeroScores, f.rule), 200, "")
	verify("POST", root+"/matches/calculate", memberToken, calc(makePlayers([]string{foreign, g2, g3, g4}, scores), f.rule), 404, "NOT_FOUND")
	verify("POST", root+"/matches/calculate", memberToken, calc(makePlayers(ids, scores), foreignRule), 404, "NOT_FOUND")
	for _, invalidDate := range []string{"2024-10-31T14:59:59.999999Z", "2024-11-01T15:00:00Z", "2024-11-01T00:00:00", "2099-01-01T00:00:00Z"} {
		verify("POST", root+"/matches", memberToken, save(invalidDate, f.season, makePlayers(ids, scores)), 400, "INVALID_INPUT")
	}
	verify("POST", root+"/matches", memberToken, save("2024-11-01T00:00:00+09:00", foreignSeason, makePlayers(ids, scores)), 404, "NOT_FOUND")
	for _, field := range []string{"rank", "point", "recorded_by"} {
		body := save("2024-11-01T00:00:00+09:00", nil, makePlayers(ids, scores))
		body[field] = owner
		verify("POST", root+"/matches", memberToken, body, 400, "INVALID_INPUT")
	}
	t.Log("Q-01〜Q-03/Q-11/Q-12/Q-16/Q-22: rational tie, negative and non-default rule, invalid amount/identity/contract, foreign references and JST boundaries")

	body := save("2024-11-01T00:00:00+09:00", f.season, makePlayers(ids, scores))
	verify("POST", root+"/matches", "", body, 401, "UNAUTHENTICATED")
	verify("POST", "/api/leagues/"+f.left+"/matches", ownerToken, body, 403, "LEAGUE_ACCESS_DENIED")
	verify("POST", root+"/matches", memberToken, save("2024-11-01T00:00:00+09:00", nil, makePlayers([]string{foreign, g2, g3, g4}, scores)), 404, "NOT_FOUND")
	for _, field := range []string{"point", "rank"} {
		players := makePlayers(ids, scores)
		players[0][field] = 1
		verify("POST", root+"/matches", memberToken, save("2024-11-01T00:00:00+09:00", nil, players), 400, "INVALID_INPUT")
	}
	if counts() != [3]int{} {
		t.Fatal("a rejected input wrote data")
	}
	first := verify("POST", root+"/matches", memberToken, body, 201, "")
	firstID := first["id"].(string)
	if first["recorded_by"] != member || first["match_date"] != "2024-10-31T15:00:00.000000Z" || first["season_id"] != f.season ||
		!reflect.DeepEqual(first["results"], results) || counts() != [3]int{1, 4, 1} {
		t.Fatal("proxy recording, UTC boundary, persisted results or revision differs")
	}
	if got := verify("GET", root+"/matches/"+firstID, memberToken, nil, 200, ""); !reflect.DeepEqual(got, first) {
		t.Fatal("saved Match and detail differ")
	}
	verify("GET", otherRoot+"/matches/"+firstID, memberToken, nil, 404, "NOT_FOUND")
	body["match_date"], body["rule_id"] = "2024-10-31T15:00:00Z", strings.ToUpper(f.rule)
	inputPlayers := body["players"].([]map[string]any)
	inputPlayers[0]["user_id"] = strings.ToUpper(g1)
	if got := verify("POST", root+"/matches", memberToken, body, 200, ""); got["id"] != firstID {
		t.Fatal("normalized replay returned different match")
	}
	inputPlayers[0], inputPlayers[1] = inputPlayers[1], inputPlayers[0]
	verify("POST", root+"/matches", memberToken, body, 409, "IDEMPOTENCY_CONFLICT")
	inputPlayers[0], inputPlayers[1] = inputPlayers[1], inputPlayers[0]

	// Force the low-score (fourth result) insertion to fail and verify the
	// parent, first three results, and operation key all roll back.
	guard := "step3_" + uniqueSuffix()
	exec(`CREATE FUNCTION public.` + guard + `() RETURNS trigger LANGUAGE plpgsql AS $trigger$
		BEGIN IF NEW.match_id IN (SELECT id FROM public.matches WHERE league_id='` + f.a + `')
			AND NEW.raw_score=100 THEN RAISE EXCEPTION 'fixture result failure'; END IF;
		RETURN NEW; END; $trigger$;
		CREATE TRIGGER ` + guard + ` BEFORE INSERT ON public.match_results FOR EACH ROW EXECUTE FUNCTION public.` + guard + `();`)
	drop := func() {
		exec(`DROP TRIGGER IF EXISTS ` + guard + ` ON public.match_results; DROP FUNCTION IF EXISTS public.` + guard + `();`)
	}
	defer drop()
	boundary := save("2024-11-01T23:59:59.999999+09:00", f.season, makePlayers(ids, scores))
	verify("POST", root+"/matches", memberToken, boundary, 503, "TEMPORARILY_UNAVAILABLE")
	if counts() != [3]int{1, 4, 1} {
		t.Fatal("partial match/result/revision survived forced failure")
	}
	drop()
	verify("POST", root+"/matches", memberToken, boundary, 201, "")

	type response struct {
		status int
		body   map[string]any
	}
	async := func(path string, token string, payload any) <-chan response {
		ch := make(chan response, 1)
		b, _ := json.Marshal(payload)
		go func() {
			status, responseBody := call("POST", path, token, string(b))
			ch <- response{status, responseBody}
		}()
		return ch
	}
	unassigned := save("2024-11-01T12:00:00+09:00", nil, makePlayers(ids, scores))
	one, two := async(root+"/matches", memberToken, unassigned), async(root+"/matches", memberToken, unassigned)
	x, y := <-one, <-two
	if x.status+y.status != 401 || x.body["id"] == nil || x.body["id"] != y.body["id"] || counts() != [3]int{3, 12, 3} {
		t.Fatalf("parallel replay: %d / %d", x.status, y.status)
	}
	delete(unassigned, "season_id")
	verify("POST", root+"/matches", memberToken, unassigned, 200, "")
	if list := verifyStatus(t, call, "GET", root+"/matches?season=unassigned", memberToken, 200, "")["matches"].([]any); len(list) != 1 {
		t.Fatal("unassigned filtering")
	}
	t.Log("Q-04/Q-12/Q-14/Q-17/Q-22/Q-23: proxy record, exact detail, original date boundary, mid-result rollback, retry and one row from concurrent retries")

	requestLink := func(token, id string) string {
		t.Helper()
		return verify("POST", root+"/participant-links", token,
			map[string]string{"guest_user_id": id, "client_request_id": uid()}, 201, "")["participant_link"].(map[string]any)["id"].(string)
	}
	review := func() map[string]string {
		return map[string]string{"confirmation_note": "対局した本人であることを確認", "version": "1", "client_request_id": uid()}
	}
	p1 := requestLink(ownerToken, g1)
	p2 := requestLink(ownerToken, g2)
	memberLink := requestLink(memberToken, f.guest)
	if got := verifyStatus(t, call, "GET", root+"/participant-links", memberToken, 200, "")["participant_links"].([]any); len(got) != 1 {
		t.Fatal("member can see another person's request")
	}
	if got := verifyStatus(t, call, "GET", root+"/participant-links?limit=2", ownerToken, 200, ""); len(got["participant_links"].([]any)) != 2 || got["next_cursor"] == nil {
		t.Fatal("manager list/cursor")
	}
	verify("POST", root+"/participant-links/"+p1+"/approve", memberToken, review(), 403, "FORBIDDEN")
	approval := review()
	verify("POST", root+"/participant-links/"+p1+"/approve", ownerToken, approval, 200, "")
	verify("POST", root+"/participant-links/"+p1+"/approve", ownerToken, approval, 200, "")
	verify("POST", root+"/participant-links/"+p2+"/approve", ownerToken, review(), 409, "STATE_CONFLICT")
	verify("POST", root+"/participant-links/"+memberLink+"/reject", ownerToken, review(), 200, "")
	verify("POST", root+"/participant-links", ownerToken,
		map[string]string{"guest_user_id": foreign, "client_request_id": uid()}, 404, "NOT_FOUND")
	options := verify("GET", root+"/participants", memberToken, nil, 200, "")["participants"].([]any)
	var foundOwner bool
	for _, option := range options {
		id := option.(map[string]any)["id"]
		if id == g1 {
			t.Fatal("linked guest is still selectable by another member")
		}
		foundOwner = foundOwner || id == owner
	}
	if !foundOwner {
		t.Fatal("registered participant is missing")
	}
	history := verify("GET", root+"/matches/"+firstID, memberToken, nil, 200, "")
	for _, player := range history["results"].([]any) {
		p := player.(map[string]any)
		if p["user_id"] == g1 && p["canonical_user_id"] != owner {
			t.Fatal("linked result must retain origin and resolve registered identity")
		}
	}
	beforeRejectedSave := counts()
	verify("POST", root+"/matches/calculate", memberToken, map[string]any{"rule_id": f.rule, "players": makePlayers(ids, scores)}, 409, "STATE_CONFLICT")
	verify("POST", root+"/matches", memberToken, save("2024-11-01T00:00:00+09:00", nil, makePlayers(ids, scores)), 409, "STATE_CONFLICT")
	if replay := verify("POST", root+"/matches", memberToken, unassigned, 200, ""); replay["id"] != x.body["id"] || counts() != beforeRejectedSave {
		t.Fatal("linking must preserve committed save replay and reject new writes")
	}
	verify("POST", root+"/matches", ownerToken,
		save("2024-11-01T00:00:00+09:00", nil, makePlayers([]string{g1, owner, g3, g4}, scores)), 409, "STATE_CONFLICT")

	// A new same-person overlap can only be introduced by one of the two
	// calls: if the save wins the approval must fail, and vice versa.
	pending := requestLink(memberToken, f.guest)
	saveRace := save("2024-11-01T00:00:00+09:00", nil, makePlayers([]string{f.guest, member, g3, g4}, scores))
	linkCall := async(root+"/participant-links/"+pending+"/approve", ownerToken, review())
	saveCall := async(root+"/matches", memberToken, saveRace)
	linkStatus, saveStatus := (<-linkCall).status, (<-saveCall).status
	if !(linkStatus == 200 && saveStatus == 409 || linkStatus == 409 && saveStatus == 201) {
		t.Fatalf("approve/save overlap: %d/%d", linkStatus, saveStatus)
	}
	t.Log("Q-15/Q-23: consent and self-approval, manager-only review, rejection, original/canonical IDs, existing same-table and concurrent same-person overlap")

	// With the DB update in flight, the request can neither pass the old
	// state nor see an uncommitted change. It observes the committed state.
	ruleTx, err := admin.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ruleTx.Rollback()
	if _, err := ruleTx.ExecContext(ctx, `UPDATE public.rules SET available=false WHERE id=$1`, f.rule); err != nil {
		t.Fatal(err)
	}
	retireRace := async(root+"/matches", memberToken, save("2024-11-01T00:00:00+09:00", nil, makePlayers(ids, scores)))
	select {
	case result := <-retireRace:
		t.Fatalf("save bypassed rule lock: %d", result.status)
	case <-time.After(150 * time.Millisecond):
	}
	if err := ruleTx.Commit(); err != nil {
		t.Fatal(err)
	}
	if got := <-retireRace; got.status != 409 {
		t.Fatalf("save against retired rule: %d", got.status)
	}
	verify("POST", root+"/matches", memberToken, body, 200, "")

	membershipTx, err := admin.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer membershipTx.Rollback()
	if _, err := membershipTx.ExecContext(ctx, `SELECT id FROM public.leagues WHERE id=$1 FOR UPDATE`, f.a); err != nil {
		t.Fatal(err)
	}
	if _, err := membershipTx.ExecContext(ctx, `UPDATE public.league_members SET status='removed',ended_at=now() WHERE league_id=$1 AND user_id=$2`, f.a, member); err != nil {
		t.Fatal(err)
	}
	removeRace := async(root+"/matches", memberToken, body)
	select {
	case result := <-removeRace:
		t.Fatalf("replay bypassed membership lock: %d", result.status)
	case <-time.After(150 * time.Millisecond):
	}
	if err := membershipTx.Commit(); err != nil {
		t.Fatal(err)
	}
	if got := <-removeRace; got.status != 403 {
		t.Fatalf("formerly eligible replay: %d", got.status)
	}
	t.Log("Q-16/Q-17/Q-23: concurrent rule retirement and membership removal ordered ahead of write/replay; authorized retirement replay succeeds")
}
