package controllers

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/httpx"
)

type scoreInput struct {
	UserID string `json:"user_id"`
	Score  *int32 `json:"raw_score"`
}

type matchInput struct {
	RuleID          string       `json:"rule_id"`
	SeasonID        *string      `json:"season_id"`
	Date            string       `json:"match_date"`
	Players         []scoreInput `json:"players"`
	ClientRequestID string       `json:"client_request_id"`
}

type exactPoint struct {
	Numerator   string `json:"numerator"`
	Denominator string `json:"denominator"`
}

type matchResult struct {
	UserID      string     `json:"user_id"`
	CanonicalID string     `json:"canonical_user_id"`
	DisplayName string     `json:"display_name"`
	Score       int32      `json:"raw_score"`
	Rank        int        `json:"rank"`
	Point       exactPoint `json:"point"`
}

type scoringRule struct {
	Start, Return int64
	Uma           [4]int64
	Available     bool
}

func normalizeScores(c *gin.Context, rule *string, players []scoreInput) bool {
	if !uuidPattern.MatchString(*rule) {
		invalidQuery(c, "rule_id")
		return false
	}
	*rule = strings.ToLower(*rule)
	if len(players) != 4 {
		httpx.Error(c, 400, "INVALID_INPUT", "参加者を4人選んでください", nil)
		return false
	}
	seen := make(map[string]bool, len(players))
	for i := range players {
		p := &players[i]
		if !uuidPattern.MatchString(p.UserID) {
			invalidQuery(c, "players.user_id")
			return false
		}
		p.UserID = strings.ToLower(p.UserID)
		if seen[p.UserID] {
			httpx.Error(c, 400, "INVALID_INPUT", "異なる参加者を4人選んでください", nil)
			return false
		}
		seen[p.UserID] = true
		if p.Score == nil || *p.Score%100 != 0 {
			httpx.Error(c, 400, "INVALID_INPUT", "素点を100点単位で入力してください", nil)
			return false
		}
	}
	return true
}

func (lc *LeagueController) CalculateMatch() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		var input struct {
			RuleID  string       `json:"rule_id"`
			Players []scoreInput `json:"players"`
		}
		if !httpx.Decode(c, &input) || !normalizeScores(c, &input.RuleID, input.Players) {
			return nil
		}
		results := calculateMatch(c, ctx, tx, l.ID, input.RuleID, input.Players, false, "")
		if results == nil {
			return nil
		}
		return gin.H{"rule_id": input.RuleID, "results": results}
	})
}

func calculateMatch(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID, ruleID string, players []scoreInput, lock bool, retainedRule string) []matchResult {
	var rule scoringRule
	ruleQuery := `SELECT default_points,return_points,uma_1,uma_2,uma_3,uma_4,available
		FROM public.rules WHERE league_id=$1 AND id=$2 AND calculation_version='exact_v1'`
	if lock {
		ruleQuery += " FOR SHARE"
	}
	err := tx.QueryRowContext(ctx, ruleQuery, leagueID, ruleID).Scan(
		&rule.Start, &rule.Return, &rule.Uma[0], &rule.Uma[1], &rule.Uma[2], &rule.Uma[3], &rule.Available)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 404, "NOT_FOUND", "このリーグのルールが見つかりません", nil)
		return nil
	case err != nil:
		httpx.Unavailable(c)
		return nil
	case !rule.Available && ruleID != retainedRule:
		httpx.Error(c, 409, "STATE_CONFLICT", "このルールは利用を停止しています", nil)
		return nil
	}
	var total int64
	for _, p := range players {
		total += int64(*p.Score)
	}
	if total != 4*rule.Start {
		httpx.Error(c, 400, "INVALID_INPUT", "素点の合計をルールの開始時総点に合わせてください", nil)
		return nil
	}

	memberQuery := `SELECT COALESCE(p.registered_user_id,u.id),COALESCE(person.name,u.name)
		FROM public.league_members m JOIN public.users u ON u.id=m.user_id
		LEFT JOIN public.participant_links p ON p.league_id=m.league_id AND p.guest_user_id=m.user_id AND p.status='active'
		LEFT JOIN public.users person ON person.id=p.registered_user_id
		WHERE m.league_id=$1 AND m.user_id=$2 AND m.status='active'
		AND m.participant_kind IN ('guest','registered')`
	if lock {
		memberQuery += " FOR SHARE OF m"
	}
	results := make([]matchResult, len(players))
	seen := make(map[string]bool, len(players))
	for i, p := range players {
		r := &results[i]
		r.UserID, r.Score = p.UserID, *p.Score
		err := tx.QueryRowContext(ctx, memberQuery, leagueID, p.UserID).Scan(&r.CanonicalID, &r.DisplayName)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			httpx.Error(c, 404, "NOT_FOUND", "このリーグで有効な参加者が見つかりません", nil)
			return nil
		case err != nil:
			httpx.Unavailable(c)
			return nil
		case seen[r.CanonicalID]:
			httpx.Error(c, 409, "STATE_CONFLICT", "本人が同じ参加者が含まれています", nil)
			return nil
		}
		seen[r.CanonicalID] = true
	}
	scoreResults(rule, results)
	return results
}

func scoreResults(rule scoringRule, results []matchResult) {
	slices.SortFunc(results, func(a, b matchResult) int {
		if order := cmp.Compare(b.Score, a.Score); order != 0 {
			return order
		}
		return strings.Compare(a.UserID, b.UserID)
	})
	for start := 0; start < len(results); {
		end := start + 1
		for end < len(results) && results[start].Score == results[end].Score {
			end++
		}
		var awards int64
		for _, uma := range rule.Uma[start:end] {
			awards += uma * 1000
		}
		if start == 0 {
			awards += 4 * (rule.Return - rule.Start)
		}
		size := int64(end - start)
		// Carry the shared award in raw-score units until constructing the rational.
		point := big.NewRat((int64(results[start].Score)-rule.Return)*size+awards, 1000*size)
		value := exactPoint{Numerator: point.Num().String(), Denominator: point.Denom().String()}
		for i := start; i < end; i++ {
			results[i].Rank, results[i].Point = start+1, value
		}
		start = end
	}
}

var matchDatePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,6})?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$`)

func normalizeMatchInput(c *gin.Context, input *matchInput) (time.Time, bool) {
	if !normalizeScores(c, &input.RuleID, input.Players) {
		return time.Time{}, false
	}
	date, err := time.Parse(time.RFC3339, input.Date)
	if err != nil || !matchDatePattern.MatchString(input.Date) || date.Year() < 1 || date.UTC().Year() < 1 {
		invalidQuery(c, "match_date")
		return time.Time{}, false
	}
	input.Date = date.UTC().Format(time.RFC3339Nano)
	if !uuidPattern.MatchString(input.ClientRequestID) {
		invalidQuery(c, "client_request_id")
		return time.Time{}, false
	}
	input.ClientRequestID = strings.ToLower(input.ClientRequestID)
	if input.SeasonID != nil {
		if !uuidPattern.MatchString(*input.SeasonID) {
			invalidQuery(c, "season_id")
			return time.Time{}, false
		}
		*input.SeasonID = strings.ToLower(*input.SeasonID)
	}
	return date, true
}

func (w *LeagueWrite) SaveMatch(c *gin.Context) {
	received := time.Now()
	var input matchInput
	if !httpx.Decode(c, &input) {
		return
	}
	date, ok := normalizeMatchInput(c, &input)
	if !ok {
		return
	}
	hash := requestHash(input)
	w.run(c, false, func(ctx context.Context, tx *sql.Tx, l league, actor string) (int, any) {
		var id, previousHash string
		err := tx.QueryRowContext(ctx, `SELECT id,request_hash FROM public.matches
			WHERE league_id=$1 AND recorded_by=$2 AND client_request_id=$3`, l.ID, actor, input.ClientRequestID).
			Scan(&id, &previousHash)
		if err == nil {
			if previousHash != hash {
				requestConflict(c)
				return 0, nil
			}
			data := readMatch(c, ctx, tx, l.ID, id)
			if data == nil {
				return 0, nil
			}
			return 200, data
		}
		if !errors.Is(err, sql.ErrNoRows) {
			httpx.Unavailable(c)
			return 0, nil
		}

		if date.After(received) {
			httpx.Error(c, 400, "INVALID_INPUT", "未来の対局日時は指定できません", nil)
			return 0, nil
		}
		if input.SeasonID != nil && !matchInSeason(c, ctx, tx, l.ID, *input.SeasonID, date) {
			return 0, nil
		}
		results := calculateMatch(c, ctx, tx, l.ID, input.RuleID, input.Players, true, "")
		if results == nil {
			return 0, nil
		}
		err = tx.QueryRowContext(ctx, `INSERT INTO public.matches
			(league_id,rule_id,season_id,recorded_by,match_date,data_origin,client_request_id,request_hash)
			VALUES ($1,$2,$3,$4,$5,'app',$6,$7) RETURNING id`,
			l.ID, input.RuleID, input.SeasonID, actor, date.UTC(), input.ClientRequestID, hash).Scan(&id)
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		for _, result := range results {
			_, err := tx.ExecContext(ctx, `INSERT INTO public.match_results
				(league_id,match_id,user_id,raw_score,rank,final_point_numerator,final_point_denominator)
				VALUES ($1,$2,$3,$4,$5,$6,$7)`, l.ID, id, result.UserID, result.Score, result.Rank,
				result.Point.Numerator, result.Point.Denominator)
			if err != nil {
				httpx.Unavailable(c)
				return 0, nil
			}
		}
		data := readMatch(c, ctx, tx, l.ID, id)
		if data == nil {
			return 0, nil
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO public.match_revisions
			(league_id,match_id,actor_id,operation,version,client_request_id,request_hash,after)
			VALUES ($1,$2,$3,'create',1,$4,$5,$6)`, l.ID, id, actor, input.ClientRequestID, hash, string(data))
		if err != nil {
			httpx.Unavailable(c)
			return 0, nil
		}
		return 201, data
	})
}

func matchInSeason(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID, seasonID string, date time.Time) bool {
	var inPeriod bool
	err := tx.QueryRowContext(ctx, `SELECT (start_date IS NULL OR day >= start_date)
		AND (end_date IS NULL OR day <= end_date)
		FROM public.seasons CROSS JOIN LATERAL (SELECT ($3::timestamptz AT TIME ZONE 'Asia/Tokyo')::date AS day) d
		WHERE league_id=$1 AND id=$2`, leagueID, seasonID, date.UTC()).Scan(&inPeriod)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		httpx.Error(c, 404, "NOT_FOUND", "このリーグのシーズンが見つかりません", nil)
	case err != nil:
		httpx.Unavailable(c)
	case !inPeriod:
		httpx.Error(c, 400, "INVALID_INPUT", "対局日時がシーズンの期間外です", nil)
	default:
		return true
	}
	return false
}

func readMatch(c *gin.Context, ctx context.Context, tx *sql.Tx, leagueID, id string) json.RawMessage {
	var data json.RawMessage
	err := tx.QueryRowContext(ctx, `SELECT `+matchJSON+` FROM public.matches m
		WHERE m.league_id=$1 AND m.id=$2 AND m.data_origin='app'`, leagueID, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.Error(c, 404, "NOT_FOUND", "対局が見つかりません", nil)
	} else if err != nil {
		httpx.Unavailable(c)
	}
	return data
}

func (lc *LeagueController) MatchDetail() gin.HandlerFunc {
	return lc.scoped(pathLeague, func(c *gin.Context, ctx context.Context, tx *sql.Tx, l league) gin.H {
		id := strings.ToLower(c.Param("match_id"))
		if !uuidPattern.MatchString(id) {
			invalidQuery(c, "match_id")
			return nil
		}
		data := readMatch(c, ctx, tx, l.ID, id)
		if data == nil {
			return nil
		}
		// Use the same Match shape for detail, save, replay, and the history list.
		var match gin.H
		if err := json.Unmarshal(data, &match); err != nil {
			httpx.Unavailable(c)
			return nil
		}
		return match
	})
}
