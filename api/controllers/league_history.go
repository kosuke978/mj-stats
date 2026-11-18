package controllers

import (
	"context"
	"database/sql"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

func RecordingUnavailable(c *gin.Context) {
	httpx.Error(c, 409, "RECORDING_UNAVAILABLE", "対局の計算・記録は現在利用できません", nil)
}

func (lc *LeagueController) LegacyHistory() gin.HandlerFunc {
	read := lc.scoped(func(c *gin.Context) string { return c.Query("league_id") }, lc.history)
	return func(c *gin.Context) {
		if _, ok := queryParams(c, "league_id", "season", "status", "limit", "cursor"); ok {
			read(c)
		}
	}
}

func (lc *LeagueController) History() gin.HandlerFunc {
	return lc.scoped(pathLeague, lc.history)
}

func historyKeys(p pageCursor) bool {
	return timestampKey(p.Key, "-infinity") && timestampKey(p.Second, "-infinity")
}

func (lc *LeagueController) history(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
	allowed := []string{"season", "status", "limit", "cursor"}
	if c.FullPath() == "/api/matches" {
		allowed = append(allowed, "league_id")
	}
	q, ok := queryParams(c, allowed...)
	if !ok {
		return nil
	}
	season, status := q.Get("season"), q.Get("status")
	if season == "" {
		season = "all"
	}
	if status == "" {
		status = "all"
	}
	if status != "all" && status != "valid" && status != "cancelled" {
		invalidQuery(c, "status")
		return nil
	}
	var seasonID any
	if season != "all" && season != "unassigned" {
		if !uuidPattern.MatchString(season) {
			invalidQuery(c, "season")
			return nil
		}
		season = strings.ToLower(season)
		seasonID = season
	}
	limit, cursor, ok := pageInput(c, q, l, "matches", season+"/"+status, historyKeys)
	if !ok {
		return nil
	}
	if seasonID != nil {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM public.seasons WHERE league_id=$1 AND id=$2)`, l.ID, seasonID).Scan(&exists); err != nil {
			httpx.Unavailable(c)
			return nil
		}
		if !exists {
			httpx.Error(c, 404, "NOT_FOUND", "シーズンが見つかりません", nil)
			return nil
		}
	}
	if status == "cancelled" {
		return gin.H{"matches": []any{}, "next_cursor": nil}
	}

	if _, err := tx.ExecContext(ctx, `SELECT set_config('mjstats.league_id',$1,true)`, l.ID); err != nil {
		httpx.Unavailable(c)
		return nil
	}
	var after any
	if cursor.ID != "" {
		after = cursor.ID
	} else {
		cursor.Key, cursor.Second = "-infinity", "-infinity"
	}
	rows, err := tx.QueryContext(ctx, leagueHistorySQL, l.ID, season, seasonID, after, cursor.Key, cursor.Second, limit+1)
	return pageResponse(c, rows, err, limit, cursor)
}

// Select the page before joining results. Keep stored numeric points and ranks
// as-is, and use the original participant ID to resolve the current name.
const leagueHistorySQL = `
	WITH page AS (
		SELECT id, league_id, rule_id, season_id, recorded_by, match_date, created_at
		FROM public.matches
		WHERE league_id=$1 AND data_origin='app'
		  AND ($2='all' OR ($2='unassigned' AND season_id IS NULL) OR season_id=$3::uuid)
		  AND ($4::uuid IS NULL OR
		    (COALESCE(match_date,created_at,'-infinity'),COALESCE(created_at,'-infinity'),id)
		    < ($5::timestamptz,$6::timestamptz,$4::uuid))
		ORDER BY COALESCE(match_date,created_at) DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
		LIMIT $7
	)
	SELECT json_build_object(
		'id',m.id,'league_id',m.league_id,'season_id',m.season_id,'rule_id',m.rule_id,'recorded_by',m.recorded_by,
		'match_date',to_char(m.match_date AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'created_at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'results', COALESCE((
			SELECT json_agg(json_build_object('user_id',r.user_id,'display_name',u.name,
				'raw_score',r.raw_score,'rank',r.rank,'point',r.final_point) ORDER BY r.rank,r.user_id)
			FROM public.match_results r JOIN public.users u ON u.id=r.user_id
			WHERE r.league_id=m.league_id AND r.match_id=m.id AND r.data_origin='app'
		),'[]'::json)),
		COALESCE(to_char(COALESCE(m.match_date,m.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'-infinity'),
		COALESCE(to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'-infinity'),
		m.id
	FROM page m
	ORDER BY COALESCE(m.match_date,m.created_at) DESC NULLS LAST, m.created_at DESC NULLS LAST, m.id DESC`
