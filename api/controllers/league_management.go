package controllers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

type managementCommand struct {
	operation, requestID, target, version, reason string
	ownerOnly, managerOnly, allowFormer           bool
	payload                                       any
	legacyPayload                                 any
}

type managementChange struct {
	id, version   string
	before, after any
	created       bool
}

type managementAction func(context.Context, *sql.Tx, league, string) *managementChange

func ownerRequired(c *gin.Context) {
	httpx.Error(c, 403, "FORBIDDEN", "オーナーの権限が必要です", nil)
}

func (w *LeagueWrite) manage(c *gin.Context, command managementCommand, change managementAction) {
	if !normalizeUUID(c, &command.requestID, "client_request_id") {
		return
	}
	if _, ok := queryParams(c); !ok {
		return
	}
	w.runMembership(c, command.managerOnly, command.allowFormer, func(ctx context.Context, tx *sql.Tx, l league, actor string) (int, any) {
		if command.ownerOnly && l.MyRole != "owner" {
			ownerRequired(c)
			return 0, nil
		}
		hash := requestHash([]any{l.ID, command.target, command.version, command.reason, command.payload})
		var legacyHash string
		if command.legacyPayload != nil {
			legacyHash = requestHash([]any{l.ID, command.target, command.version, command.reason, command.legacyPayload})
		}
		target, ok := replayLeagueEvent(c, ctx, tx, actor, command.operation, command.requestID, hash, legacyHash)
		if !ok {
			return 0, nil
		}
		if target != "" {
			var version string
			if err := tx.QueryRowContext(ctx, `SELECT version::text FROM public.league_events
				WHERE league_id=$1 AND actor_id=$2 AND operation=$3 AND client_request_id=$4`,
				l.ID, actor, command.operation, command.requestID).Scan(&version); err != nil {
				httpx.Unavailable(c)
				return 0, nil
			}
			return http.StatusOK, gin.H{"id": target, "version": version}
		}
		result := change(ctx, tx, l, actor)
		if result == nil {
			return 0, nil
		}
		after, err := json.Marshal(result.after)
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		var before any
		if result.before != nil {
			value, err := json.Marshal(result.before)
			if err != nil {
				httpx.Unavailable(c)
				return 0, nil
			}
			before = string(value)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO public.league_events
			(league_id,actor_id,operation,client_request_id,target,version,request_hash,before,after,reason)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NULLIF($10,''))`, l.ID, actor, command.operation,
			command.requestID, result.id, result.version, hash, before, string(after), command.reason)
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		status := http.StatusOK
		if result.created {
			status = http.StatusCreated
		}
		return status, gin.H{"id": result.id, "version": result.version}
	})
}

func managementFound(c *gin.Context, err error) bool {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 404, "NOT_FOUND", "対象がこのリーグに見つかりません", nil)
	case err != nil:
		httpx.Unavailable(c)
	default:
		return true
	}
	return false
}

func checkVersion(c *gin.Context, current, want string) bool {
	if current != want {
		httpx.Error(c, 409, "VERSION_CONFLICT", "最新の状態を読み直してください", nil)
		return false
	}
	return true
}

func (lc *LeagueController) LeagueEvents() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		if !requireManager(c, l) {
			return nil
		}
		q, ok := queryParams(c, "limit", "cursor")
		if !ok {
			return nil
		}
		limit, cursor, ok := pageInput(c, q, l, "events", "", createdKey)
		if !ok {
			return nil
		}
		after, key := auditPageKeys(cursor)
		rows, err := tx.QueryContext(ctx, `SELECT json_build_object('id',id,'actor_id',actor_id,'operation',operation,
			'target',target,'version',version::text,'before',before,'after',after,'reason',reason,'created_at',created_at),
			to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'',id
			FROM public.league_events WHERE league_id=$1
			AND ($2::uuid IS NULL OR (created_at,id)<($3::timestamptz,$2::uuid))
			ORDER BY created_at DESC,id DESC LIMIT $4`, l.ID, after, key, limit+1)
		return pageResponse(c, rows, err, limit, cursor)
	})
}

func (w *LeagueWrite) ChangeRole(c *gin.Context) {
	var input struct {
		Role    string `json:"role"`
		Version string `json:"version"`
		ID      string `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) || !normalizeVersion(c, input.Version) {
		return
	}
	if input.Role != "member" && input.Role != "admin" {
		invalidQuery(c, "role")
		return
	}
	target := c.Param("user_id")
	if normalizeUUID(c, &target, "user_id") {
		w.changeMembership(c, managementCommand{operation: "member.role", requestID: input.ID, target: target, version: input.Version,
			ownerOnly: true, managerOnly: true, payload: input.Role}, input.Role, "active")
	}
}

func (w *LeagueWrite) RemoveMember(c *gin.Context) {
	var input versionedReason
	if !httpx.Decode(c, &input) || !normalizeVersion(c, input.Version) || !normalizeReason(c, &input.Reason) {
		return
	}
	target := c.Param("user_id")
	if normalizeUUID(c, &target, "user_id") {
		w.changeMembership(c, managementCommand{operation: "member.remove", requestID: input.ClientRequestID, target: target,
			version: input.Version, reason: input.Reason, managerOnly: true}, "", "removed")
	}
}

func (w *LeagueWrite) LeaveLeague(c *gin.Context) {
	var input struct {
		ID string `json:"client_request_id"`
	}
	if httpx.Decode(c, &input) {
		w.changeMembership(c, managementCommand{operation: "member.leave", requestID: input.ID,
			target: c.GetString("participant_id"), allowFormer: true}, "", "left")
	}
}

func (w *LeagueWrite) changeMembership(c *gin.Context, command managementCommand, role, status string) {
	w.manage(c, command, func(ctx context.Context, tx *sql.Tx, l league, actor string) *managementChange {
		var membership joinMembership
		membership.LeagueID, membership.UserID = l.ID, command.target
		err := membership.scan(tx.QueryRowContext(ctx, `SELECT participant_kind,role,status,version::text
			FROM public.league_members WHERE league_id=$1 AND user_id=$2 AND participant_kind='registered'`,
			l.ID, command.target))
		if !managementFound(c, err) {
			return nil
		}
		if membership.Role == "owner" || membership.Status != "active" {
			if command.operation == "member.leave" && membership.Role == "owner" {
				stateConflict(c, "脱退するには先にオーナーを引き継いでください")
			} else {
				stateConflict(c, "この所属は変更できません")
			}
			return nil
		}
		if command.operation == "member.remove" && l.MyRole == "admin" && membership.Role != "member" {
			ownerRequired(c)
			return nil
		}
		if command.version != "" && !checkVersion(c, membership.Version, command.version) {
			return nil
		}
		before := membership
		err = membership.scan(tx.QueryRowContext(ctx, `UPDATE public.league_members
			SET role=COALESCE(NULLIF($3,''),role),status=$4::varchar,version=version+1,
			ended_at=CASE WHEN $4::varchar='active' THEN NULL ELSE statement_timestamp() END
			WHERE league_id=$1 AND user_id=$2 RETURNING participant_kind,role,status,version::text`,
			l.ID, command.target, role, status))
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		return &managementChange{id: membership.UserID, version: membership.Version, before: before, after: membership}
	})
}
