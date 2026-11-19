package controllers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
	"github.com/kosuke/mj-stats-api/models"
)

func (w *LeagueWrite) CreateGuest(c *gin.Context) {
	var input struct {
		Name string `json:"name"`
		ID   string `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	name, err := models.NormalizeName(input.Name)
	if err != nil {
		httpx.Error(c, 400, "INVALID_INPUT", "ゲスト名は1〜30文字で入力してください", nil)
		return
	}
	if !uuidPattern.MatchString(input.ID) {
		invalidQuery(c, "client_request_id")
		return
	}
	input.ID = strings.ToLower(input.ID)
	w.run(c, false, func(ctx context.Context, tx *sql.Tx, l league, actor string) (int, any) {
		const op = "guest.create"
		hash := requestHash([2]string{l.ID, name})
		id, ok := replayLeagueEvent(c, ctx, tx, actor, op, input.ID, hash)
		if !ok {
			return 0, nil
		}
		status := 200
		if id == "" {
			err := tx.QueryRowContext(ctx, `INSERT INTO public.users(name,participant_kind)
				VALUES ($1,'guest') RETURNING id`, name).Scan(&id)
			if err == nil {
				_, err = tx.ExecContext(ctx, `INSERT INTO public.league_members
					(league_id,user_id,participant_kind,role,status) VALUES ($1,$2,'guest','member','active')`, l.ID, id)
			}
			if err != nil {
				httpx.Unavailable(c)
				return 0, nil
			}
			status = 201
		}
		var participant json.RawMessage
		err := tx.QueryRowContext(ctx, `SELECT json_build_object('id',u.id,'name',u.name,
			'kind',u.participant_kind,'version',u.version::text)
			`+memberSource+` AND u.id=$2 AND m.participant_kind='guest'`, l.ID, id).Scan(&participant)
		if err == nil && status == 201 {
			err = appendLeagueEvent(ctx, tx, l, actor, op, input.ID, id, hash, 1, participant)
		}
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		return status, gin.H{"participant": participant}
	})
}

const linkFields = `'id',p.id,'league_id',p.league_id,'guest_user_id',p.guest_user_id,
	'guest_name',g.name,'registered_user_id',p.registered_user_id,'registered_name',u.name,
	'status',p.status,'version',p.version::text,
	'consented_at',to_char(p.consented_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'reviewed_by',p.reviewed_by,'reviewed_at',to_char(p.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
	'confirmation_note',p.confirmation_note,'revoked_by',p.revoked_by,'revoked_at',p.revoked_at`
const linkSource = `FROM public.participant_links p
	JOIN public.users g ON g.id=p.guest_user_id JOIN public.users u ON u.id=p.registered_user_id`

func (lc *LeagueController) Links() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		q, ok := queryParams(c, "limit", "cursor")
		if !ok {
			return nil
		}
		limit, cursor, ok := pageInput(c, q, l, "participant_links", l.MyRole, createdKey)
		if !ok {
			return nil
		}
		var after any
		if cursor.ID != "" {
			after = cursor.ID
		} else {
			cursor.Key = "infinity"
		}
		rows, err := tx.QueryContext(ctx, `SELECT json_build_object(`+linkFields+`),
			to_char(p.consented_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), '', p.id
			`+linkSource+` WHERE p.league_id=$1 AND ($2 OR p.registered_user_id=$3)
			AND ($4::uuid IS NULL OR (p.consented_at,p.id) < ($5::timestamptz,$4::uuid))
			ORDER BY p.consented_at DESC,p.id DESC LIMIT $6`,
			l.ID, l.MyRole != "member", c.GetString("participant_id"), after, cursor.Key, limit+1)
		return pageResponse(c, rows, err, limit, cursor)
	})
}

func linkResponse(c *gin.Context, ctx context.Context, tx *sql.Tx, l league, actor, op, requestID, id, hash string, status, version int) (int, any) {
	var result json.RawMessage
	err := tx.QueryRowContext(ctx, `SELECT json_build_object(`+linkFields+`) `+linkSource+
		` WHERE p.league_id=$1 AND p.id=$2`, l.ID, id).Scan(&result)
	if err == nil && version != 0 {
		err = appendLeagueEvent(ctx, tx, l, actor, op, requestID, id, hash, version, result)
	}
	if err != nil {
		httpx.Unavailable(c)
		return 0, nil
	}
	return status, gin.H{"participant_link": result}
}

func (w *LeagueWrite) RequestLink(c *gin.Context) {
	var input struct {
		Guest string `json:"guest_user_id"`
		ID    string `json:"client_request_id"`
	}
	if !httpx.Decode(c, &input) {
		return
	}
	if !uuidPattern.MatchString(input.Guest) || !uuidPattern.MatchString(input.ID) {
		httpx.Invalid(c)
		return
	}
	input.Guest, input.ID = strings.ToLower(input.Guest), strings.ToLower(input.ID)
	w.run(c, false, func(ctx context.Context, tx *sql.Tx, l league, actor string) (int, any) {
		const op = "participant-link.request"
		hash := requestHash([2]string{l.ID, input.Guest})
		id, ok := replayLeagueEvent(c, ctx, tx, actor, op, input.ID, hash)
		if !ok {
			return 0, nil
		}
		if id != "" {
			return linkResponse(c, ctx, tx, l, actor, op, input.ID, id, hash, 200, 0)
		}
		if !lockMember(c, ctx, tx, l.ID, input.Guest, "guest") {
			return 0, nil
		}
		var conflict bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM public.participant_links
			WHERE league_id=$1 AND guest_user_id=$2
			 AND (status='active' OR (status='pending' AND registered_user_id=$3)))`,
			l.ID, input.Guest, actor).Scan(&conflict)
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		if conflict {
			httpx.Error(c, 409, "STATE_CONFLICT", "このゲストには申請中または承認済みの紐付けがあります", nil)
			return 0, nil
		}
		if err := tx.QueryRowContext(ctx, `INSERT INTO public.participant_links
			(league_id,guest_user_id,registered_user_id) VALUES ($1,$2,$3) RETURNING id`,
			l.ID, input.Guest, actor).Scan(&id); err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		return linkResponse(c, ctx, tx, l, actor, op, input.ID, id, hash, 201, 1)
	})
}

func lockMember(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID, id, kind string) bool {
	var found string
	err := tx.QueryRowContext(ctx, `SELECT user_id FROM public.league_members
		WHERE league_id=$1 AND user_id=$2 AND participant_kind=$3 AND status='active' FOR SHARE`,
		leagueID, id, kind).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, 404, "NOT_FOUND", "このリーグで有効な参加者が見つかりません", nil)
	} else if err != nil {
		httpx.Unavailable(c)
	}
	return err == nil
}

func (w *LeagueWrite) ReviewLink(approve bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		var input struct {
			Note    string `json:"confirmation_note"`
			Version string `json:"version"`
			ID      string `json:"client_request_id"`
		}
		if !httpx.Decode(c, &input) {
			return
		}
		id := strings.ToLower(c.Param("id"))
		version, err := strconv.ParseInt(input.Version, 10, 64)
		if !uuidPattern.MatchString(id) || !uuidPattern.MatchString(input.ID) ||
			err != nil || version < 1 || strconv.FormatInt(version, 10) != input.Version {
			httpx.Invalid(c)
			return
		}
		note := strings.TrimSpace(input.Note)
		if note == "" || utf8.RuneCountInString(note) > 500 || strings.ContainsFunc(note, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) {
			invalidQuery(c, "confirmation_note")
			return
		}
		input.ID = strings.ToLower(input.ID)
		op, next := "participant-link.reject", "rejected"
		if approve {
			op, next = "participant-link.approve", "active"
		}
		w.run(c, true, func(ctx context.Context, tx *sql.Tx, l league, actor string) (int, any) {
			hash := requestHash([4]string{l.ID, id, input.Version, note})
			target, ok := replayLeagueEvent(c, ctx, tx, actor, op, input.ID, hash)
			if !ok {
				return 0, nil
			}
			if target != "" {
				return linkResponse(c, ctx, tx, l, actor, op, input.ID, target, hash, 200, 0)
			}
			var guest, user, status string
			var currentVersion int64
			err := tx.QueryRowContext(ctx, `SELECT guest_user_id,registered_user_id,status,version
				FROM public.participant_links WHERE league_id=$1 AND id=$2`, l.ID, id).
				Scan(&guest, &user, &status, &currentVersion)
			switch {
			case errors.Is(err, sql.ErrNoRows):
				httpx.Error(c, 404, "NOT_FOUND", "紐付け申請が見つかりません", nil)
				return 0, nil
			case err != nil:
				httpx.Unavailable(c)
				return 0, nil
			case currentVersion != version:
				httpx.Error(c, 409, "VERSION_CONFLICT", "申請を読み直してください", nil)
				return 0, nil
			case status != "pending":
				httpx.Error(c, 409, "STATE_CONFLICT", "この申請は確認済みです", nil)
				return 0, nil
			}
			if approve && !canApproveLink(c, ctx, tx, l.ID, guest, user) {
				return 0, nil
			}
			var updated string
			if err := tx.QueryRowContext(ctx, `UPDATE public.participant_links
				SET status=$3,reviewed_by=$4,reviewed_at=now(),confirmation_note=$5,version=version+1
				WHERE league_id=$1 AND id=$2 AND status='pending' RETURNING id`, l.ID, id, next, actor, note).Scan(&updated); err != nil {
				httpx.Unavailable(c)
				return 0, nil
			}
			return linkResponse(c, ctx, tx, l, actor, op, input.ID, updated, hash, 200, 2)
		})
	}
}

func canApproveLink(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID, guest, user string) bool {
	var found string
	if !lockMember(c, ctx, tx, leagueID, guest, "guest") ||
		!lockMember(c, ctx, tx, leagueID, user, "registered") {
		return false
	}
	err := tx.QueryRowContext(ctx, `SELECT id FROM public.users
		WHERE id=$1 AND auth_id IS NOT NULL AND profile_completed_at IS NOT NULL FOR SHARE`, user).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, 409, "STATE_CONFLICT", "申請者の登録状態を確認してください", nil)
		return false
	}
	var conflict bool
	if err == nil {
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM public.participant_links
			WHERE league_id=$1 AND guest_user_id=$2 AND status='active')
			OR EXISTS(SELECT 1 FROM public.match_results g JOIN public.match_results r
			  ON r.league_id=g.league_id AND r.match_id=g.match_id AND r.user_id<>g.user_id
			  LEFT JOIN public.participant_links p ON p.league_id=r.league_id AND p.guest_user_id=r.user_id AND p.status='active'
			  WHERE g.league_id=$1 AND g.user_id=$2 AND COALESCE(p.registered_user_id,r.user_id)=$3)`,
			leagueID, guest, user).Scan(&conflict)
	}
	if err != nil {
		httpx.Unavailable(c)
	} else if conflict {
		httpx.Error(c, 409, "STATE_CONFLICT", "既存の紐付けまたは同じ対局での本人重複を確認してください", nil)
	}
	return err == nil && !conflict
}
