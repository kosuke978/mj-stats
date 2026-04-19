package controllers

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/kosuke/mj-stats-api/models"
)

type MatchController struct {
	DB *sql.DB
}

func NewMatchController(db *sql.DB) *MatchController {
	return &MatchController{DB: db}
}

func (mc *MatchController) Calculate(c *gin.Context) {
	var req models.CalculateMatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := validateUniquePlayerIDsForCalculate(req.Players); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	results := calculateResults(req.Players)
	c.JSON(http.StatusOK, results)
}

func (mc *MatchController) CreateMatch(c *gin.Context) {
	var req models.CreateMatchRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if err := validateCreateMatchRequest(req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	tx, err := mc.DB.BeginTx(c.Request.Context(), nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start transaction"})
		return
	}
	defer tx.Rollback()

	var matchID string
	insertMatchQuery := `
		INSERT INTO matches (rule_id, season_id, created_at)
		VALUES ($1, $2, NOW())
		RETURNING id
	`

	if err := tx.QueryRowContext(c.Request.Context(), insertMatchQuery, req.RuleID, req.SeasonID).Scan(&matchID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":  "failed to insert match",
			"detail": err.Error(),
		})
		return
	}

	insertResultQuery := `
		INSERT INTO match_results (match_id, user_id, raw_score, final_point, rank)
		VALUES ($1, $2, $3, $4, $5)
	`

	for _, result := range req.Results {
		if _, err := tx.ExecContext(c.Request.Context(), insertResultQuery,
			matchID,
			result.PlayerID,
			result.RawScore,
			result.Point,
			result.Rank,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{
				"error":  "failed to insert match result (check if user_id is a valid UUID)",
				"detail": err.Error(),
			})
			return
		}
	}

	if err := tx.Commit(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":  "failed to commit transaction",
			"detail": err.Error(),
		})
		return
	}

	c.JSON(http.StatusCreated, models.CreateMatchResponse{MatchID: matchID})
}

func (mc *MatchController) GetMatches(c *gin.Context) {
	matchDateExpr := "created_at"
	hasMatchDate, err := mc.columnExists(c.Request.Context(), "matches", "match_date")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to inspect matches schema", "detail": err.Error()})
		return
	}
	if hasMatchDate {
		matchDateExpr = "match_date"
	}

	guestNameExpr := "CAST(NULL AS text)"
	if hasGuestName, _ := mc.columnExists(c.Request.Context(), "match_results", "guest_name"); hasGuestName {
		guestNameExpr = "mr.guest_name"
	}

	isYakumanExpr := "CAST(FALSE AS boolean)"
	if hasYakuman, _ := mc.columnExists(c.Request.Context(), "match_results", "is_yakuman"); hasYakuman {
		isYakumanExpr = "mr.is_yakuman"
	}

	isTobiExpr := "CAST(FALSE AS boolean)"
	if hasTobi, _ := mc.columnExists(c.Request.Context(), "match_results", "is_tobi"); hasTobi {
		isTobiExpr = "mr.is_tobi"
	}

	query := `
		WITH ordered_matches AS (
			SELECT id, %s AS match_date, rule_id, created_at
			FROM matches
			ORDER BY match_date DESC, created_at DESC
		)
		SELECT
			om.id,
			om.match_date,
			om.rule_id,
			om.created_at,
			u.name AS user_id,
			%s AS guest_name,
			mr.raw_score,
			mr.final_point,
			%s AS is_yakuman,
			%s AS is_tobi,
			mr.rank
		FROM ordered_matches om
		LEFT JOIN match_results mr ON mr.match_id = om.id
		LEFT JOIN users u ON u.id = mr.user_id
		ORDER BY om.match_date DESC, om.created_at DESC, mr.rank ASC
	`

	query = fmt.Sprintf(query, matchDateExpr, guestNameExpr, isYakumanExpr, isTobiExpr)

	rows, err := mc.DB.QueryContext(c.Request.Context(), query)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to fetch matches", "detail": err.Error()})
		return
	}
	defer rows.Close()

	matchMap := make(map[string]*models.MatchHistory)
	orderedMatches := make([]*models.MatchHistory, 0)

	for rows.Next() {
		var (
			matchID    string
			matchDate  time.Time
			ruleID     string
			createdAt  time.Time
			userID     sql.NullString
			guestName  sql.NullString
			score      sql.NullInt64
			point      sql.NullFloat64
			isYakuman  sql.NullBool
			isTobi     sql.NullBool
			resultRank sql.NullInt64
		)

		if err := rows.Scan(
			&matchID,
			&matchDate,
			&ruleID,
			&createdAt,
			&userID,
			&guestName,
			&score,
			&point,
			&isYakuman,
			&isTobi,
			&resultRank,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to scan match row", "detail": err.Error()})
			return
		}

		match, exists := matchMap[matchID]
		if !exists {
			match = &models.MatchHistory{
				ID:        matchID,
				MatchDate: matchDate,
				RuleID:    ruleID,
				CreatedAt: createdAt,
				Results:   make([]models.MatchHistoryResult, 0, 4),
			}
			matchMap[matchID] = match
			orderedMatches = append(orderedMatches, match)
		}

		if resultRank.Valid {
			var userIDPtr *string
			if userID.Valid {
				userIDValue := userID.String
				userIDPtr = &userIDValue
			}

			var guestNamePtr *string
			if guestName.Valid {
				guestNameValue := guestName.String
				guestNamePtr = &guestNameValue
			}

			result := models.MatchHistoryResult{
				UserID:    userIDPtr,
				GuestName: guestNamePtr,
				Score:     int(score.Int64),
				Point:     point.Float64,
				IsYakuman: isYakuman.Bool,
				IsTobi:    isTobi.Bool,
			}
			match.Results = append(match.Results, result)
		}
	}

	if err := rows.Err(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed while reading match rows", "detail": err.Error()})
		return
	}

	matches := make([]models.MatchHistory, 0, len(orderedMatches))
	for _, match := range orderedMatches {
		matches = append(matches, *match)
	}

	c.JSON(http.StatusOK, models.GetMatchesResponse{Matches: matches})
}

func (mc *MatchController) columnExists(ctx context.Context, tableName, columnName string) (bool, error) {
	query := `
		SELECT EXISTS (
			SELECT 1
			FROM information_schema.columns
			WHERE table_schema = 'public'
				AND table_name = $1
				AND column_name = $2
		)
	`

	var exists bool
	if err := mc.DB.QueryRowContext(ctx, query, strings.ToLower(tableName), strings.ToLower(columnName)).Scan(&exists); err != nil {
		return false, err
	}

	return exists, nil
}

func calculateResults(players []models.CalculatePlayerInput) []models.CalculateResult {
	type rankedPlayer struct {
		index    int
		playerID string
		rawScore int
	}

	ranked := make([]rankedPlayer, len(players))
	for i, player := range players {
		ranked[i] = rankedPlayer{
			index:    i,
			playerID: player.PlayerID,
			rawScore: player.RawScore,
		}
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		return ranked[i].rawScore > ranked[j].rawScore
	})

	umaByRank := []float64{20.0, 10.0, -10.0, -20.0}
	rankByOriginalIndex := make(map[int]int, len(players))
	pointByOriginalIndex := make(map[int]float64, len(players))

	for i := 0; i < len(ranked); {
		j := i
		for j < len(ranked) && ranked[j].rawScore == ranked[i].rawScore {
			j++
		}

		tieCount := j - i
		rank := i + 1

		sumUma := 0.0
		for k := i; k < j; k++ {
			sumUma += umaByRank[k]
		}
		avgUma := sumUma / float64(tieCount)

		topBonus := 0.0
		if i == 0 {
			topBonus = 20.0 / float64(tieCount)
		}

		for k := i; k < j; k++ {
			player := ranked[k]
			basePoint := float64(player.rawScore-30000) / 1000.0
			point := basePoint + avgUma + topBonus

			rankByOriginalIndex[player.index] = rank
			pointByOriginalIndex[player.index] = roundToOneDecimal(point)
		}

		i = j
	}

	var totalPoints float64
	for i := range players {
		totalPoints += pointByOriginalIndex[i]
	}
	if roundToOneDecimal(totalPoints) != 0 {
		firstPlayerOriginalIndex := ranked[0].index
		pointByOriginalIndex[firstPlayerOriginalIndex] = roundToOneDecimal(pointByOriginalIndex[firstPlayerOriginalIndex] - totalPoints)
	}

	results := make([]models.CalculateResult, len(players))
	for i, player := range players {
		results[i] = models.CalculateResult{
			PlayerID: player.PlayerID,
			RawScore: player.RawScore,
			Point:    pointByOriginalIndex[i],
			Rank:     rankByOriginalIndex[i],
		}
	}

	return results
}

func roundToOneDecimal(value float64) float64 {
	return math.Round(value*10) / 10
}

func validateUniquePlayerIDsForCalculate(players []models.CalculatePlayerInput) error {
	seen := make(map[string]struct{}, len(players))
	for _, player := range players {
		if _, exists := seen[player.PlayerID]; exists {
			return fmt.Errorf("player_id must be unique")
		}
		seen[player.PlayerID] = struct{}{}
	}
	return nil
}

func validateCreateMatchRequest(req models.CreateMatchRequest) error {
	seenPlayerIDs := make(map[string]struct{}, len(req.Results))

	for _, result := range req.Results {
		if _, exists := seenPlayerIDs[result.PlayerID]; exists {
			return fmt.Errorf("player_id must be unique")
		}
		seenPlayerIDs[result.PlayerID] = struct{}{}
	}

	return nil
}
