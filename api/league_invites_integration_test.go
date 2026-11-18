package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/invites"
)

func testLeagueInvites(t *testing.T, ctx context.Context, db, admin *sql.DB, verifier *auth.Verifier, owner, other, actor, otherActor string) {
	const origin = "http://localhost:3000"
	key := func() string {
		var secret [32]byte
		if _, err := rand.Read(secret[:]); err != nil {
			t.Fatal("generate isolated invitation key")
		}
		return base64.StdEncoding.EncodeToString(secret[:])
	}
	k1, k2 := key(), key()
	config := func(keys, current string) *invites.Config {
		c, err := invites.NewConfig(origin, keys, current)
		if err != nil {
			t.Fatal("invalid invitation test configuration")
		}
		return c
	}
	makeCall := func(config *invites.Config) apiCall {
		handler := router(db, verifier, []string{origin}, config)
		return func(method, path, token, body string) (int, map[string]any) {
			req := httptest.NewRequestWithContext(ctx, method, path, strings.NewReader(body))
			req.Host = "untrusted-host.invalid"
			req.Header.Set("X-Forwarded-Host", "untrusted-proxy.invalid")
			req.Header.Set("Content-Type", "application/json")
			if token != "" {
				req.Header.Set("Authorization", "Bearer "+token)
			}
			res := httptest.NewRecorder()
			handler.ServeHTTP(res, req)
			var data map[string]any
			_ = json.Unmarshal(res.Body.Bytes(), &data)
			if res.Header().Get("Cache-Control") != "private, no-store" {
				return 0, nil
			}
			return res.Code, data
		}
	}
	v1 := makeCall(config(fmt.Sprintf(`{ "1": %q }`, k1), "1"))
	v2 := makeCall(config(fmt.Sprintf(`{ "1": %q, "2": %q }`, k1, k2), "2"))
	missingOld := makeCall(config(fmt.Sprintf(`{ "2": %q }`, k2), "2"))
	f := createLeagueFixture(t, ctx, admin, actor, otherActor)
	t.Cleanup(func() {
		tx, err := admin.Begin()
		if err != nil {
			t.Error("begin invite fixture cleanup")
			return
		}
		defer tx.Rollback()
		for _, table := range []string{"league_events", "league_invites"} {
			if _, err := tx.Exec("DELETE FROM public."+table+" WHERE league_id IN ($1,$2)", f.a, f.b); err != nil {
				t.Error("delete invite fixture")
				return
			}
		}
		if tx.Commit() != nil {
			t.Error("commit invite fixture cleanup")
		}
	})
	exec := func(stmt string, args ...any) {
		t.Helper()
		if _, err := admin.ExecContext(ctx, stmt, args...); err != nil {
			t.Fatal("invitation fixture statement failed")
		}
	}
	query := func(dst any, stmt string, args ...any) {
		t.Helper()
		if err := admin.QueryRowContext(ctx, stmt, args...).Scan(dst); err != nil {
			t.Fatal("invitation fixture query failed")
		}
	}
	tokenID := func() string {
		// A fresh, valid UUID per attempt; only tests choose IDs this way.
		var id string
		query(&id, `SELECT gen_random_uuid()`)
		return id
	}
	req := func(id string) string { return fmt.Sprintf(`{"client_request_id":%q}`, id) }
	rev := func(id, version string) string {
		return fmt.Sprintf(`{"client_request_id":%q,"version":%q}`, id, version)
	}
	root := func(id string) string { return "/api/leagues/" + id + "/invites" }
	pathA, pathB := root(f.a), root(f.b)
	revokePath := func(path string, id any) string { return path + "/" + id.(string) + "/revoke" }
	assert := func(call apiCall, method, path, token, input string, status int, code string) map[string]any {
		t.Helper()
		got, body := call(method, path, token, input)
		apiError, _ := body["error"].(map[string]any)
		if got != status || (code != "" && apiError["code"] != code) {
			t.Fatalf("invite %s: status=%d want=%d error code=%v want=%s", method, got, status, apiError["code"], code)
		}
		if status >= 400 && body["invite"] != nil {
			t.Fatal("invitation data in denied response")
		}
		return body
	}
	current := func(call apiCall, path, token string) map[string]any {
		t.Helper()
		record, _ := assert(call, "GET", path+"/current", token, "", 200, "")["invite"].(map[string]any)
		return record
	}
	state := func(body map[string]any, want string) map[string]any {
		t.Helper()
		record, ok := body["invite"].(map[string]any)
		if !ok || record["status"] != want || (want != "active" && (record["code"] != nil || record["join_url"] != nil)) ||
			record["credential_hash"] != nil || record["key_version"] != nil {
			t.Fatal("invitation state or credential exposure")
		}
		return record
	}
	fingerprint := func() string {
		t.Helper()
		var hash string
		query(&hash, `SELECT md5(jsonb_build_array(
			(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM public.league_invites i WHERE league_id IN ($1,$2)),
			(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.league_events e WHERE league_id IN ($1,$2)))::text)`, f.a, f.b)
		return hash
	}
	membership := func() string {
		var hash string
		query(&hash, `SELECT md5(jsonb_agg(to_jsonb(m) ORDER BY league_id,user_id)::text)
			FROM public.league_members m WHERE league_id IN ($1,$2,$3,$4,$5)`, f.a, f.b, f.left, f.removed, f.legacy)
		return hash
	}

	if current(v1, pathA, owner) != nil {
		t.Fatal("current invite should be absent before issuance")
	}
	exec(`UPDATE public.league_members SET status='active',ended_at=NULL WHERE league_id=$1 AND user_id=$2`, f.a, otherActor)
	unchanged := membership()
	firstRequest := req(tokenID())
	issued := state(assert(v1, "POST", pathA, owner, firstRequest, 201, ""), "active")
	display, hasCode := issued["code"].(string)
	linkString, hasLink := issued["join_url"].(string)
	if !hasCode || !hasLink {
		t.Fatal("active invite missing display fields")
	}
	link, err := url.Parse(linkString)
	canonical := strings.ReplaceAll(display, "-", "")
	sum := sha256.Sum256([]byte(canonical))
	var number, stored string
	query(&number, `SELECT group_number FROM public.leagues WHERE id=$1`, f.a)
	query(&stored, `SELECT credential_hash FROM public.league_invites WHERE id=$1`, issued["id"])
	start, e1 := time.Parse(time.RFC3339Nano, issued["issued_at"].(string))
	end, e2 := time.Parse(time.RFC3339Nano, issued["expires_at"].(string))
	if err != nil || link.Scheme+"://"+link.Host != origin || link.Path != "/join/"+number ||
		link.Fragment != "code="+canonical || link.RawQuery != "" || len(display) != 19 || len(canonical) != 16 ||
		strings.Trim(canonical, "0123456789ABCDEFGHJKMNPQRSTVWXYZ") != "" || stored != hex.EncodeToString(sum[:]) ||
		e1 != nil || e2 != nil || end.Sub(start) != 168*time.Hour {
		t.Fatal("invalid invitation credential, link origin, digest or lifetime")
	}
	baseline := fingerprint()
	assert(v1, "GET", pathA+"/current", "", "", 401, "UNAUTHENTICATED")
	assert(v1, "POST", pathA, "", firstRequest, 401, "UNAUTHENTICATED")
	assert(v1, "POST", revokePath(pathA, issued["id"]), "", rev(tokenID(), "1"), 401, "UNAUTHENTICATED")
	for _, target := range []string{f.left, f.removed, f.legacy, f.missing} {
		path := root(target)
		assert(v1, "GET", path+"/current", owner, "", 403, "LEAGUE_ACCESS_DENIED")
		assert(v1, "POST", path, owner, firstRequest, 403, "LEAGUE_ACCESS_DENIED")
		assert(v1, "POST", revokePath(path, issued["id"]), owner, rev(tokenID(), "1"), 403, "LEAGUE_ACCESS_DENIED")
	}
	assert(v1, "GET", pathA+"/current", other, "", 403, "FORBIDDEN")
	assert(v1, "POST", pathA, other, firstRequest, 403, "FORBIDDEN")
	assert(v1, "POST", revokePath(pathA, issued["id"]), other, rev(tokenID(), "1"), 403, "FORBIDDEN")
	assert(v1, "POST", revokePath(pathB, issued["id"]), owner, rev(tokenID(), "1"), 404, "NOT_FOUND")
	assert(v1, "POST", pathB, owner, firstRequest, 409, "IDEMPOTENCY_CONFLICT")
	assert(v1, "POST", pathA, owner, `{"client_request_id":null}`, 400, "INVALID_INPUT")
	assert(v1, "POST", revokePath(pathA, issued["id"]), owner, rev(tokenID(), "01"), 400, "INVALID_INPUT")
	assert(missingOld, "GET", pathA+"/current", owner, "", 503, "TEMPORARILY_UNAVAILABLE")
	if fingerprint() != baseline {
		t.Fatal("denied invite request changed invite or audit rows")
	}

	if state(assert(v1, "POST", pathA, owner, firstRequest, 200, ""), "active")["code"] != display ||
		current(v2, pathA, owner)["code"] != display {
		t.Fatal("original invitation did not redisplay with the retained key")
	}
	adminInvite := state(assert(v2, "POST", pathB, owner, req(tokenID()), 201, ""), "active")
	if current(v2, pathB, other)["id"] != adminInvite["id"] || current(v2, pathA, owner)["id"] != issued["id"] {
		t.Fatal("admin or owner crosses league invite scope")
	}
	var storedVersion int
	query(&storedVersion, `SELECT key_version FROM public.league_invites WHERE id=$1`, adminInvite["id"])
	if storedVersion != 2 {
		t.Fatal("new invites must use new key version")
	}
	exec(`WITH stamp AS (SELECT clock_timestamp() AS t)
		UPDATE public.league_invites SET issued_at=t-interval '168 hours',expires_at=t FROM stamp WHERE id=$1`, issued["id"])
	if current(v2, pathA, owner) != nil {
		t.Fatal("expired invite shown as current")
	}
	state(assert(v2, "POST", pathA, owner, firstRequest, 200, ""), "expired")

	burst := req(tokenID())
	type reply struct {
		status int
		body   map[string]any
	}
	out := make(chan reply, 6)
	var wg sync.WaitGroup
	for range cap(out) {
		wg.Go(func() {
			status, body := v2("POST", pathA, owner, burst)
			out <- reply{status, body}
		})
	}
	wg.Wait()
	close(out)
	var replacementID any
	created := 0
	for result := range out {
		switch result.status {
		case 201:
			created++
		case 200:
		default:
			t.Fatalf("parallel issue status=%d", result.status)
		}
		i := state(result.body, "active")
		if replacementID == nil {
			replacementID = i["id"]
		}
		if replacementID != i["id"] {
			t.Fatal("parallel replay issued another invite")
		}
	}
	var aInvites, aEvents int
	query(&aInvites, `SELECT count(*) FROM public.league_invites WHERE league_id=$1`, f.a)
	query(&aEvents, `SELECT count(*) FROM public.league_events WHERE league_id=$1`, f.a)
	if created != 1 || aInvites != 2 || aEvents != 2 || current(v2, pathA, owner)["id"] != replacementID {
		t.Fatal("parallel issuance left duplicate invite or event")
	}
	stale := state(assert(v2, "POST", pathA, owner, firstRequest, 200, ""), "revoked")
	if stale["id"] != issued["id"] || stale["version"] != "2" {
		t.Fatal("reissued old invitation was not revoked")
	}

	revoke := revokePath(pathA, replacementID)
	revokeID := tokenID()
	assert(v2, "POST", revoke, owner, rev(revokeID, "2"), 409, "VERSION_CONFLICT")
	revokeBody := rev(revokeID, "1")
	replays := make(chan reply, 4)
	for range cap(replays) {
		wg.Go(func() {
			status, body := v2("POST", revoke, owner, revokeBody)
			replays <- reply{status, body}
		})
	}
	wg.Wait()
	close(replays)
	for result := range replays {
		if result.status != 200 || state(result.body, "revoked")["version"] != "2" {
			t.Fatal("parallel replay applied revocation more than once")
		}
	}
	if state(assert(v2, "POST", revoke, owner, revokeBody, 200, ""), "revoked")["version"] != "2" {
		t.Fatal("sequential replay applied revocation twice")
	}
	query(&aEvents, `SELECT count(*) FROM public.league_events WHERE league_id=$1 AND operation='invite.revoke'`, f.a)
	if aEvents != 1 {
		t.Fatal("revocation replay appended another operation record")
	}
	assert(v2, "POST", revoke, owner, rev(revokeID, "2"), 409, "IDEMPOTENCY_CONFLICT")
	assert(v2, "POST", revokePath(pathA, issued["id"]), owner, rev(revokeID, "1"), 409, "IDEMPOTENCY_CONFLICT")
	assert(v2, "POST", revoke, owner, rev(tokenID(), "2"), 409, "STATE_CONFLICT")
	if current(v2, pathA, owner) != nil {
		t.Fatal("revoked invite shown as current")
	}

	// Two distinct operations may commit in either order. The old invitation
	// is revoked once and the successor is the only unrevoked row.
	newBody, oldBody := req(tokenID()), rev(tokenID(), "1")
	var newReply, oldReply reply
	wg.Go(func() { newReply.status, newReply.body = v2("POST", pathB, owner, newBody) })
	wg.Go(func() {
		oldReply.status, oldReply.body = v2("POST", revokePath(pathB, adminInvite["id"]), other, oldBody)
	})
	wg.Wait()
	if newReply.status != 201 || (oldReply.status != 200 && oldReply.status != 409) {
		t.Fatal("concurrent issue/revoke did not serialize")
	}
	if oldReply.status == 409 && oldReply.body["error"].(map[string]any)["code"] != "VERSION_CONFLICT" {
		t.Fatal("concurrent revoke should report version conflict")
	}
	winner := state(newReply.body, "active")
	var valid bool
	query(&valid, `SELECT (SELECT count(*) FROM public.league_invites WHERE league_id=$1 AND revoked_at IS NULL AND id=$2)=1
		AND (SELECT version=2 AND revoked_at IS NOT NULL FROM public.league_invites WHERE id=$3)
		AND NOT EXISTS (SELECT FROM public.league_events WHERE league_id IN ($1,$4) AND (after<>'{}'::jsonb OR target<>invite_id))`,
		f.b, winner["id"], adminInvite["id"], f.a)
	if !valid || current(v2, pathB, owner)["id"] != winner["id"] {
		t.Fatal("parallel issue/revoke or credential-free audit invariant")
	}

	baseline = fingerprint()
	func() {
		exec(`REVOKE INSERT (after) ON public.league_events FROM mjstats_api`)
		defer exec(`GRANT INSERT (after) ON public.league_events TO mjstats_api`)
		assert(v2, "POST", pathB, owner, req(tokenID()), 503, "TEMPORARILY_UNAVAILABLE")
		assert(v2, "POST", revokePath(pathB, winner["id"]), owner, rev(tokenID(), "1"), 503, "TEMPORARILY_UNAVAILABLE")
	}()
	if fingerprint() != baseline || membership() != unchanged {
		t.Fatal("rollback changed invite/event rows or management changed memberships")
	}
	t.Log("Q-14/Q-26 PASS: authenticated owner/admin, no unauthorized invite access, seven days, key rotation, expiry/reissue/revoke, replay/version ordering, concurrent writes, and rollback with unchanged memberships")
}
