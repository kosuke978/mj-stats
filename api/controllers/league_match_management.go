package controllers

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

type versionedReason struct {
	Reason          string `json:"reason"`
	Version         string `json:"version"`
	ClientRequestID string `json:"client_request_id"`
}

func normalizeVersion(c *gin.Context, version string) bool {
	n, err := strconv.ParseInt(version, 10, 64)
	if err != nil || n < 1 || strconv.FormatInt(n, 10) != version {
		invalidQuery(c, "version")
		return false
	}
	return true
}

func normalizeUUID(c *gin.Context, value *string, field string) bool {
	if !uuidPattern.MatchString(*value) {
		invalidQuery(c, field)
		return false
	}
	*value = strings.ToLower(*value)
	return true
}

func normalizeReason(c *gin.Context, value *string) bool {
	*value = strings.TrimSpace(*value)
	if n := utf8.RuneCountInString(*value); n < 1 || n > 500 || strings.ContainsRune(*value, 0) {
		invalidQuery(c, "reason")
		return false
	}
	return true
}

func stateConflict(c *gin.Context, message string) {
	httpx.Error(c, 409, "STATE_CONFLICT", message, nil)
}

func managerRole(role string) bool { return role == "owner" || role == "admin" }

func requireManager(c *gin.Context, l league) bool {
	if !managerRole(l.MyRole) {
		httpx.Error(c, 403, "FORBIDDEN", "リーグ運営者の権限が必要です", nil)
		return false
	}
	return true
}

func (w *LeagueWrite) CorrectMatch(c *gin.Context) {
	received := time.Now()
	var data struct {
		RuleID          string       `json:"rule_id"`
		SeasonID        *string      `json:"season_id"`
		Date            string       `json:"match_date"`
		Players         []scoreInput `json:"players"`
		Reason          string       `json:"reason"`
		Version         string       `json:"version"`
		ClientRequestID string       `json:"client_request_id"`
	}
	if !httpx.Decode(c, &data) {
		return
	}
	input := matchInput{RuleID: data.RuleID, SeasonID: data.SeasonID, Date: data.Date, Players: data.Players, ClientRequestID: data.ClientRequestID}
	date, ok := normalizeMatchInput(c, &input)
	if !ok {
		return
	}
	w.changeMatch(c, versionedReason{Reason: data.Reason, Version: data.Version, ClientRequestID: input.ClientRequestID},
		"update", &input, date, received)
}

func (w *LeagueWrite) CancelMatch(c *gin.Context) {
	var input versionedReason
	if httpx.Decode(c, &input) {
		w.changeMatch(c, input, "cancel", nil, time.Time{}, time.Time{})
	}
}

func (w *LeagueWrite) changeMatch(c *gin.Context, meta versionedReason, operation string, input *matchInput, date, received time.Time) {
	id := c.Param("match_id")
	if !normalizeUUID(c, &id, "match_id") || !normalizeUUID(c, &meta.ClientRequestID, "client_request_id") ||
		!normalizeVersion(c, meta.Version) || !normalizeReason(c, &meta.Reason) {
		return
	}
	if _, ok := queryParams(c); !ok {
		return
	}
	hash := requestHash(struct {
		ID, Operation string
		Meta          versionedReason
		Input         *matchInput
	}{id, operation, meta, input})
	w.run(c, true, func(ctx context.Context, tx *sql.Tx, l league, actor string) (int, any) {
		var applied, previousHash string
		err := tx.QueryRowContext(ctx, `SELECT version::text,request_hash FROM public.match_revisions
			WHERE league_id=$1 AND actor_id=$2 AND client_request_id=$3 AND operation<>'create'`,
			l.ID, actor, meta.ClientRequestID).Scan(&applied, &previousHash)
		switch {
		case err == nil && previousHash != hash:
			requestConflict(c)
			return 0, nil
		case err == nil:
			return 200, gin.H{"match_id": id, "applied_version": applied}
		case !errors.Is(err, sql.ErrNoRows):
			httpx.Unavailable(c)
			return 0, nil
		}

		var status, version, ruleID string
		err = tx.QueryRowContext(ctx, `SELECT status,version::text,rule_id FROM public.matches
			WHERE league_id=$1 AND id=$2 AND data_origin='app' AND client_request_id IS NOT NULL`,
			l.ID, id).Scan(&status, &version, &ruleID)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			httpx.Error(c, 404, "NOT_FOUND", "対局が見つかりません", nil)
			return 0, nil
		case err != nil:
			httpx.Unavailable(c)
			return 0, nil
		case status != "valid":
			stateConflict(c, "対局が更新されています。最新の状態を確認してください")
			return 0, nil
		}
		if !checkVersion(c, version, meta.Version) {
			return 0, nil
		}
		before := readMatch(c, ctx, tx, l.ID, id)
		if before == nil {
			return 0, nil
		}
		if input == nil {
			err = tx.QueryRowContext(ctx, `UPDATE public.matches SET status='cancelled',version=version+1
				WHERE league_id=$1 AND id=$2 RETURNING version::text`, l.ID, id).Scan(&applied)
		} else {
			if date.After(received) {
				invalidQuery(c, "match_date")
				return 0, nil
			}
			if input.SeasonID != nil && !matchInSeason(c, ctx, tx, l.ID, *input.SeasonID, date) {
				return 0, nil
			}
			results := calculateMatch(c, ctx, tx, l.ID, input.RuleID, input.Players, true, ruleID)
			if results == nil {
				return 0, nil
			}
			if err = replaceMatchResults(ctx, tx, l.ID, id, results); err == nil {
				err = tx.QueryRowContext(ctx, `UPDATE public.matches SET rule_id=$3,season_id=$4,match_date=$5,version=version+1
					WHERE league_id=$1 AND id=$2 RETURNING version::text`, l.ID, id, input.RuleID, input.SeasonID, date.UTC()).Scan(&applied)
			}
		}
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		after := readMatch(c, ctx, tx, l.ID, id)
		if after == nil {
			return 0, nil
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO public.match_revisions
			(league_id,match_id,actor_id,operation,version,client_request_id,request_hash,reason,before,after)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, l.ID, id, actor, operation, applied,
			meta.ClientRequestID, hash, meta.Reason, string(before), string(after))
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		return 200, gin.H{"match_id": id, "applied_version": applied}
	})
}

// Results for retained participants keep their row IDs. A new participant
// replaces an outgoing participant, so immediate uniqueness never sees a swap.
func replaceMatchResults(ctx context.Context, tx *sql.Tx, leagueID, matchID string, results []matchResult) error {
	rows, err := tx.QueryContext(ctx, `SELECT user_id FROM public.match_results
		WHERE league_id=$1 AND match_id=$2 ORDER BY user_id`, leagueID, matchID)
	if err != nil {
		return err
	}
	defer rows.Close()
	retained := map[string]bool{}
	for _, result := range results {
		retained[result.UserID] = true
	}
	existing := map[string]bool{}
	var outgoing []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return err
		}
		existing[id] = true
		if !retained[id] {
			outgoing = append(outgoing, id)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(existing) != len(results) {
		return errors.New("incomplete match")
	}
	for _, result := range results {
		previous := result.UserID
		if !existing[previous] {
			previous = outgoing[0]
			outgoing = outgoing[1:]
		}
		updated, err := tx.ExecContext(ctx, `UPDATE public.match_results SET user_id=$4,raw_score=$5,rank=$6,
			final_point_numerator=$7,final_point_denominator=$8 WHERE league_id=$1 AND match_id=$2 AND user_id=$3`,
			leagueID, matchID, previous, result.UserID, result.Score, result.Rank, result.Point.Numerator, result.Point.Denominator)
		if err != nil {
			return err
		}
		if n, err := updated.RowsAffected(); err != nil || n != 1 {
			return errors.New("result update did not affect one row")
		}
	}
	return nil
}

func (lc *LeagueController) MatchRevisions() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		if !requireManager(c, l) {
			return nil
		}
		id := c.Param("match_id")
		if !normalizeUUID(c, &id, "match_id") || readMatch(c, ctx, tx, l.ID, id) == nil {
			return nil
		}
		q, ok := queryParams(c, "cursor", "limit")
		if !ok {
			return nil
		}
		limit, cursor, ok := pageInput(c, q, l, "revisions", id, createdKey)
		if !ok {
			return nil
		}
		after, key := auditPageKeys(cursor)
		rows, err := tx.QueryContext(ctx, `SELECT json_build_object('id',id,'match_id',match_id,
			'operation',operation,'version',version::text,'actor_id',actor_id,'reason',reason,
			'before',before,'after',after,'created_at',created_at),
			to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'',id
			FROM public.match_revisions WHERE league_id=$1 AND match_id=$2
			AND ($3::uuid IS NULL OR (created_at,id)<($4::timestamptz,$3::uuid))
			ORDER BY created_at DESC,id DESC LIMIT $5`, l.ID, id, after, key, limit+1)
		return pageResponse(c, rows, err, limit, cursor)
	})
}

func auditPageKeys(cursor pageCursor) (any, string) {
	if cursor.ID == "" {
		return nil, "infinity"
	}
	return cursor.ID, cursor.Key
}
