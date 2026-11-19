package controllers

import (
	"context"
	"database/sql"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

func RecordingRetired(c *gin.Context) {
	httpx.Error(c, 410, "API_RETIRED", "所属リーグの対局入力をご利用ください", nil)
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
	status := q.Get("status")
	if status == "" {
		status = "all"
	}
	if status != "all" && status != "valid" && status != "cancelled" {
		invalidQuery(c, "status")
		return nil
	}
	filter, ok := parseSeasonFilter(c, q.Get("season"))
	if !ok {
		return nil
	}
	limit, cursor, ok := pageInput(c, q, l, "matches", filter.Name+"/"+status, historyKeys)
	if !ok || !filter.exists(c, ctx, tx, l.ID) {
		return nil
	}
	var after any
	if cursor.ID != "" {
		after = cursor.ID
	} else {
		cursor.Key, cursor.Second = "-infinity", "-infinity"
	}
	rows, err := tx.QueryContext(ctx, leagueHistorySQL, l.ID, filter.Name, filter.ID, after, cursor.Key, cursor.Second, limit+1, status)
	return pageResponse(c, rows, err, limit, cursor)
}

// The list, detail and save responses use stored points and ranks.
const matchJSON = `json_build_object(
		'id',m.id,'league_id',m.league_id,'season_id',m.season_id,'rule_id',m.rule_id,'recorded_by',m.recorded_by,
		'status',m.status,'version',m.version::text,
		'match_date',to_char(m.match_date AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'created_at',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
		'results', COALESCE((
			SELECT json_agg(json_build_object('user_id',r.user_id,
				'canonical_user_id',COALESCE(p.registered_user_id,r.user_id),'display_name',COALESCE(person.name,u.name),
				'raw_score',r.raw_score,'rank',r.rank,'point',json_build_object(
					'numerator',r.final_point_numerator::text,'denominator',r.final_point_denominator::text)) ORDER BY r.rank,r.user_id)
			FROM public.match_results r JOIN public.users u ON u.id=r.user_id
			LEFT JOIN public.participant_links p ON p.league_id=r.league_id AND p.guest_user_id=r.user_id AND p.status='active'
			LEFT JOIN public.users person ON person.id=p.registered_user_id
			WHERE r.league_id=m.league_id AND r.match_id=m.id AND r.data_origin='app'
		),'[]'::json))`

const leagueHistorySQL = `
	WITH page AS (
		SELECT id, league_id, rule_id, season_id, recorded_by, match_date, created_at, status, version
		FROM public.matches
		WHERE league_id=$1 AND data_origin='app' AND ($8='all' OR status=$8)
		  AND ($2='all' OR ($2='unassigned' AND season_id IS NULL) OR season_id=$3::uuid)
		  AND ($4::uuid IS NULL OR
		    (COALESCE(match_date,created_at,'-infinity'),COALESCE(created_at,'-infinity'),id)
		    < ($5::timestamptz,$6::timestamptz,$4::uuid))
		ORDER BY COALESCE(match_date,created_at) DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
		LIMIT $7
	)
	SELECT ` + matchJSON + `,
		COALESCE(to_char(COALESCE(m.match_date,m.created_at) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'-infinity'),
		COALESCE(to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'-infinity'),
		m.id
	FROM page m
	ORDER BY COALESCE(m.match_date,m.created_at) DESC NULLS LAST, m.created_at DESC NULLS LAST, m.id DESC`
