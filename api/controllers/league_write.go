package controllers

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/auth"
	"github.com/kosuke/mj-stats-api/httpx"
)

type LeagueWrite struct{ Auth *auth.Guard }

type leagueWriteAction func(context.Context, *sql.Tx, league, string) (int, any)

// All membership, participant link and match writers take the league lock
// before reading the affected memberships/links. Join already uses this row.
func (w *LeagueWrite) run(c *gin.Context, manager bool, action leagueWriteAction) {
	w.runMembership(c, manager, false, action)
}

func (w *LeagueWrite) runMembership(c *gin.Context, manager, allowFormer bool, action leagueWriteAction) {
	id := strings.ToLower(pathLeague(c))
	if !uuidPattern.MatchString(id) {
		invalidQuery(c, "league_id")
		return
	}
	tx, ctx, cancel, err := w.Auth.BeginWrite(c)
	if err != nil {
		auth.Reject(c, err)
		return
	}
	defer cancel()
	defer tx.Rollback()

	actor := c.GetString("participant_id")
	var l league
	err = tx.QueryRowContext(ctx, registeredLeagues+` AND l.id=$2
		AND (m.status='active' OR ($3 AND m.status IN ('left','removed')))`, actor, id, allowFormer).
		Scan(&l.ID, &l.Name, &l.GroupNumber, &l.MyRole)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, 403, "LEAGUE_ACCESS_DENIED", "このリーグには記録できません", nil)
		return
	}
	if err != nil {
		httpx.Unavailable(c)
		return
	}
	if manager && !managerRole(l.MyRole) {
		httpx.Error(c, 403, "FORBIDDEN", "リーグ運営者の権限が必要です", nil)
		return
	}
	err = tx.QueryRowContext(ctx, `SELECT id FROM public.leagues
		WHERE id=$1 AND group_number IS NOT NULL FOR UPDATE`, id).Scan(&l.ID)
	if err == nil && !lockRegisteredActor(c, ctx, tx, actor) {
		return
	}
	if err == nil {
		err = tx.QueryRowContext(ctx, `SELECT role FROM public.league_members
			WHERE league_id=$1 AND user_id=$2 AND participant_kind='registered' AND (status='active' OR ($3 AND status IN ('left','removed')))
			AND role IN ('owner','admin','member') FOR SHARE`, id, actor, allowFormer).Scan(&l.MyRole)
	}
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 403, "LEAGUE_ACCESS_DENIED", "このリーグには記録できません", nil)
		return
	case err != nil:
		httpx.Unavailable(c)
		return
	case manager && !managerRole(l.MyRole):
		httpx.Error(c, 403, "FORBIDDEN", "リーグ運営者の権限が必要です", nil)
		return
	}
	if _, err = tx.ExecContext(ctx, `SELECT set_config('mjstats.league_id',$1,true),
		set_config('mjstats.league_actor_id',$2,true)`, id, actor); err != nil {
		httpx.Unavailable(c)
		return
	}
	status, body := action(ctx, tx, l, actor)
	if body == nil {
		return
	}
	if !w.Auth.BeforeCommit(c) {
		httpx.Unauthenticated(c)
		return
	}
	if err := tx.Commit(); err != nil {
		httpx.Unavailable(c)
		return
	}
	c.JSON(status, body)
}

func requestHash(input any) string {
	data, err := json.Marshal(input)
	if err != nil {
		panic(err) // Commands contain only validated JSON primitives.
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func requestConflict(c *gin.Context) {
	httpx.Error(c, 409, "IDEMPOTENCY_CONFLICT", "操作IDが別の入力で使用されています", nil)
}

func replayLeagueEvent(c *gin.Context, ctx context.Context, tx *sql.Tx, actor, operation, id, hash string) (string, bool) {
	// Events have an actor-wide key. Serialize it even across different leagues.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(
		hashtextextended($1 || ':' || $2 || ':' || $3,0))`, operation, actor, id); err != nil {
		httpx.Unavailable(c)
		return "", false
	}
	var target, previousHash string
	err := tx.QueryRowContext(ctx, `SELECT target,request_hash FROM public.league_events
		WHERE actor_id=$1 AND operation=$2 AND client_request_id=$3`, actor, operation, id).Scan(&target, &previousHash)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return "", true
	case err != nil:
		httpx.Unavailable(c)
	case previousHash != hash:
		requestConflict(c)
	default:
		return target, true
	}
	return "", false
}

func appendLeagueEvent(ctx context.Context, tx *sql.Tx, l league, actor, operation, id, target, hash string, version int, snapshot json.RawMessage) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO public.league_events
		(league_id,actor_id,operation,client_request_id,target,version,request_hash,after)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, l.ID, actor, operation, id, target, version, hash, string(snapshot))
	return err
}
