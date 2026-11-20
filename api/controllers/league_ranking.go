package controllers

import (
	"context"
	"database/sql"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

type seasonFilter struct {
	Name string
	ID   any
}

func parseSeasonFilter(c *gin.Context, value string) (seasonFilter, bool) {
	switch value {
	case "", "all":
		return seasonFilter{Name: "all"}, true
	case "unassigned":
		return seasonFilter{Name: value}, true
	default:
		if !uuidPattern.MatchString(value) {
			invalidQuery(c, "season")
			return seasonFilter{}, false
		}
		id := strings.ToLower(value)
		return seasonFilter{Name: id, ID: id}, true
	}
}

func (filter seasonFilter) exists(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID string) bool {
	if filter.ID == nil {
		return true
	}
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM public.seasons WHERE league_id=$1 AND id=$2)`,
		leagueID, filter.ID).Scan(&exists); err != nil {
		httpx.Unavailable(c)
		return false
	}
	if !exists {
		httpx.Error(c, 404, "NOT_FOUND", "シーズンが見つかりません", nil)
	}
	return exists
}

type rankingEntry struct {
	Rank       int64      `json:"rank"`
	UserID     string     `json:"user_id"`
	Name       string     `json:"display_name"`
	Kind       string     `json:"kind"`
	Status     string     `json:"membership_status"`
	Point      exactPoint `json:"total_point"`
	MatchCount int64      `json:"match_count"`
}

func (lc *LeagueController) Ranking() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		q, ok := queryParams(c, "season")
		if !ok {
			return nil
		}
		filter, ok := parseSeasonFilter(c, q.Get("season"))
		if !ok || !filter.exists(c, ctx, tx, l.ID) {
			return nil
		}
		rows, err := tx.QueryContext(ctx, `WITH totals AS (
			SELECT COALESCE(p.registered_user_id,r.user_id) AS person,
				sum(r.final_point_numerator::numeric * (30/r.final_point_denominator)) AS ticks,
				count(DISTINCT m.id) AS num_matches
			FROM public.matches m JOIN public.match_results r
				ON r.league_id=m.league_id AND r.match_id=m.id AND r.data_origin='app'
			LEFT JOIN public.participant_links p ON p.league_id=r.league_id
				AND p.guest_user_id=r.user_id AND p.status='active'
			WHERE m.league_id=$1 AND m.data_origin='app' AND m.status='valid'
				AND ($2='all' OR ($2='unassigned' AND m.season_id IS NULL) OR m.season_id=$3::uuid)
			GROUP BY COALESCE(p.registered_user_id,r.user_id)
		)
		SELECT rank() OVER (ORDER BY t.ticks DESC),t.person,u.name,u.participant_kind,m.status,
			div(t.ticks,gcd(t.ticks,30))::text,div(30,gcd(t.ticks,30))::text,t.num_matches
		FROM totals t JOIN public.users u ON u.id=t.person
		JOIN public.league_members m ON m.league_id=$1 AND m.user_id=t.person
		ORDER BY t.ticks DESC,t.person`, l.ID, filter.Name, filter.ID)
		if err != nil {
			httpx.Unavailable(c)
			return nil
		}
		defer rows.Close()
		entries := []rankingEntry{}
		for rows.Next() {
			var e rankingEntry
			if err := rows.Scan(&e.Rank, &e.UserID, &e.Name, &e.Kind, &e.Status,
				&e.Point.Numerator, &e.Point.Denominator, &e.MatchCount); err != nil {
				httpx.Unavailable(c)
				return nil
			}
			entries = append(entries, e)
		}
		if rows.Err() != nil {
			httpx.Unavailable(c)
			return nil
		}
		return gin.H{"metric": "total_point", "season": filter.Name, "entries": entries}
	})
}
