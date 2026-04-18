package models

import "time"

type MatchHistoryResult struct {
	UserID    *string `json:"user_id"`
	GuestName *string `json:"guest_name"`
	Score     int     `json:"score"`
	Point     float64 `json:"point"`
	IsYakuman bool    `json:"is_yakuman"`
	IsTobi    bool    `json:"is_tobi"`
}

type MatchHistory struct {
	ID        string               `json:"id"`
	MatchDate time.Time            `json:"match_date"`
	RuleID    string               `json:"rule_id"`
	CreatedAt time.Time            `json:"created_at"`
	Results   []MatchHistoryResult `json:"results"`
}

type GetMatchesResponse struct {
	Matches []MatchHistory `json:"matches"`
}
