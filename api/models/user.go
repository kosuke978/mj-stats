package models

import "time"

type User struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	ProfileCompletedAt *time.Time `json:"profile_completed_at"`
}
