package controllers

import (
	"database/sql"
	"fmt"
	"math"
	"net/http"
	"sort"

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

	for rankIdx, player := range ranked {
		rank := rankIdx + 1
		basePoint := float64(player.rawScore-30000) / 1000.0
		point := basePoint + umaByRank[rankIdx]
		if rank == 1 {
			point += 20.0
		}

		rankByOriginalIndex[player.index] = rank
		pointByOriginalIndex[player.index] = roundToOneDecimal(point)
	}

	var totalWithoutFirst float64
	firstPlayerOriginalIndex := ranked[0].index
	for i := range players {
		if i == firstPlayerOriginalIndex {
			continue
		}
		totalWithoutFirst += pointByOriginalIndex[i]
	}
	pointByOriginalIndex[firstPlayerOriginalIndex] = roundToOneDecimal(-totalWithoutFirst)

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
	seenRanks := make(map[int]struct{}, len(req.Results))

	for _, result := range req.Results {
		if _, exists := seenPlayerIDs[result.PlayerID]; exists {
			return fmt.Errorf("player_id must be unique")
		}
		seenPlayerIDs[result.PlayerID] = struct{}{}

		if _, exists := seenRanks[result.Rank]; exists {
			return fmt.Errorf("rank must be unique")
		}
		seenRanks[result.Rank] = struct{}{}
	}

	for rank := 1; rank <= 4; rank++ {
		if _, exists := seenRanks[rank]; !exists {
			return fmt.Errorf("ranks must include 1, 2, 3, and 4")
		}
	}

	return nil
}
