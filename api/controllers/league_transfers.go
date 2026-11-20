package controllers

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

const transferFields = `id,from_user_id,to_user_id,from_version::text,to_version::text,status,expires_at,acted_at,version::text`

type ownerTransfer struct {
	ID          string     `json:"id"`
	From        string     `json:"from_user_id"`
	To          string     `json:"to_user_id"`
	FromVersion string     `json:"-"`
	ToVersion   string     `json:"-"`
	Status      string     `json:"status"`
	Expires     time.Time  `json:"expires_at"`
	Acted       *time.Time `json:"acted_at"`
	Version     string     `json:"version"`
}

func (t *ownerTransfer) scan(row *sql.Row) error {
	return row.Scan(&t.ID, &t.From, &t.To, &t.FromVersion, &t.ToVersion, &t.Status, &t.Expires, &t.Acted, &t.Version)
}

func (lc *LeagueController) CurrentTransfer() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		if _, ok := queryParams(c); !ok {
			return nil
		}
		var t ownerTransfer
		err := t.scan(tx.QueryRowContext(ctx, `SELECT `+transferFields+`
			FROM public.owner_transfers WHERE league_id=$1 AND status='pending'
			AND ($2 OR to_user_id=$3)`, l.ID, managerRole(l.MyRole), c.GetString("participant_id")))
		if errors.Is(err, sql.ErrNoRows) {
			return gin.H{"owner_transfer": nil}
		}
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		if !t.Expires.After(time.Now()) {
			t.Status = "expired"
		}
		return gin.H{"owner_transfer": t}
	})
}

func (w *LeagueWrite) ProposeTransfer(c *gin.Context) {
	var input struct {
		To string `json:"to_user_id"`
		ID string `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) || !normalizeUUID(c, &input.To, "to_user_id") {
		return
	}
	w.manage(c, managementCommand{operation: "owner-transfer.propose", requestID: input.ID, target: input.To,
		ownerOnly: true, managerOnly: true}, func(ctx context.Context, tx *sql.Tx, l league, actor string) *managementChange {
		if actor == input.To {
			invalidQuery(c, "to_user_id")
			return nil
		}
		from, _, ok := readTransferMember(c, ctx, tx, l.ID, actor)
		if !ok {
			return nil
		}
		to, _, ok := readTransferMember(c, ctx, tx, l.ID, input.To)
		if !ok {
			return nil
		}
		_, err := tx.ExecContext(ctx, `UPDATE public.owner_transfers SET status='expired',acted_at=clock_timestamp(),version=version+1
			WHERE league_id=$1 AND status='pending' AND expires_at<=clock_timestamp()`, l.ID)
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		var t ownerTransfer
		err = t.scan(tx.QueryRowContext(ctx, `INSERT INTO public.owner_transfers
			(league_id,from_user_id,to_user_id,from_version,to_version,expires_at)
			VALUES ($1,$2,$3,$4,$5,statement_timestamp()+interval '168 hours')
			ON CONFLICT (league_id) WHERE status='pending' DO NOTHING RETURNING `+transferFields,
			l.ID, actor, input.To, from, to))
		if errors.Is(err, sql.ErrNoRows) {
			stateConflict(c, "承認待ちの引継ぎがあります")
			return nil
		}
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		return &managementChange{id: t.ID, version: t.Version, after: t, created: true}
	})
}

func readTransferMember(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID, userID string) (string, string, bool) {
	var version, role string
	err := tx.QueryRowContext(ctx, `SELECT m.version::text,m.role FROM public.league_members m
		JOIN public.users u ON u.id=m.user_id
		WHERE m.league_id=$1 AND m.user_id=$2 AND m.participant_kind='registered' AND m.status='active'
		AND u.auth_id IS NOT NULL AND u.profile_completed_at IS NOT NULL FOR SHARE OF u`,
		leagueID, userID).Scan(&version, &role)
	if errors.Is(err, sql.ErrNoRows) {
		stateConflict(c, "引継ぎに必要な有効所属を確認してください")
	} else if err != nil {
		httpx.Unavailable(c)
	}
	return version, role, err == nil
}

func (w *LeagueWrite) ActOnTransfer(accept bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var input struct {
			Version string `json:"version"`
			ID      string `json:"client_request_id"`
		}
		id := c.Param("id")
		if !httpx.Decode(c, &input) || !normalizeUUID(c, &id, "id") || !normalizeVersion(c, input.Version) {
			return
		}
		operation, next := "owner-transfer.cancel", "cancelled"
		if accept {
			operation, next = "owner-transfer.accept", "accepted"
		}
		w.manage(c, managementCommand{operation: operation, requestID: input.ID, target: id, version: input.Version, ownerOnly: !accept},
			func(ctx context.Context, tx *sql.Tx, l league, actor string) *managementChange {
				var t ownerTransfer
				if !managementFound(c, t.scan(tx.QueryRowContext(ctx, `SELECT `+transferFields+`
				FROM public.owner_transfers WHERE league_id=$1 AND id=$2`, l.ID, id))) {
					return nil
				}
				if (accept && t.To != actor) || (!accept && t.From != actor) {
					httpx.Error(c, 403, "FORBIDDEN", "この引継ぎを操作できる本人に限られます", nil)
					return nil
				}
				if !checkVersion(c, t.Version, input.Version) {
					return nil
				}
				if t.Status != "pending" || (accept && !t.Expires.After(time.Now())) {
					stateConflict(c, "この引継ぎはすでに終了しています")
					return nil
				}
				before := t
				if accept && !acceptOwnerTransfer(c, ctx, tx, l.ID, t) {
					return nil
				}
				err := t.scan(tx.QueryRowContext(ctx, `UPDATE public.owner_transfers
				SET status=$3,acted_at=clock_timestamp(),version=version+1
				WHERE league_id=$1 AND id=$2 AND status='pending'
				AND ($3<>'accepted' OR expires_at>clock_timestamp()) RETURNING `+transferFields, l.ID, id, next))
				if errors.Is(err, sql.ErrNoRows) {
					stateConflict(c, "引継ぎの期限または状態が変わりました")
					return nil
				}
				if err != nil {
					httpx.Unavailable(c)
					return nil
				}
				return &managementChange{id: t.ID, version: t.Version, before: before, after: t}
			})
	}
}

func acceptOwnerTransfer(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID string, t ownerTransfer) bool {
	from, role, ok := readTransferMember(c, ctx, tx, leagueID, t.From)
	if !ok {
		return false
	}
	to, _, ok := readTransferMember(c, ctx, tx, leagueID, t.To)
	if !ok {
		return false
	}
	var currentOwner string
	if err := tx.QueryRowContext(ctx, `SELECT owner_id FROM public.leagues WHERE id=$1`, leagueID).Scan(&currentOwner); err != nil {
		httpx.Unavailable(c)
		return false
	}
	if currentOwner != t.From || role != "owner" || from != t.FromVersion || to != t.ToVersion {
		stateConflict(c, "引継ぎの指名後に所属が変わりました")
		return false
	}
	// The unique active owner index is immediate, so demote the old owner first.
	for _, step := range []struct{ id, role string }{{t.From, "admin"}, {t.To, "owner"}} {
		if _, err := tx.ExecContext(ctx, `UPDATE public.league_members SET role=$3,version=version+1
			WHERE league_id=$1 AND user_id=$2`, leagueID, step.id, step.role); err != nil {
			httpx.Unavailable(c)
			return false
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE public.leagues SET owner_id=$2,version=version+1 WHERE id=$1`,
		leagueID, t.To); err != nil {
		httpx.Unavailable(c)
		return false
	}
	return true
}
