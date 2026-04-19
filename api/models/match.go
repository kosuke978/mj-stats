package models

type CalculatePlayerInput struct {
	PlayerID string `json:"player_id" binding:"required"`
	RawScore int    `json:"raw_score"`
}

type CalculateMatchRequest struct {
	Players []CalculatePlayerInput `json:"players" binding:"required,len=4,dive"`
}

type CalculateResult struct {
	PlayerID string  `json:"player_id"`
	RawScore int     `json:"raw_score"`
	Point    float64 `json:"point"`
	Rank     int     `json:"rank"`
}

type MatchResultInput struct {
	PlayerID  string  `json:"player_id" binding:"required"`
	RawScore  int     `json:"raw_score"`
	Point     float64 `json:"point"`
	Rank      int     `json:"rank" binding:"required,min=1,max=4"`
	IsYakuman bool    `json:"is_yakuman"`
}

type CreateMatchRequest struct {
	RuleID   string             `json:"rule_id" binding:"required,uuid"`
	SeasonID *int               `json:"season_id"`
	Results  []MatchResultInput `json:"results" binding:"required,len=4,dive"`
}

type CreateMatchResponse struct {
	MatchID string `json:"match_id"`
}
